import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cookieEditorEntry, sessionCookieEntry, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import { importFile, launch, ok, openSite, partitionCookies, profiles, quit, workDir, writeExport, type Profile } from './harness.js';

let site: SyntheticSite;
test.beforeAll(async () => {
  site = await startSyntheticSite();
});
test.afterAll(async () => {
  await site.close();
});

test('persistent cookies and profile metadata survive an app restart', async () => {
  const dir = await workDir('restart');
  const tokenA = site.addUser('user-a');
  const tokenB = site.addUser('user-b');
  const fileA = await writeExport(dir, 'a', [cookieEditorEntry({ value: tokenA })]);
  const fileB = await writeExport(dir, 'b', [cookieEditorEntry({ value: tokenB })]);
  const userData = dir + '/userData';

  const first = await launch({ userData, site });
  const before = await profiles(first);
  try {
    await importFile(first, before[0]!.id, fileA);
    await importFile(first, before[1]!.id, fileB);
    expect((await ok<Profile>(first, 'checkStatus', before[0]!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(first);
  }

  const second = await launch({ userData, site });
  try {
    const after = await profiles(second);
    expect(after.map((p) => [p.id, p.partition])).toEqual(before.map((p) => [p.id, p.partition]));
    expect(after.map((p) => p.lastImport?.imported)).toEqual([1, 1]);

    expect((await ok<Profile>(second, 'checkStatus', after[0]!.id)).status).toBe('appears_authenticated');
    expect((await ok<Profile>(second, 'checkStatus', after[1]!.id)).status).toBe('appears_authenticated');
    expect((await openSite(second, after[0]!.id)).status).toBe('Authenticated as user-a');
    expect((await openSite(second, after[1]!.id)).status).toBe('Authenticated as user-b');
    expect((await partitionCookies(second, after[0]!.partition)).map((c) => c.value)).toEqual([tokenA]);
  } finally {
    await quit(second);
  }
});

// Characterization (R-10): Electron 44 itself drops cookies without an expiry
// when the app exits. Only the sealed restore record (session-restore.spec.ts)
// brings them back; without it they are gone and the status says so.
test('session cookies (no expirationDate) do not survive a restart without the sealed record', async () => {
  const dir = await workDir('session-cookie');
  const token = site.addUser('user-session');
  const file = await writeExport(dir, 'session', [sessionCookieEntry({ value: token })]);
  const userData = dir + '/userData';

  const first = await launch({ userData, site });
  const [a] = await profiles(first);
  try {
    await importFile(first, a!.id, file);
    expect((await ok<Profile>(first, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(first);
  }
  rmSync(join(userData, 'session-restore'), { recursive: true, force: true });

  const second = await launch({ userData, site });
  try {
    expect(await partitionCookies(second, a!.partition)).toEqual([]);
    expect((await profiles(second))[0]).toMatchObject({
      status: 'locked_unavailable',
      statusReason: 'session_restore_failed',
      sessionSync: { restore: { state: 'failed', error: 'record_missing' } },
    });
    expect(await ok<Profile>(second, 'checkStatus', a!.id)).toMatchObject({ status: 'expired', statusReason: 'no_session_cookie' });
  } finally {
    await quit(second);
  }
});

test('cookie-only import cannot satisfy a site that also needs non-cookie state; interactive login can', async () => {
  const dir = await workDir('non-cookie-state');
  const token = site.addUser('user-cookie-only');
  const file = await writeExport(dir, 'cookie-only', [cookieEditorEntry({ value: token })]);
  const userData = dir + '/userData';

  const first = await launch({ userData, site });
  const [a, b] = await profiles(first);
  try {
    // Profile A: real interactive login in the isolated browser (site sets cookie + localStorage).
    expect((await openSite(first, a!.id, 'interactive-login')).state).toBe('logged-in');
    expect((await openSite(first, a!.id, 'strict')).state).toBe('authenticated');

    // Profile B: valid cookie imported, but no device token in localStorage.
    await importFile(first, b!.id, file);
    expect((await openSite(first, b!.id, 'home')).status).toBe('Authenticated as user-cookie-only');
    expect((await openSite(first, b!.id, 'strict')).status).toBe('Not authenticated (device_not_recognized)');
  } finally {
    await quit(first);
  }

  const second = await launch({ userData, site });
  try {
    // localStorage and the persistent cookie from the interactive login both persist.
    expect((await openSite(second, a!.id, 'strict')).state).toBe('authenticated');
    expect((await openSite(second, b!.id, 'strict')).status).toBe('Not authenticated (device_not_recognized)');
  } finally {
    await quit(second);
  }
});
