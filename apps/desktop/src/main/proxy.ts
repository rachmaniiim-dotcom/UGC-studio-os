import { app, BrowserWindow, safeStorage, session, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { challengeMatches, chromiumProxyRules, validateProxyInput, type Logger, type PlatformDefinition, type ProxyEndpoint } from '@ugc/core';
import type { RuntimeConfig } from './config.js';
import { PROFILE_ID, type PocProfile, type ProfileStore, type ProxyState } from './profiles.js';
import { protectedStorageAvailable, writeAtomic } from './session-sync.js';

/**
 * Dedicated proxy per profile/bundle (Gate 3 proxy-isolation PoC).
 *
 * - Every partition of a profile uses its proxy: `fixed_servers`, no direct
 *   fallback, applied before any window, probe or request.
 * - Credentials are sealed with safeStorage (DPAPI on Windows) and only
 *   decrypted to answer a proxy challenge: for the profile that owns the
 *   requesting session, and only if the challenge comes from that profile's
 *   proxy host and port. Site authentication (401) is never answered.
 * - A configured proxy must pass Test Proxy before the profile can browse;
 *   after a restart or a change it must pass again. If it fails, browsing is
 *   blocked, and an open window's requests fail rather than go direct.
 * - Test Proxy loads a reviewed IP-diagnostic endpoint (primary, then backup)
 *   in a hidden window on a throwaway in-memory partition with the same proxy.
 */

export interface DiagnosticEndpoint {
  readonly id: 'primary' | 'backup';
  readonly url: string;
  readonly format: 'json-ip' | 'text-ip';
}

/**
 * Reviewed public IP-echo endpoints (owner decision Q5): used only for proxy
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

const CREDENTIALS_VERSION = 1;
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

function credentialsPath(dir: string, profileId: string): string {
  if (!PROFILE_ID.test(profileId)) throw new Error('invalid profile id');
  return join(dir, `${profileId}.proxy`);
}

/** Decrypts a profile's proxy credentials. Returns null if there are none or they don't verify. */
export function readProxyCredentials(dir: string, profile: PocProfile): { username: string; password: string } | null {
  let sealed: Buffer;
  try {
    sealed = readFileSync(credentialsPath(dir, profile.id));
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(safeStorage.decryptString(sealed)) as Record<string, unknown>;
    if (
      record['version'] !== CREDENTIALS_VERSION ||
      record['kind'] !== 'proxy-credentials' ||
      record['profileId'] !== profile.id ||
      record['partition'] !== profile.partition ||
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
  readonly store: ProfileStore;
  readonly config: RuntimeConfig;
  readonly platform: PlatformDefinition;
  readonly log: Logger;
  readonly sessionOf: (profile: PocProfile) => Session;
  /** Restrictions for the throwaway test partition (no permissions; synthetic certificate trust in tests). */
  readonly hardenTestSession: (ses: Session) => void;
  readonly endpoints: readonly DiagnosticEndpoint[];
}

export class ProxyService {
  readonly #deps: ProxyServiceDeps;
  /** Which profile a session belongs to: its partitions and its throwaway test sessions. */
  readonly #owners = new Map<Session, string>();
  readonly #authAttempts = new Map<number, number>();
  readonly #authGaveUp = new Set<number>();

  constructor(deps: ProxyServiceDeps) {
    this.#deps = deps;
    app.on('login', this.#onLogin);
  }

  /** A proxy is required for real platforms always, and in synthetic mode once one is configured. */
  required(profile: PocProfile): boolean {
    return profile.proxy !== null || !this.#deps.config.synthetic;
  }

  /** At startup, before anything else touches a partition: apply each configured proxy; each must be re-tested. */
  async start(): Promise<void> {
    for (const profile of this.#deps.store.list().filter((p) => p.platformId === this.#deps.platform.id)) {
      const ses = this.#deps.sessionOf(profile);
      this.#owners.set(ses, profile.id);
      if (!profile.proxy) continue;
      await this.#apply(ses, endpointOf(profile.proxy));
      this.#deps.store.update(profile.id, { proxy: { ...profile.proxy, status: 'untested', observedIp: null, endpoint: null, error: null } });
    }
  }

  /** Sets, replaces or (synthetic only) removes a profile's proxy. The new proxy must be tested before browsing. */
  async configure(profile: PocProfile, input: ProxyInput | null): Promise<PocProfile> {
    const { dir, store, log, config } = this.#deps;
    const ses = this.#deps.sessionOf(profile);
    this.#owners.set(ses, profile.id);
    if (input === null) {
      if (!config.synthetic) throw new ProxyError('proxy_required');
      rmSync(credentialsPath(dir, profile.id), { force: true });
      await this.#reset(ses, { mode: 'direct' });
      log.info('proxy_removed', { profileId: profile.id });
      return store.update(profile.id, { proxy: null });
    }

    const validated = validateProxyInput(input);
    if (!validated.ok) throw new ProxyError('invalid_proxy', validated.issues);
    const { endpoint, credentials } = validated.settings;
    if (credentials) {
      if (!protectedStorageAvailable()) throw new ProxyError('protected_storage_unavailable');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = JSON.stringify({
        version: CREDENTIALS_VERSION,
        kind: 'proxy-credentials',
        profileId: profile.id,
        partition: profile.partition,
        username: credentials.username.reveal(),
        password: credentials.password.reveal(),
      });
      writeAtomic(credentialsPath(dir, profile.id), safeStorage.encryptString(record));
    } else {
      rmSync(credentialsPath(dir, profile.id), { force: true });
    }
    // Close the profile's open windows: they were opened with the previous proxy and must not keep browsing untested.
    for (const win of BrowserWindow.getAllWindows()) if (win.webContents.session === ses) win.destroy();
    await this.#reset(ses, { mode: 'fixed_servers', proxyRules: chromiumProxyRules(endpoint) });
    log.info('proxy_configured', { profileId: profile.id, protocol: endpoint.protocol, hasCredentials: credentials !== null });
    return store.update(profile.id, {
      proxy: {
        protocol: endpoint.protocol,
        host: endpoint.host,
        port: endpoint.port,
        hasCredentials: credentials !== null,
        status: 'untested',
        observedIp: null,
        endpoint: null,
        testedAt: null,
        error: null,
      },
    });
  }

  /** Throws unless the profile may browse: no proxy needed, or its proxy passed a test (testing it now if needed). */
  async ensureReady(profile: PocProfile): Promise<void> {
    if (!this.required(profile)) return;
    if (!profile.proxy) throw new ProxyError('proxy_not_configured');
    if (profile.proxy.status === 'ok') return;
    const tested = await this.test(profile);
    if (tested.proxy?.status !== 'ok') throw new ProxyError('proxy_not_ready');
  }

  /** Test Proxy: observed public IP through the profile's proxy, or a sanitized error code. */
  async test(profile: PocProfile): Promise<PocProfile> {
    const { store, log, endpoints } = this.#deps;
    if (!profile.proxy) throw new ProxyError('proxy_not_configured');
    const temp = session.fromPartition(`ugc-proxytest-${randomUUID()}`);
    this.#deps.hardenTestSession(temp);
    this.#owners.set(temp, profile.id);
    let result: { observedIp: string; endpoint: 'primary' | 'backup' } | null = null;
    let error = 'no_endpoint';
    try {
      await this.#apply(temp, endpointOf(profile.proxy));
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
    const current = store.get(profile.id) ?? profile;
    const proxy: ProxyState = {
      ...profile.proxy,
      status: result ? 'ok' : 'failed',
      observedIp: result?.observedIp ?? null,
      endpoint: result?.endpoint ?? null,
      testedAt: new Date().toISOString(),
      error: result ? null : error,
    };
    // The proxy host and observed IP link accounts: they are kept out of logs.
    log.info('proxy_tested', { profileId: profile.id, status: proxy.status, endpoint: proxy.endpoint, error: proxy.error });
    return store.update(current.id, { proxy });
  }

  /** Called for every site window: resets the proxy-auth retry budget after a successful load. */
  watchWindow(contents: WebContents): void {
    contents.on('did-finish-load', () => this.#authAttempts.delete(contents.id));
    contents.once('destroyed', () => {
      this.#authAttempts.delete(contents.id);
      this.#authGaveUp.delete(contents.id);
    });
  }

  async #apply(ses: Session, endpoint: ProxyEndpoint): Promise<void> {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: chromiumProxyRules(endpoint) });
  }

  async #reset(ses: Session, proxy: Electron.ProxyConfig): Promise<void> {
    await ses.setProxy(proxy);
    await ses.closeAllConnections();
    await ses.clearAuthCache();
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
      if (this.#authGaveUp.has(contents.id)) return { error: 'proxy_auth_failed' };
      if (status === 407) return { error: 'proxy_auth_failed' };
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
    // Requests without a webContents (main-process net/fetch) can't be tied to one profile: refused.
    const profileId = contents ? this.#owners.get(contents.session) : undefined;
    const profile = profileId ? this.#deps.store.get(profileId) : undefined;
    if (!contents || !profile?.proxy?.hasCredentials || !challengeMatches(endpointOf(profile.proxy), authInfo)) {
      this.#deps.log.warn('proxy_auth_refused', { profileId: profileId ?? null, reason: contents ? 'no_matching_proxy' : 'no_webcontents' });
      callback();
      return;
    }
    const attempts = (this.#authAttempts.get(contents.id) ?? 0) + 1;
    this.#authAttempts.set(contents.id, attempts);
    if (attempts > MAX_AUTH_ATTEMPTS) {
      this.#authGaveUp.add(contents.id);
      this.#deps.log.warn('proxy_auth_failed', { profileId: profile.id, attempts: attempts - 1 });
      callback();
      return;
    }
    const credentials = readProxyCredentials(this.#deps.dir, profile);
    if (!credentials) {
      this.#deps.log.warn('proxy_auth_refused', { profileId: profile.id, reason: 'credentials_unavailable' });
      callback();
      return;
    }
    callback(credentials.username, credentials.password);
  };
}
