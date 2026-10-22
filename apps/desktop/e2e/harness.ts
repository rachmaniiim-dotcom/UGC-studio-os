import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cookieEditorExport, type CookieEditorEntry, type SyntheticSite } from '@ugc/test-fixtures';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(desktopDir, 'dist', 'main', 'main.js');
const require = createRequire(import.meta.url);
export const DEFAULT_ELECTRON = require('electron') as unknown as string;

export interface Profile {
  id: string;
  label: string;
  partition: string;
  status: string;
  statusReason: string | null;
  lastImport: null | {
    format: string;
    fileError: string | null;
    examined: number;
    imported: number;
    skipped: number;
    rejected: number;
    reasons: Record<string, number>;
    messages: string[];
    browserLoaded: number;
    browserFailures: Record<string, number>;
  };
  platformId: string;
  sessionSync: {
    revision: number;
    savedCount: number;
    savedAt: string | null;
    saveError: string | null;
    restore: null | { at: string; state: string; count: number; error: string | null };
  };
  bundleId: string | null;
  optional: boolean;
}

export interface ProxyView {
  protocol: string;
  host: string;
  port: number;
  hasCredentials: boolean;
  status: string;
  observedIp: string | null;
  endpoint: string | null;
  testedAt: string | null;
  lastPassedAt: string | null;
  error: string | null;
}

export type AccountSession = Profile & { platform: { id: string; displayName: string; statusCheck: string; automation: string; pages: string[] } };

export interface Account {
  id: string;
  displayName: string;
  mode: string;
  status: string;
  proxy: ProxyView | null;
  sessions: AccountSession[];
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: string[] } };

export interface Running {
  app: ElectronApplication;
  ui: Page;
  /** Every bridge response seen by this run, for leak scanning. */
  responses: unknown[];
}

export function workDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ugc-e2e-${name}-`));
}

export async function writeExport(dir: string, name: string, entries: CookieEditorEntry[] | string): Promise<string> {
  const file = join(dir, `${name}.json`);
  await writeFile(file, typeof entries === 'string' ? entries : cookieEditorExport(entries), { mode: 0o600 });
  return file;
}

export interface LaunchOptions {
  userData: string;
  site: SyntheticSite;
  executablePath?: string;
  allowUnencryptedSynthetic?: boolean;
  env?: Record<string, string>;
  /** false: a non-synthetic run (no site mapping, no test certificate). Default true. */
  synthetic?: boolean;
  /** false: don't seed the two bundle-less test profiles of Gates 1–2. Default true. */
  seedProfiles?: boolean;
}

export async function launch(options: LaunchOptions): Promise<Running> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_OPTIONS') env[k] = v;
  env['UGC_POC_USER_DATA'] = options.userData;
  if (options.synthetic ?? true) {
    env['UGC_POC_SYNTHETIC'] = '1';
    env['UGC_POC_SITE_ORIGIN'] = options.site.url('');
    env['UGC_POC_SITE_CERT_FP'] = options.site.certificateFingerprint;
  }
  if (options.allowUnencryptedSynthetic ?? true) env['UGC_POC_ALLOW_UNENCRYPTED_SYNTHETIC'] = '1';
  if (options.seedProfiles === false) env['UGC_POC_SEED_PROFILES'] = '0';
  Object.assign(env, options.env ?? {});

  const app = await electron.launch({
    args: [MAIN],
    env,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('[data-app-ready]');
  return { app, ui, responses: [] };
}

export async function call<T>(run: Running, method: string, ...args: unknown[]): Promise<Result<T>> {
  const result = await run.ui.evaluate(
    ([m, a]) => (window as unknown as Record<string, Record<string, (...x: unknown[]) => Promise<unknown>>>)['ugc']![m as string]!(...(a as unknown[])),
    [method, args] as const,
  );
  run.responses.push(result);
  return result as Result<T>;
}

export async function ok<T>(run: Running, method: string, ...args: unknown[]): Promise<T> {
  const result = await call<T>(run, method, ...args);
  if (!result.ok) throw new Error(`${method} failed: ${result.error.code}`);
  return result.data;
}

export async function profiles(run: Running): Promise<Profile[]> {
  return ok<Profile[]>(run, 'listProfiles');
}

export async function accounts(run: Running): Promise<Account[]> {
  return ok<Account[]>(run, 'listAccounts');
}

export async function createAccount(run: Running, displayName: string, mode = 'affiliate_ugc'): Promise<Account> {
  return ok<Account>(run, 'createAccount', displayName, mode);
}

/** The account's session for `platformId` (e.g. 'tiktok'). */
export function sessionOf(account: Account, platformId: string): AccountSession {
  const s = account.sessions.find((x) => x.platformId === platformId);
  if (!s) throw new Error(`no ${platformId} session`);
  return s;
}

/** A synthetic Cookie-Editor entry scoped to a platform's synthetic stand-in host (e.g. tiktok.ugc-poc.test). */
export const syntheticHost = (platformId: string): string => `${platformId}.ugc-poc.test`;

/** Makes the next native file dialog return `file` (the main process still reads it). */
export async function stubOpenDialog(run: Running, file: string): Promise<void> {
  await run.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog;
  }, file);
}

export async function importFile(run: Running, profileId: string, file: string): Promise<Profile> {
  await stubOpenDialog(run, file);
  const outcome = await ok<{ canceled: boolean; profile: Profile }>(run, 'importCookies', profileId);
  expect(outcome.canceled).toBe(false);
  return outcome.profile;
}

/** Opens a site page in the profile's isolated window and returns the text the page shows. */
/**
 * Resolves with the next site window. Skips the hidden Test Proxy windows,
 * which Open Site creates first when a proxy still needs validating.
 */
export function nextSiteWindow(run: Running): Promise<Page> {
  return run.app.waitForEvent('window', {
    predicate: async (page) => {
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      if (page.isClosed()) return false;
      try {
        return !/^\/ip(-backup)?$/.test(new URL(page.url()).pathname);
      } catch {
        return false;
      }
    },
  });
}

export async function openSite(run: Running, profileId: string, page = 'home'): Promise<{ window: Page; status: string; state: string }> {
  const opened = nextSiteWindow(run);
  await ok(run, 'openSite', profileId, page);
  const window = await opened;
  const status = window.locator('#status:not([data-state="loading"])');
  await status.waitFor();
  return { window, status: (await status.textContent()) ?? '', state: (await status.getAttribute('data-state')) ?? '' };
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite: string;
  expirationDate?: number;
}

/** Reads a partition's cookie jar from the main process (test-only, synthetic values). */
export async function partitionCookies(run: Running, partition: string): Promise<BrowserCookie[]> {
  return run.app.evaluate(async ({ session }, p) => {
    const cookies = await session.fromPartition(p).cookies.get({});
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? '',
      hostOnly: c.hostOnly ?? false,
      path: c.path ?? '',
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      session: c.session ?? false,
      sameSite: c.sameSite,
      ...(c.expirationDate === undefined ? {} : { expirationDate: c.expirationDate }),
    }));
  }, partition);
}

export async function quit(run: Running): Promise<void> {
  await run.app.close();
}

/**
 * Simulates a crash: kills the app's whole process tree at once (no
 * before-quit, no flush). Killing only the main process would leave
 * Chromium's child processes holding the profile for a moment.
 */
export async function crash(run: Running): Promise<void> {
  const proc = run.app.process();
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolve()));
  } else {
    proc.kill('SIGKILL');
  }
  await exited;
  // Children notice the parent is gone; give Windows a moment to release their handles.
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Waits until Chromium has written its encryption key to "Local State" (about
 * 10 s after a brand-new profile's first launch). The app refuses real imports
 * before that (protected_key_not_ready); crash tests wait for it too.
 */
export async function waitForProtectedKey(userData: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: string } };
      if (state.os_crypt?.encrypted_key) return;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error('encryption key not persisted');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Waits until the profile's saved snapshot revision reaches `revision`; returns the profile. */
export async function waitForRevision(run: Running, profileId: string, revision: number): Promise<Profile> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const p = (await profiles(run)).find((x) => x.id === profileId);
    if (p && p.sessionSync.revision >= revision) return p;
    if (Date.now() > deadline) throw new Error(`revision ${revision} not reached (at ${p?.sessionSync.revision})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface SecurityCheckRun {
  code: number | null;
  /** Everything the command printed (stdout + stderr), for leak assertions. */
  output: string;
  report: {
    result: string;
    error?: string;
    summary: { findings: number; high: number };
    environment: Record<string, unknown>;
    profiles: Array<{ label: string; jarCookies: number; needles: number; snapshot: string; cookieDb: null | { rows: number; plaintextRows: number; prefixes: Record<string, number> } }>;
    scan: { files: number };
    findings: Array<{ check: string; severity: string; count: number; where?: string; matched?: string[] }>;
    accounts: Array<{ label: string; proxyCredentials: number }>;
  };
}

/** Runs the C4 security-check command (the same script as `pnpm security-check`) with --json. */
export function securityCheck(options: { userData: string; scan?: string[]; executablePath?: string }): Promise<SecurityCheckRun> {
  const script = join(desktopDir, 'scripts', 'security-check.mjs');
  const args = [script, '--json', '--user-data', options.userData, ...(options.scan ?? []).flatMap((d) => ['--scan', d])];
  if (options.executablePath) args.push('--electron', options.executablePath);
  return new Promise((resolve) => {
    execFile(process.execPath, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      const json = stdout.slice(stdout.indexOf('{'));
      resolve({ code: typeof code === 'number' ? code : 1, output: stdout + stderr, report: JSON.parse(json) });
    });
  });
}

/** Finds Chromium's cookie database for a partition under userData. */
export function cookieDatabase(userData: string, partition: string): string {
  const name = partition.replace(/^persist:/, '');
  const base = join(userData, 'Partitions', name);
  for (const candidate of [join(base, 'Cookies'), join(base, 'Network', 'Cookies')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no Cookies database under ${base}`);
}

/** Returns every file under `dir` whose bytes contain `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && readFileSync(full).includes(needle)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

const ELECTRON_VERSION = (require('electron/package.json') as { version: string }).version;

/**
 * Copy of the Electron binary with EnableCookieEncryption explicitly set to
 * `enabled`, so tests don't depend on the state of the development binary in
 * node_modules (which enable-dev-fuses.mjs flips). The fuse is re-checked on
 * every call. Other production fuses (e.g. disabling --inspect) would stop
 * Playwright from driving the app, so they are verified separately once
 * packaging exists.
 */
export async function electronWithCookieEncryption(enabled: boolean): Promise<string> {
  const target = join(tmpdir(), `ugc-electron-${ELECTRON_VERSION}-cookie-encryption-${enabled ? 'on' : 'off'}`);
  const binary = join(target, basename(DEFAULT_ELECTRON));
  if (!existsSync(binary)) cpSync(dirname(DEFAULT_ELECTRON), target, { recursive: true });
  const wanted = enabled ? FuseState.ENABLE : FuseState.DISABLE;
  if ((await getCurrentFuseWire(binary))[FuseV1Options.EnableCookieEncryption] !== wanted) {
    await flipFuses(binary, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: enabled });
  }
  return binary;
}

export const fusedElectron = (): Promise<string> => electronWithCookieEncryption(true);
export const unfusedElectron = (): Promise<string> => electronWithCookieEncryption(false);
