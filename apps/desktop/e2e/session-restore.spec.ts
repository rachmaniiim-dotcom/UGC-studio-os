import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANARY_MARKER, cookieEditorEntry, sessionCookieEntry, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import {
  filesContaining,
  fusedElectron,
  importFile,
  launch,
  ok,
  openSite,
  partitionCookies,
  profiles,
  quit,
  workDir,
  writeExport,
  type Profile,
  type Running,
} from './harness.js';

// Session cookies (no expiry) are sealed with safeStorage (DPAPI-backed on
// Windows) at import and set again at startup (R-10 prototype). Every run here
// uses the cookie-encryption binary with no plaintext allowance, as real use would.

let site: SyntheticSite;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await site.close();
});

const start = (userData: string): Promise<Running> => launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
const sealedFile = (userData: string, profileId: string): string => join(userData, 'session-restore', `${profileId}.sealed`);
const sessionValues = async (run: Running, partition: string) =>
  (await partitionCookies(run, partition)).filter((c) => c.name === 'poc_session').map((c) => ({ value: c.value, session: c.session }));

test('session cookies are sealed at import and restored after each restart', async () => {
  const dir = await workDir('restore');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-restore');
  const file = await writeExport(dir, 'mixed', [sessionCookieEntry({ value: token }), cookieEditorEntry({ name: 'pref', value: 'persistent-pref' })]);

  const first = await start(userData);
  const [a] = await profiles(first);
  try {
    const imported = await importFile(first, a!.id, file);
    expect(imported.sessionRestore).toMatchObject({ state: 'sealed', count: 1, error: null });
    expect((await ok<Profile>(first, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(first);
  }

  // At rest: the only copy of the session token is the sealed record, and it is not plaintext.
  const sealed = readFileSync(sealedFile(userData, a!.id));
  if (process.platform === 'win32') expect(sealed.subarray(0, 3).toString('latin1')).toBe('v10');
  expect(filesContaining(userData, token)).toEqual([]);
  expect(filesContaining(userData, CANARY_MARKER)).toEqual([]);

  for (const round of [1, 2]) {
    const run = await start(userData);
    try {
      const [restored] = await profiles(run);
      expect(restored).toMatchObject({ status: 'imported_unverified', statusReason: 'session_restored' });
      expect(restored!.sessionRestore).toMatchObject({ state: 'restored', count: 1, error: null });
      await expect(run.ui.locator('.restore').first()).toHaveAttribute('data-restore-state', 'restored');
      expect(await sessionValues(run, a!.partition)).toEqual([{ value: token, session: true }]);
      expect((await partitionCookies(run, a!.partition)).map((c) => c.name).sort()).toEqual(['poc_session', 'pref']);
      expect((await ok<Profile>(run, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
      expect((await openSite(run, a!.id)).status).toBe('Authenticated as user-restore');
      expect(JSON.stringify(run.responses), `round ${round}`).not.toContain(CANARY_MARKER);
    } finally {
      await quit(run);
    }
  }

  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).toContain('session_cookies_sealed');
  expect(log).toContain('session_cookies_restored');
  expect(log).not.toContain(CANARY_MARKER);
  expect(filesContaining(userData, token)).toEqual([]);
});

test('restored session cookies stay in their own profile, and a record moved to another profile is refused', async () => {
  const dir = await workDir('restore-isolation');
  const userData = join(dir, 'userData');
  const tokenA = site.addUser('user-ra');
  const tokenB = site.addUser('user-rb');
  const fileA = await writeExport(dir, 'a', [sessionCookieEntry({ value: tokenA })]);
  const fileB = await writeExport(dir, 'b', [sessionCookieEntry({ value: tokenB })]);

  const first = await start(userData);
  const [a, b] = await profiles(first);
  try {
    await importFile(first, a!.id, fileA);
    await importFile(first, b!.id, fileB);
  } finally {
    await quit(first);
  }

  const second = await start(userData);
  try {
    expect(await sessionValues(second, a!.partition)).toEqual([{ value: tokenA, session: true }]);
    expect(await sessionValues(second, b!.partition)).toEqual([{ value: tokenB, session: true }]);
    expect((await openSite(second, a!.id)).status).toBe('Authenticated as user-ra');
    expect((await openSite(second, b!.id)).status).toBe('Authenticated as user-rb');
  } finally {
    await quit(second);
  }

  // Swap the two sealed records: each still decrypts (same OS user), but is bound to the other profile.
  const recordA = readFileSync(sealedFile(userData, a!.id));
  writeFileSync(sealedFile(userData, a!.id), readFileSync(sealedFile(userData, b!.id)));
  writeFileSync(sealedFile(userData, b!.id), recordA);

  const third = await start(userData);
  try {
    for (const p of await profiles(third)) {
      expect(p).toMatchObject({ status: 'locked_unavailable', statusReason: 'session_restore_failed' });
      expect(p.sessionRestore).toMatchObject({ state: 'failed', count: 0, error: 'binding_mismatch' });
      expect(await sessionValues(third, p.partition)).toEqual([]);
    }
  } finally {
    await quit(third);
  }
});

test('a record that cannot be decrypted fails safely and leaves other profiles working', async () => {
  const dir = await workDir('restore-failure');
  const userData = join(dir, 'userData');
  const tokenA = site.addUser('user-fa');
  const tokenB = site.addUser('user-fb');
  const first = await start(userData);
  const [a, b] = await profiles(first);
  try {
    await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: tokenA })]));
    await importFile(first, b!.id, await writeExport(dir, 'b', [sessionCookieEntry({ value: tokenB })]));
  } finally {
    await quit(first);
  }

  // 1. Tampered ciphertext in A's record (AES-GCM authentication fails).
  const record = readFileSync(sealedFile(userData, a!.id));
  record[record.length - 20]! ^= 0xff;
  writeFileSync(sealedFile(userData, a!.id), record);

  const second = await start(userData);
  try {
    const [pa, pb] = await profiles(second);
    expect(pa).toMatchObject({ status: 'locked_unavailable', statusReason: 'session_restore_failed' });
    expect(pa!.sessionRestore).toMatchObject({ state: 'failed', error: 'decrypt_failed' });
    expect(await sessionValues(second, a!.partition)).toEqual([]);
    expect(pb!.sessionRestore).toMatchObject({ state: 'restored', count: 1 });
    expect((await openSite(second, b!.id)).status).toBe('Authenticated as user-fb');
    // The UI still works and shows the failure; status checks report the site's view honestly.
    await expect(second.ui.locator(`[data-profile-id="${a!.id}"] .restore`)).toHaveAttribute('data-restore-state', 'failed');
    expect(await ok<Profile>(second, 'checkStatus', a!.id)).toMatchObject({ status: 'expired', statusReason: 'no_session_cookie' });
  } finally {
    await quit(second);
  }

  // 2. Lost OS-protected key (e.g. profile copied to another user or machine): Chromium makes a new key.
  rmSync(join(userData, 'Local State'));
  const third = await start(userData);
  try {
    for (const p of await profiles(third)) {
      expect(p.sessionRestore).toMatchObject({ state: 'failed', error: 'decrypt_failed' });
      expect(await sessionValues(third, p.partition)).toEqual([]);
    }
  } finally {
    await quit(third);
  }

  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).toContain('"event":"session_restore_failed"');
  expect(log).not.toContain(CANARY_MARKER);
  expect(log).not.toMatch(/decryptString|ciphertext/i);
});

test('without OS protected storage nothing is sealed, and Clear or a re-import removes the record', async () => {
  const dir = await workDir('restore-unavailable');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-unprotected');
  const sessionFile = await writeExport(dir, 'session', [sessionCookieEntry({ value: token })]);
  const persistentFile = await writeExport(dir, 'persistent', [cookieEditorEntry({ value: site.addUser('user-persistent') })]);

  const first = await start(userData);
  const [a, b] = await profiles(first);
  try {
    // Simulate a machine without usable protected storage (test-only override in the main process).
    await first.app.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => false;
    });
    expect((await importFile(first, a!.id, sessionFile)).sessionRestore).toMatchObject({
      state: 'not_sealed',
      count: 1,
      error: 'protected_storage_unavailable',
    });
    expect(existsSync(sealedFile(userData, a!.id))).toBe(false);
  } finally {
    await quit(first);
  }
  expect(filesContaining(userData, token)).toEqual([]);

  const second = await start(userData);
  try {
    // Unsealed session cookies are simply gone after restart, and the status says so.
    expect(await sessionValues(second, a!.partition)).toEqual([]);
    expect(await ok<Profile>(second, 'checkStatus', a!.id)).toMatchObject({ status: 'expired', statusReason: 'no_session_cookie' });

    await importFile(second, a!.id, sessionFile);
    await importFile(second, b!.id, sessionFile);
    expect(existsSync(sealedFile(userData, a!.id))).toBe(true);
    expect(existsSync(sealedFile(userData, b!.id))).toBe(true);

    expect((await ok<Profile>(second, 'clearProfile', a!.id)).sessionRestore).toBeNull();
    expect(existsSync(sealedFile(userData, a!.id))).toBe(false);
    // Import replaces the jar, so an export without session cookies removes the old record.
    expect((await importFile(second, b!.id, persistentFile)).sessionRestore).toBeNull();
    expect(existsSync(sealedFile(userData, b!.id))).toBe(false);
  } finally {
    await quit(second);
  }

  const third = await start(userData);
  try {
    for (const p of await profiles(third)) expect(await sessionValues(third, p.partition)).not.toContainEqual({ value: token, session: true });
  } finally {
    await quit(third);
  }
});
