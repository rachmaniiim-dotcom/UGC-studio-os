import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANARY_MARKER, CSRF_COOKIE, cookieEditorEntry, csrfFor, sessionCookieEntry, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import {
  call,
  crash,
  filesContaining,
  fusedElectron,
  importFile,
  launch,
  ok,
  openSite,
  partitionCookies,
  profiles,
  quit,
  stubOpenDialog,
  waitForProtectedKey,
  waitForRevision,
  workDir,
  writeExport,
  type Profile,
  type Running,
} from './harness.js';

// C1: the live jar's session cookies (no expiry) are re-sealed whenever they
// change, with a revision checked against rollback. Every run uses the
// cookie-encryption binary and no plaintext allowance, as real use would.

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
const files = (userData: string, id: string) => ({
  record: join(userData, 'session-restore', `${id}.sealed`),
  revision: join(userData, 'session-restore', `${id}.rev`),
});
/** The session-cookie pair as the jar holds it: [session token, csrf] (csrf null if absent). */
async function pair(run: Running, partition: string): Promise<[string | null, string | null]> {
  const jar = await partitionCookies(run, partition);
  return [jar.find((c) => c.name === 'poc_session')?.value ?? null, jar.find((c) => c.name === CSRF_COOKIE)?.value ?? null];
}
const profileOf = async (run: Running, id: string): Promise<Profile> => (await profiles(run)).find((p) => p.id === id)!;

function assertNoLeaks(userData: string, runs: Running[]): void {
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).not.toContain(CANARY_MARKER);
  expect(filesContaining(userData, CANARY_MARKER)).toEqual([]);
  for (const run of runs) expect(JSON.stringify(run.responses)).not.toContain(CANARY_MARKER);
}

test('imported session cookies are restored after restarts; the UI shows the saved revision', async () => {
  const dir = await workDir('sync-restore');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-sync');
  const file = await writeExport(dir, 'mixed', [sessionCookieEntry({ value: token }), cookieEditorEntry({ name: 'pref', value: 'persistent-pref' })]);

  const first = await start(userData);
  const [a] = await profiles(first);
  try {
    expect((await importFile(first, a!.id, file)).sessionSync).toMatchObject({ savedCount: 1, saveError: null });
  } finally {
    await quit(first);
  }
  for (const f of Object.values(files(userData, a!.id))) expect(readFileSync(f).subarray(0, 3).toString('latin1')).toBe('v10');
  expect(filesContaining(userData, token)).toEqual([]);

  const runs: Running[] = [first];
  for (const _ of [1, 2]) {
    const run = await start(userData);
    runs.push(run);
    try {
      const p = await profileOf(run, a!.id);
      expect(p).toMatchObject({ status: 'imported_unverified', statusReason: 'session_restored' });
      expect(p.sessionSync.restore).toMatchObject({ state: 'restored', count: 1 });
      await expect(run.ui.locator('.sync').first()).toHaveAttribute('data-restore-state', 'restored');
      expect(await pair(run, a!.partition)).toEqual([token, null]);
      expect((await ok<Profile>(run, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
    } finally {
      await quit(run);
    }
  }
  assertNoLeaks(userData, runs);
});

test('a rotated session is saved as one new generation and restored after restart; the other profile is untouched', async () => {
  const dir = await workDir('sync-rotate');
  const userData = join(dir, 'userData');
  const tokenA = site.addUser('user-rot-a');
  const tokenB = site.addUser('user-rot-b');

  const first = await start(userData);
  const [a, b] = await profiles(first);
  let rotated: [string | null, string | null];
  let revisionB: number;
  try {
    const importedA = await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: tokenA })]));
    revisionB = (await importFile(first, b!.id, await writeExport(dir, 'b', [sessionCookieEntry({ value: tokenB })]))).sessionSync.revision;
    expect((await openSite(first, a!.id, 'rotate')).state).toBe('rotated');
    const saved = await waitForRevision(first, a!.id, importedA.sessionSync.revision + 1);
    rotated = await pair(first, a!.partition);
    expect(rotated[0]).not.toBe(tokenA);
    expect(rotated[1]).toBe(csrfFor(rotated[0]!));
    // Both cookies of the rotation are in one snapshot.
    await expect.poll(async () => (await profileOf(first, a!.id)).sessionSync.savedCount).toBe(2);
    expect(saved.sessionSync.saveError).toBeNull();
    expect((await profileOf(first, b!.id)).sessionSync.revision).toBe(revisionB);
  } finally {
    await quit(first);
  }

  const second = await start(userData);
  try {
    expect(await pair(second, a!.partition)).toEqual(rotated);
    expect(await pair(second, b!.partition)).toEqual([tokenB, null]);
    // The old token was revoked by the rotation, so "appears_authenticated" proves the new generation came back.
    expect((await ok<Profile>(second, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
    expect((await openSite(second, a!.id)).status).toBe('Authenticated as user-rot-a');
    expect((await openSite(second, b!.id)).status).toBe('Authenticated as user-rot-b');
  } finally {
    await quit(second);
  }
  assertNoLeaks(userData, [first, second]);
});

test('a saved rotation survives a crash', async () => {
  const dir = await workDir('sync-rotate-crash');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-rot-crash');
  const first = await start(userData);
  const [a] = await profiles(first);
  await waitForProtectedKey(userData);
  const imported = await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: token })]));
  await openSite(first, a!.id, 'rotate');
  await waitForRevision(first, a!.id, imported.sessionSync.revision + 1);
  await expect.poll(async () => (await profileOf(first, a!.id)).sessionSync.savedCount).toBe(2);
  const rotated = await pair(first, a!.partition);
  await crash(first);

  const second = await start(userData);
  try {
    expect(await pair(second, a!.partition)).toEqual(rotated);
    expect((await ok<Profile>(second, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(second);
  }
});

test('logout and Clear cannot resurrect deleted session cookies, even after a crash', async () => {
  const dir = await workDir('sync-logout');
  const userData = join(dir, 'userData');
  const first = await start(userData);
  const [a, b] = await profiles(first);
  await waitForProtectedKey(userData);
  const importedA = await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: site.addUser('user-out-a') })]));
  await importFile(first, b!.id, await writeExport(dir, 'b', [sessionCookieEntry({ value: site.addUser('user-out-b') })]));

  // A: the site logs the user out (deletes its cookies).
  expect((await openSite(first, a!.id, 'logout')).state).toBe('logged-out');
  const afterLogout = await waitForRevision(first, a!.id, importedA.sessionSync.revision + 1);
  await expect.poll(async () => (await profileOf(first, a!.id)).sessionSync.savedCount).toBe(0);
  expect(await profileOf(first, a!.id)).toMatchObject({ status: 'expired', statusReason: 'session_cookies_removed' });
  expect(afterLogout.sessionSync.saveError).toBeNull();
  // B: deliberate Clear.
  expect((await ok<Profile>(first, 'clearProfile', b!.id)).sessionSync.savedCount).toBe(0);
  await crash(first);

  for (const p of [a!, b!]) {
    expect(existsSync(files(userData, p.id).record)).toBe(false);
    expect(existsSync(files(userData, p.id).revision)).toBe(true);
  }
  const second = await start(userData);
  try {
    for (const p of [a!, b!]) {
      expect(await pair(second, p.partition)).toEqual([null, null]);
      expect((await profileOf(second, p.id)).sessionSync.restore).toBeNull();
    }
  } finally {
    await quit(second);
  }
});

test('a crash in the middle of a rotation restores one consistent generation, never a mix', async () => {
  test.setTimeout(180_000);
  for (const delayMs of [0, 30, 120, 400]) {
    const dir = await workDir(`sync-midcrash-${delayMs}`);
    const userData = join(dir, 'userData');
    const token = site.addUser(`user-mid-${delayMs}`);
    const first = await start(userData);
    const [a] = await profiles(first);
    await waitForProtectedKey(userData);
    await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: token })]));
    await openSite(first, a!.id, 'rotate');
    await new Promise((r) => setTimeout(r, delayMs));
    await crash(first);

    const second = await start(userData);
    try {
      const [session, csrf] = await pair(second, a!.partition);
      // Either the old generation (token, no csrf) or the complete new one (token', csrf(token')).
      const consistent = (session === token && csrf === null) || (session !== null && session !== token && csrf === csrfFor(session));
      expect(consistent, `delay ${delayMs} ms`).toBe(true);
      const status = await ok<Profile>(second, 'checkStatus', a!.id);
      expect(status.statusReason, `delay ${delayMs} ms`).not.toBe('inconsistent_session');
      // An old generation was revoked by the rotation: the status says so honestly.
      expect(status.status).toBe(session === token ? 'rejected' : 'appears_authenticated');
    } finally {
      await quit(second);
    }
  }
});

test('rollback: an older snapshot copied back is refused; restoring all three copies is not detected (documented)', async () => {
  const dir = await workDir('sync-rollback');
  const userData = join(dir, 'userData');
  const backup = join(dir, 'backup');
  const token = site.addUser('user-rollback');

  const first = await start(userData);
  const [a] = await profiles(first);
  try {
    await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: token })]));
  } finally {
    await quit(first);
  }
  const f = files(userData, a!.id);
  const meta = join(userData, 'poc-profiles.json');
  mkdirSync(backup);
  copyFileSync(f.record, join(backup, 'sealed'));
  copyFileSync(f.revision, join(backup, 'rev'));
  copyFileSync(meta, join(backup, 'meta'));

  const second = await start(userData);
  try {
    const before = (await profileOf(second, a!.id)).sessionSync.revision;
    await openSite(second, a!.id, 'rotate');
    await waitForRevision(second, a!.id, before + 1);
  } finally {
    await quit(second);
  }

  // Snapshot + revision record rolled back; metadata keeps the newer revision.
  copyFileSync(join(backup, 'sealed'), f.record);
  copyFileSync(join(backup, 'rev'), f.revision);
  const third = await start(userData);
  try {
    expect((await profileOf(third, a!.id)).sessionSync.restore).toMatchObject({ state: 'failed', error: 'stale_record' });
    expect(await pair(third, a!.partition)).toEqual([null, null]);
  } finally {
    await quit(third);
  }

  // Residual threat: all three copies from the same earlier moment restore the old generation.
  copyFileSync(join(backup, 'meta'), meta);
  const fourth = await start(userData);
  try {
    expect((await profileOf(fourth, a!.id)).sessionSync.restore).toMatchObject({ state: 'restored' });
    expect(await pair(fourth, a!.partition)).toEqual([token, null]);
    // The site revoked that generation at rotation, so it does not work.
    expect((await ok<Profile>(fourth, 'checkStatus', a!.id)).status).toBe('rejected');
  } finally {
    await quit(fourth);
  }
});

test('tampered, missing or undecryptable records fail closed and leave other profiles working', async () => {
  const dir = await workDir('sync-tamper');
  const userData = join(dir, 'userData');
  const first = await start(userData);
  const [a, b] = await profiles(first);
  try {
    await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: site.addUser('user-ta') })]));
    await importFile(first, b!.id, await writeExport(dir, 'b', [sessionCookieEntry({ value: site.addUser('user-tb') })]));
  } finally {
    await quit(first);
  }
  const fa = files(userData, a!.id);
  const fb = files(userData, b!.id);
  const original = { record: readFileSync(fa.record), revision: readFileSync(fa.revision) };
  const flip = (file: string): void => {
    const bytes = readFileSync(file);
    bytes[bytes.length - 20]! ^= 0xff;
    writeFileSync(file, bytes);
  };

  const cases: Array<[string, () => void, string]> = [
    ['tampered snapshot', () => flip(fa.record), 'decrypt_failed'],
    ['tampered revision record', () => flip(fa.revision), 'revision_decrypt_failed'],
    ['missing revision record', () => rmSync(fa.revision), 'revision_missing'],
    ['missing snapshot', () => rmSync(fa.record), 'record_missing'],
    ['snapshot moved from another profile', () => copyFileSync(fb.record, fa.record), 'binding_mismatch'],
    ['revision record moved from another profile', () => copyFileSync(fb.revision, fa.revision), 'revision_binding_mismatch'],
  ];
  const runs: Running[] = [first];
  for (const [label, damage, error] of cases) {
    writeFileSync(fa.record, original.record);
    writeFileSync(fa.revision, original.revision);
    damage();
    const run = await start(userData);
    runs.push(run);
    try {
      const pa = await profileOf(run, a!.id);
      expect(pa, label).toMatchObject({ status: 'locked_unavailable', statusReason: 'session_restore_failed' });
      expect(pa.sessionSync.restore, label).toMatchObject({ state: 'failed', count: 0, error });
      expect(await pair(run, a!.partition), label).toEqual([null, null]);
      expect((await profileOf(run, b!.id)).sessionSync.restore, label).toMatchObject({ state: 'restored', count: 1 });
      expect((await openSite(run, b!.id)).status, label).toBe('Authenticated as user-tb');
    } finally {
      await quit(run);
    }
  }

  // Lost OS-protected key (profile copied to another user or machine).
  rmSync(join(userData, 'Local State'));
  const last = await start(userData);
  runs.push(last);
  try {
    for (const p of await profiles(last)) expect(p.sessionSync.restore?.state).toBe('failed');
  } finally {
    await quit(last);
  }
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).toContain('"event":"session_restore_failed"');
  expect(log).not.toMatch(/decryptString|ciphertext/i);
  assertNoLeaks(userData, runs);
});

test('without OS protected storage nothing is written and nothing can be restored', async () => {
  const dir = await workDir('sync-unprotected');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-unprotected');
  const first = await start(userData);
  const [a] = await profiles(first);
  try {
    await first.app.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => false;
    });
    const p = await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: token })]));
    expect(p.sessionSync).toMatchObject({ savedCount: 0, saveError: 'protected_storage_unavailable' });
    expect(existsSync(files(userData, a!.id).record)).toBe(false);
  } finally {
    await quit(first);
  }
  expect(filesContaining(userData, token)).toEqual([]);

  const second = await start(userData);
  try {
    expect(await pair(second, a!.partition)).toEqual([null, null]);
    expect(await ok<Profile>(second, 'checkStatus', a!.id)).toMatchObject({ status: 'expired', statusReason: 'no_session_cookie' });
  } finally {
    await quit(second);
  }
});

test('a brand-new profile refuses imports until its encryption key is on disk; a crash before that fails closed', async () => {
  test.setTimeout(120_000);
  const dir = await workDir('sync-key-guard');
  const token = site.addUser('user-key-guard');
  const file = await writeExport(dir, 'a', [sessionCookieEntry({ value: token })]);

  // Guard on (always on for real platforms on Windows).
  const guarded = join(dir, 'guarded');
  const run = await launch({ userData: guarded, site, executablePath, allowUnencryptedSynthetic: false, env: { UGC_POC_REQUIRE_PERSISTED_KEY: '1' } });
  try {
    const [a] = await profiles(run);
    if (process.platform === 'win32') {
      await stubOpenDialog(run, file);
      expect(await call(run, 'importCookies', a!.id)).toEqual({ ok: false, error: { code: 'protected_key_not_ready' } });
      await waitForProtectedKey(guarded);
    }
    expect((await importFile(run, a!.id, file)).sessionSync.savedCount).toBe(1);
  } finally {
    await quit(run);
  }

  // Guard off (synthetic default): import immediately, crash before the key is written.
  const unguarded = join(dir, 'unguarded');
  const first = await start(unguarded);
  const [b] = await profiles(first);
  await importFile(first, b!.id, file);
  const keyWritten = existsSync(join(unguarded, 'Local State'));
  await crash(first);
  const second = await start(unguarded);
  try {
    const restore = (await profileOf(second, b!.id)).sessionSync.restore;
    test.info().annotations.push({ type: 'key written before crash', description: String(keyWritten) });
    if (!keyWritten) {
      // Key lost with the crash: nothing decrypts, nothing is restored, nothing leaks.
      expect(restore).toMatchObject({ state: 'failed', error: 'revision_decrypt_failed' });
      expect(await pair(second, b!.partition)).toEqual([null, null]);
    }
  } finally {
    await quit(second);
  }
  expect(filesContaining(unguarded, token)).toEqual([]);
});
