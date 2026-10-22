import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CANARY_MARKER, cookieEditorEntry, startSyntheticSite, syntheticToken, type SyntheticSite } from '@ugc/test-fixtures';
import {
  call,
  cookieDatabase,
  filesContaining,
  fusedElectron,
  importFile,
  launch,
  ok,
  openSite,
  profiles,
  quit,
  stubOpenDialog,
  unfusedElectron,
  workDir,
  writeExport,
  type Profile,
} from './harness.js';

let site: SyntheticSite;
test.beforeAll(async () => {
  site = await startSyntheticSite();
});
test.afterAll(async () => {
  await site.close();
});

test('the app UI gets only a frozen, narrow bridge and its CSP blocks injected scripts', async () => {
  const run = await launch({ userData: await workDir('bridge'), site });
  try {
    const surface = await run.ui.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { ugc: object };
      const script = document.createElement('script');
      script.textContent = 'window.__injected = true';
      document.body.append(script);
      return {
        require: typeof w['require'],
        process: typeof w['process'],
        ipcRenderer: typeof w['ipcRenderer'],
        frozen: Object.isFrozen(w.ugc),
        methods: Object.keys(w.ugc).sort(),
        injected: w['__injected'] ?? null,
      };
    });
    expect(surface).toEqual({
      require: 'undefined',
      process: 'undefined',
      ipcRenderer: 'undefined',
      frozen: true,
      methods: [
        'addReference',
        'addReferenceCreator',
        'checkStatus',
        'clearProfile',
        'confirmStatus',
        'createAccount',
        'getPlatform',
        'growthView',
        'importCookies',
        'importReferencesCsvFile',
        'importReferencesCsvText',
        'importSessionText',
        'listAccounts',
        'listGenerations',
        'listProfiles',
        'openSite',
        'removeReference',
        'removeReferenceCreator',
        'revealVideo',
        'saveCreative',
        'saveGrowthStrategy',
        'setAccountProxy',
        'startGeneration',
        'testAccountProxy',
        'updateAccount',
        'updateReference',
      ],
      injected: null,
    });
  } finally {
    await quit(run);
  }
});

test('IPC handlers validate every request', async () => {
  const run = await launch({ userData: await workDir('ipc'), site });
  try {
    const [a] = await profiles(run);
    expect(await call(run, 'importCookies', 'not-a-uuid')).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await call(run, 'checkStatus', randomUUID())).toEqual({ ok: false, error: { code: 'unknown_profile' } });
    expect(await call(run, 'checkStatus', { $ne: null })).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await call(run, 'openSite', a!.id, '../../etc/passwd')).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await call(run, 'openSite', a!.id, 'constructor')).toEqual({ ok: false, error: { code: 'invalid_request' } });
  } finally {
    await quit(run);
  }
});

test('IPC refuses calls from any renderer other than the trusted app window', async () => {
  const run = await launch({ userData: await workDir('sender'), site });
  try {
    const [a] = await profiles(run);
    const page = await openSite(run, a!.id);
    // A third-party page has no bridge at all...
    expect(await page.window.evaluate(() => typeof (window as unknown as Record<string, unknown>)['ugc'])).toBe('undefined');
    // ...and even a forged IPC message from its webContents is rejected by the sender check.
    const result = await run.app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const site = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('app://'))!;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...a: unknown[]) => unknown> })._invokeHandlers;
      const handler = handlers.get('poc:list-profiles')!;
      return handler({ sender: site.webContents, senderFrame: site.webContents.mainFrame });
    });
    expect(result).toEqual({ ok: false, error: { code: 'untrusted_sender' } });
  } finally {
    await quit(run);
  }
});

test('third-party windows are sandboxed, cannot open popups and cannot leave the platform domain', async () => {
  const run = await launch({ userData: await workDir('third-party'), site });
  try {
    const [a] = await profiles(run);
    const { window: sitePage } = await openSite(run, a!.id);
    const env = await sitePage.evaluate(() => ({
      require: typeof (window as unknown as Record<string, unknown>)['require'],
      process: typeof (window as unknown as Record<string, unknown>)['process'],
      popup: window.open('https://example.com/') === null,
    }));
    expect(env).toEqual({ require: 'undefined', process: 'undefined', popup: true });

    const sandboxed = await run.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), prefs: (w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }).getLastWebPreferences() })),
    );
    for (const w of sandboxed) {
      expect(w.prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
      if (!w.url.startsWith('app://')) expect(w.prefs?.preload ?? '').toBe('');
    }

    const start = sitePage.url();
    await sitePage.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await sitePage.waitForTimeout(500);
    expect(sitePage.url()).toBe(start);
    expect(run.app.windows()).toHaveLength(2);

    const permission = await sitePage.evaluate(() => navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state));
    expect(permission).toBe('denied');
  } finally {
    await quit(run);
  }
});

test('no synthetic secret reaches logs, profile metadata or bridge responses', async () => {
  const dir = await workDir('leaks');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-leak');
  const good = await writeExport(dir, 'good', [
    cookieEditorEntry({ value: token }),
    cookieEditorEntry({ name: 'dup', value: syntheticToken('x') }),
    cookieEditorEntry({ name: 'dup', value: syntheticToken('y') }),
    cookieEditorEntry({ name: 'foreign', domain: 'example.com', value: syntheticToken('f') }),
  ]);
  const broken = await writeExport(dir, 'broken', `[{"name":"poc_session","value":"${syntheticToken('broken')}"`);
  const run = await launch({ userData, site });
  try {
    const [a, b] = await profiles(run);
    await importFile(run, a!.id, good);
    await importFile(run, b!.id, broken);
    await ok<Profile>(run, 'checkStatus', a!.id);
    await openSite(run, a!.id);
  } finally {
    await quit(run);
  }
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  // Guard against a vacuous pass: the import paths really did log.
  expect(log).toContain('cookie_import_completed');
  expect(log).toContain('cookie_import_failed');
  expect(JSON.stringify(run.responses)).not.toContain(CANARY_MARKER);
  expect(log).not.toContain(CANARY_MARKER);
  expect(readFileSync(join(userData, 'ugc.db')).toString('latin1')).not.toContain(CANARY_MARKER);
});

test('an Electron binary without the cookie-encryption fuse refuses imports by default', async () => {
  const dir = await workDir('fuse-guard');
  const file = await writeExport(dir, 'valid', [cookieEditorEntry({ value: site.addUser('user-guard') })]);
  const executablePath = await unfusedElectron();
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false });
  try {
    const [a] = await profiles(run);
    await stubOpenDialog(run, file);
    expect(await call(run, 'importCookies', a!.id)).toEqual({ ok: false, error: { code: 'cookie_encryption_disabled' } });
    expect((await profiles(run))[0]?.lastImport).toBeNull();
  } finally {
    await quit(run);
  }
});

function readCookieRows(db: string): Array<{ name: string; value: string; encrypted: Uint8Array }> {
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    return conn.prepare('SELECT name, value, encrypted_value AS encrypted FROM cookies').all() as never;
  } finally {
    conn.close();
  }
}

// Characterization of the risk the fuse addresses: without it, Chromium stores
// cookie values in plaintext in the partition's Cookies database.
test('without the fuse, cookie values sit in plaintext in the partition database', async () => {
  const dir = await workDir('plaintext-db');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-plain');
  const file = await writeExport(dir, 'valid', [cookieEditorEntry({ value: token })]);
  const executablePath = await unfusedElectron();
  const run = await launch({ userData, site, executablePath });
  const [a] = await profiles(run);
  try {
    await importFile(run, a!.id, file);
  } finally {
    await quit(run);
  }
  const rows = readCookieRows(cookieDatabase(userData, a!.partition));
  expect(rows.find((r) => r.name === 'poc_session')?.value).toBe(token);
});

test('with EnableCookieEncryption, the partition database holds no plaintext value and the session still works after restart', async () => {
  const executablePath = await fusedElectron();
  const dir = await workDir('encrypted-db');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-encrypted');
  const file = await writeExport(dir, 'valid', [cookieEditorEntry({ value: token })]);

  // No plaintext allowance: the guard must see the fuse as enabled.
  const first = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  const [a] = await profiles(first);
  try {
    await importFile(first, a!.id, file);
    expect((await ok<Profile>(first, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(first);
  }

  const db = cookieDatabase(userData, a!.partition);
  const row = readCookieRows(db).find((r) => r.name === 'poc_session');
  expect(row?.value).toBe('');
  expect(row?.encrypted.byteLength).toBeGreaterThan(0);
  const prefix = Buffer.from(row!.encrypted.subarray(0, 3)).toString('latin1');
  test.info().annotations.push({ type: 'encrypted_value prefix', description: prefix });
  expect(filesContaining(userData, token)).toEqual([]);

  const second = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  try {
    expect((await ok<Profile>(second, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(second);
  }
});
