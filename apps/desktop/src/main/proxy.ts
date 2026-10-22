import { app, BrowserWindow, safeStorage, session, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { challengeMatches, chromiumProxyRules, validateProxyInput, type Logger, type ProxyEndpoint } from '@ugc/core';
import type { RuntimeConfig } from './config.js';
import { PROFILE_ID, type AccountBundle, type BundleStore, type PocProfile, type ProfileStore, type ProxyState } from './profiles.js';
import { protectedStorageAvailable, writeAtomic } from './session-sync.js';

/**
 * Dedicated proxy per Account Bundle (Gate 3).
 *
 * - Every platform-session partition of a bundle uses the bundle's proxy:
 *   `fixed_servers`, no direct fallback, applied at startup and on every
 *   change before any window, probe or request.
 * - A bundle without a proxy has its partitions pinned to a closed local port
 *   (BLACKHOLE), so even an unexpected request fails instead of going direct.
 * - Credentials are sealed with safeStorage (DPAPI on Windows) and only
 *   decrypted to answer a proxy challenge: for the bundle that owns the
 *   requesting window's session, and only if the challenge comes from that
 *   bundle's proxy host and port. Site authentication (401) is never answered.
 * - A bundle can browse only after its proxy passed Test Proxy in this run;
 *   after a restart or a change it must pass again. Requests from an open
 *   window fail (never go direct) if the proxy goes down.
 * - Test Proxy loads a reviewed IP-diagnostic endpoint (primary, then backup)
 *   in a hidden window on a throwaway in-memory partition with the same proxy.
 *   A window is required: main-process requests can't authenticate to a proxy
 *   in Electron 44 (S1, R-27).
 */

export interface DiagnosticEndpoint {
  readonly id: 'primary' | 'backup';
  readonly url: string;
  readonly format: 'json-ip' | 'text-ip';
}

/**
 * Reviewed public IP-echo endpoints (owner decision Q5), used only for proxy
 * diagnostics. Each returns nothing but the caller's IP. They see the proxy's
 * IP, never platform cookies (the test partition has none).
 */
export const PUBLIC_DIAGNOSTIC_ENDPOINTS: readonly DiagnosticEndpoint[] = [
  { id: 'primary', url: 'https://api.ipify.org/?format=json', format: 'json-ip' },
  { id: 'backup', url: 'https://checkip.amazonaws.com/', format: 'text-ip' },
];

export function syntheticDiagnosticEndpoints(origin: string): readonly DiagnosticEndpoint[] {
  return [
    { id: 'primary', url: `${origin}/ip`, format: 'json-ip' },
    { id: 'backup', url: `${origin}/ip-backup`, format: 'text-ip' },
  ];
}

/** Closed local port: where a bundle's traffic goes while it has no usable proxy (fails, never direct). */
const BLACKHOLE: Electron.ProxyConfig = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' };

export class ProxyError extends Error {
  constructor(
    readonly code: string,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface ProxyInput {
  readonly protocol: unknown;
  readonly host: unknown;
  readonly port: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}

const CREDENTIALS_VERSION = 2;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_AUTH_ATTEMPTS = 2;
/** Failures of the proxy itself: trying the backup endpoint would not help. */
const PROXY_LEVEL = new Set(['proxy_unreachable', 'proxy_auth_failed', 'proxy_tls_failed']);

const CHROMIUM_ERRORS: Record<string, string> = {
  ERR_PROXY_CONNECTION_FAILED: 'proxy_unreachable',
  ERR_NAME_NOT_RESOLVED: 'proxy_unreachable',
  ERR_NAME_RESOLUTION_FAILED: 'proxy_unreachable',
  ERR_PROXY_AUTH_UNSUPPORTED: 'proxy_auth_failed',
  ERR_PROXY_AUTH_REQUESTED: 'proxy_auth_failed',
  ERR_UNEXPECTED_PROXY_AUTH: 'proxy_auth_failed',
  ERR_PROXY_CERTIFICATE_INVALID: 'proxy_tls_failed',
  ERR_TUNNEL_CONNECTION_FAILED: 'proxy_tunnel_failed',
  ERR_TIMED_OUT: 'timeout',
  ERR_CONNECTION_TIMED_OUT: 'timeout',
};

function sanitizeLoadError(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return 'network_error';
  if (code in CHROMIUM_ERRORS) return CHROMIUM_ERRORS[code]!;
  return code.startsWith('ERR_CERT_') ? 'endpoint_tls_failed' : 'network_error';
}

const endpointOf = (state: ProxyState): ProxyEndpoint => ({ protocol: state.protocol, host: state.host, port: state.port });

function credentialsPath(dir: string, bundleId: string): string {
  if (!PROFILE_ID.test(bundleId)) throw new Error('invalid bundle id');
  return join(dir, `${bundleId}.proxy`);
}

/** Decrypts a bundle's proxy credentials. Returns null if there are none or they don't verify. */
export function readProxyCredentials(dir: string, bundle: AccountBundle): { username: string; password: string } | null {
  let sealed: Buffer;
  try {
    sealed = readFileSync(credentialsPath(dir, bundle.id));
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(safeStorage.decryptString(sealed)) as Record<string, unknown>;
    if (
      record['version'] !== CREDENTIALS_VERSION ||
      record['kind'] !== 'proxy-credentials' ||
      record['bundleId'] !== bundle.id ||
      typeof record['username'] !== 'string' ||
      typeof record['password'] !== 'string'
    ) {
      return null;
    }
    return { username: record['username'], password: record['password'] };
  } catch {
    return null;
  }
}

export interface ProxyServiceDeps {
  readonly dir: string;
  readonly bundles: BundleStore;
  readonly sessions: ProfileStore;
  readonly config: RuntimeConfig;
  readonly log: Logger;
  readonly sessionOf: (profile: PocProfile) => Session;
  /** Restrictions for the throwaway test partition (no permissions; synthetic certificate trust in tests). */
  readonly hardenTestSession: (ses: Session) => void;
  readonly endpoints: readonly DiagnosticEndpoint[];
}

export class ProxyService {
  readonly #deps: ProxyServiceDeps;
  /** Which bundle a session belongs to: its platform partitions and its throwaway test sessions. */
  readonly #owners = new Map<Session, string>();
  readonly #authAttempts = new Map<number, number>();
  readonly #authGaveUp = new Set<number>();

  constructor(deps: ProxyServiceDeps) {
    this.#deps = deps;
    app.on('login', this.#onLogin);
  }

  /** At startup, before anything else touches a partition: apply every bundle's proxy (or the blackhole). */
  async start(): Promise<void> {
    for (const bundle of this.#deps.bundles.list()) {
      if (bundle.proxy) {
        // Must pass Test Proxy again in this run; when it last passed is kept.
        this.#deps.bundles.update(bundle.id, { proxy: { ...bundle.proxy, status: 'untested', observedIp: null, endpoint: null, error: null } });
      }
      for (const profile of this.#deps.sessions.forBundle(bundle.id)) await this.attachSession(profile);
    }
  }

  /** Puts a bundle session's partition behind its bundle's proxy (or the blackhole). Call before the partition is used. */
  async attachSession(profile: PocProfile): Promise<void> {
    if (!profile.bundleId) return;
    const bundle = this.#deps.bundles.get(profile.bundleId);
    const ses = this.#deps.sessionOf(profile);
    this.#owners.set(ses, profile.bundleId);
    await ses.setProxy(bundle?.proxy ? { mode: 'fixed_servers', proxyRules: chromiumProxyRules(endpointOf(bundle.proxy)) } : BLACKHOLE);
  }

  /**
   * Sets or replaces a bundle's proxy. With `keepCredentials` and no new
   * password, the saved credentials are kept (re-sealed, never returned).
   * The new proxy must pass Test Proxy before the bundle can browse.
   */
  async configure(bundle: AccountBundle, input: ProxyInput, keepCredentials: boolean): Promise<AccountBundle> {
    const { dir, bundles, sessions, log } = this.#deps;
    const noNewPassword = input.password === undefined || input.password === null || input.password === '';
    let raw = input;
    if (keepCredentials && noNewPassword) {
      const saved = bundle.proxy?.hasCredentials ? readProxyCredentials(dir, bundle) : null;
      if (!saved) throw new ProxyError('credentials_missing');
      const username = input.username === undefined || input.username === '' ? saved.username : input.username;
      raw = { ...input, username, password: saved.password };
    }
    const validated = validateProxyInput(raw);
    if (!validated.ok) throw new ProxyError('invalid_proxy', validated.issues);
    const { endpoint, credentials } = validated.settings;
    if (credentials) {
      if (!protectedStorageAvailable()) throw new ProxyError('protected_storage_unavailable');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = JSON.stringify({
        version: CREDENTIALS_VERSION,
        kind: 'proxy-credentials',
        bundleId: bundle.id,
        username: credentials.username.reveal(),
        password: credentials.password.reveal(),
      });
      writeAtomic(credentialsPath(dir, bundle.id), safeStorage.encryptString(record));
    } else {
      rmSync(credentialsPath(dir, bundle.id), { force: true });
    }

    const rules = { mode: 'fixed_servers' as const, proxyRules: chromiumProxyRules(endpoint) };
    for (const profile of sessions.forBundle(bundle.id)) {
      const ses = this.#deps.sessionOf(profile);
      this.#owners.set(ses, bundle.id);
      // Windows opened with the previous proxy must not keep browsing untested.
      for (const win of BrowserWindow.getAllWindows()) if (win.webContents.session === ses) win.destroy();
      await ses.setProxy(rules);
      await ses.closeAllConnections();
      await ses.clearAuthCache();
    }
    log.info('proxy_configured', { bundleId: bundle.id, protocol: endpoint.protocol, hasCredentials: credentials !== null });
    return bundles.update(bundle.id, {
      proxy: {
        protocol: endpoint.protocol,
        host: endpoint.host,
        port: endpoint.port,
        hasCredentials: credentials !== null,
        status: 'untested',
        observedIp: null,
        endpoint: null,
        testedAt: null,
        lastPassedAt: null,
        error: null,
      },
    });
  }

  /**
   * Throws unless the session may reach the network: a bundle session needs
   * its bundle's proxy to have passed (tested now if needed). Bundle-less
   * test profiles of earlier gates may go direct in synthetic runs only.
   */
  async ensureReady(profile: PocProfile): Promise<void> {
    if (!profile.bundleId) {
      if (this.#deps.config.synthetic) return;
      throw new ProxyError('proxy_not_configured');
    }
    const bundle = this.#deps.bundles.get(profile.bundleId);
    if (!bundle?.proxy) throw new ProxyError('proxy_not_configured');
    if (bundle.proxy.status === 'ok') return;
    const tested = await this.test(bundle);
    if (tested.proxy?.status !== 'ok') throw new ProxyError('proxy_not_ready');
  }

  /** Test Proxy: observed public IP through the bundle's proxy, or a sanitized error code. */
  async test(bundle: AccountBundle): Promise<AccountBundle> {
    const { bundles, log, endpoints } = this.#deps;
    if (!bundle.proxy) throw new ProxyError('proxy_not_configured');
    const temp = session.fromPartition(`ugc-proxytest-${randomUUID()}`);
    this.#deps.hardenTestSession(temp);
    this.#owners.set(temp, bundle.id);
    let result: { observedIp: string; endpoint: 'primary' | 'backup' } | null = null;
    let error = 'no_endpoint';
    try {
      await temp.setProxy({ mode: 'fixed_servers', proxyRules: chromiumProxyRules(endpointOf(bundle.proxy)) });
      for (const endpoint of endpoints) {
        const outcome = await this.#probe(temp, endpoint);
        if ('ip' in outcome) {
          result = { observedIp: outcome.ip, endpoint: endpoint.id };
          break;
        }
        error = outcome.error;
        if (PROXY_LEVEL.has(error)) break;
      }
    } finally {
      this.#owners.delete(temp);
      // Don't leave an idle keep-alive tunnel to the proxy behind.
      await temp.closeAllConnections().catch(() => undefined);
      await temp.clearStorageData().catch(() => undefined);
    }
    const now = new Date().toISOString();
    const proxy: ProxyState = {
      ...bundle.proxy,
      status: result ? 'ok' : 'failed',
      observedIp: result?.observedIp ?? null,
      endpoint: result?.endpoint ?? null,
      testedAt: now,
      lastPassedAt: result ? now : bundle.proxy.lastPassedAt,
      error: result ? null : error,
    };
    // The proxy host and observed IP link accounts: they are kept out of logs.
    log.info('proxy_tested', { bundleId: bundle.id, status: proxy.status, endpoint: proxy.endpoint, error: proxy.error });
    return bundles.update(bundle.id, { proxy });
  }

  /** Called for every site window: resets the proxy-auth retry budget after a successful load. */
  watchWindow(contents: WebContents): void {
    contents.on('did-finish-load', () => this.#authAttempts.delete(contents.id));
    contents.once('destroyed', () => {
      this.#authAttempts.delete(contents.id);
      this.#authGaveUp.delete(contents.id);
    });
  }

  async #probe(temp: Session, endpoint: DiagnosticEndpoint): Promise<{ ip: string } | { error: string }> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: temp, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false },
    });
    const contents = win.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const target = new URL(endpoint.url);
    const stay = (event: { preventDefault(): void; url: string }): void => {
      if (new URL(event.url).origin !== target.origin) event.preventDefault();
    };
    contents.on('will-navigate', stay);
    contents.on('will-redirect', stay);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.watchWindow(contents);
    let status = 0;
    contents.on('did-navigate', (_event, _url, httpResponseCode) => (status = httpResponseCode));
    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          contents.loadURL(endpoint.url),
          new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ERR_TIMED_OUT' })), PROBE_TIMEOUT_MS))),
        ]);
      } catch (err) {
        return { error: this.#authGaveUp.has(contents.id) ? 'proxy_auth_failed' : sanitizeLoadError(err) };
      } finally {
        clearTimeout(timer);
      }
      if (this.#authGaveUp.has(contents.id) || status === 407) return { error: 'proxy_auth_failed' };
      if (status !== 200) return { error: 'endpoint_http_error' };
      const text = String(await contents.executeJavaScript('document.body ? document.body.innerText : ""')).trim();
      let ip = text;
      if (endpoint.format === 'json-ip') {
        try {
          ip = String((JSON.parse(text) as { ip?: unknown }).ip ?? '');
        } catch {
          return { error: 'endpoint_bad_response' };
        }
      }
      // Synthetic site only: it reports 'direct' for a connection that bypassed every proxy.
      if (ip === 'direct') return { error: 'proxy_bypassed' };
      return isIP(ip) ? { ip } : { error: 'endpoint_bad_response' };
    } finally {
      win.destroy();
    }
  }

  readonly #onLogin = (
    event: Electron.Event,
    contents: WebContents | null,
    _details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void => {
    // Site (401) challenges get Electron's default: cancelled. Proxy credentials are never offered to a site.
    if (!authInfo.isProxy) return;
    event.preventDefault();
    // Requests without a webContents (main-process net/fetch) can't be tied to one bundle: refused.
    const bundleId = contents ? this.#owners.get(contents.session) : undefined;
    const bundle = bundleId ? this.#deps.bundles.get(bundleId) : undefined;
    if (!contents || !bundle?.proxy?.hasCredentials || !challengeMatches(endpointOf(bundle.proxy), authInfo)) {
      this.#deps.log.warn('proxy_auth_refused', { bundleId: bundleId ?? null, reason: contents ? 'no_matching_proxy' : 'no_webcontents' });
      callback();
      return;
    }
    const attempts = (this.#authAttempts.get(contents.id) ?? 0) + 1;
    this.#authAttempts.set(contents.id, attempts);
    if (attempts > MAX_AUTH_ATTEMPTS) {
      this.#authGaveUp.add(contents.id);
      this.#deps.log.warn('proxy_auth_failed', { bundleId: bundle.id, attempts: attempts - 1 });
      callback();
      return;
    }
    const credentials = readProxyCredentials(this.#deps.dir, bundle);
    if (!credentials) {
      this.#deps.log.warn('proxy_auth_refused', { bundleId: bundle.id, reason: 'credentials_unavailable' });
      callback();
      return;
    }
    callback(credentials.username, credentials.password);
  };
}
