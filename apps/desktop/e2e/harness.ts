import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
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
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string } };

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
}

export async function launch(options: LaunchOptions): Promise<Running> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_OPTIONS') env[k] = v;
  env['UGC_POC_SYNTHETIC'] = '1';
  env['UGC_POC_USER_DATA'] = options.userData;
  env['UGC_POC_SITE_ORIGIN'] = options.site.url('');
  env['UGC_POC_SITE_CERT_FP'] = options.site.certificateFingerprint;
  if (options.allowUnencryptedSynthetic ?? true) env['UGC_POC_ALLOW_UNENCRYPTED_SYNTHETIC'] = '1';

  const app = await electron.launch({
    args: [MAIN],
    env,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.profile');
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
export async function openSite(run: Running, profileId: string, page = 'home'): Promise<{ window: Page; status: string; state: string }> {
  const opened = run.app.waitForEvent('window');
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

/**
 * Copy of the Electron binary with only EnableCookieEncryption flipped on.
 * Other production fuses (e.g. disabling --inspect) would stop Playwright
 * from driving the app, so they are verified separately once packaging exists.
 */
export async function fusedElectron(): Promise<string> {
  const source = dirname(DEFAULT_ELECTRON);
  const target = join(tmpdir(), 'ugc-electron-cookie-encryption');
  const binary = join(target, basename(DEFAULT_ELECTRON));
  if (!existsSync(binary)) {
    cpSync(source, target, { recursive: true });
    await flipFuses(binary, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true });
  }
  return binary;
}
