import { expect, test } from '@playwright/test';
import { cookieEditorEntry, hashToken, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import { importFile, launch, ok, openSite, partitionCookies, profiles, quit, workDir, writeExport, type Profile } from './harness.js';

let site: SyntheticSite;
test.beforeAll(async () => {
  site = await startSyntheticSite();
});
test.afterAll(async () => {
  await site.close();
});

test('partitions are distinct, independent of labels, and never reused', async () => {
  const dirs = [await workDir('ids-1'), await workDir('ids-2')];
  const seen: string[] = [];
  for (const dir of dirs) {
    const run = await launch({ userData: dir, site });
    try {
      for (const p of await profiles(run)) {
        expect(p.partition).toMatch(/^persist:ps_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(p.partition).not.toContain(p.label);
        seen.push(p.partition);
      }
    } finally {
      await quit(run);
    }
  }
  expect(new Set(seen).size).toBe(4);
});

test('two profiles on the same site stay isolated: browser jar, server view and page state', async () => {
  const dir = await workDir('isolation');
  const tokenA = site.addUser('user-a');
  const tokenB = site.addUser('user-b');
  const fileA = await writeExport(dir, 'a', [cookieEditorEntry({ value: tokenA })]);
  const fileB = await writeExport(dir, 'b', [cookieEditorEntry({ value: tokenB })]);
  const run = await launch({ userData: dir + '/userData', site });
  try {
    const [a, b] = await profiles(run);

    // Only A imported: B must not see A's session anywhere.
    await importFile(run, a!.id, fileA);
    expect((await ok<Profile>(run, 'checkStatus', b!.id)).status).toBe('never_configured');
    expect(await partitionCookies(run, b!.partition)).toEqual([]);
    site.requests.length = 0;
    expect((await openSite(run, b!.id)).state).toBe('anonymous');
    expect(site.requests.length).toBeGreaterThan(0);
    expect(site.requests.every((r) => r.sessionTokenHash === null)).toBe(true);

    await importFile(run, b!.id, fileB);
    expect((await ok<Profile>(run, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
    expect((await ok<Profile>(run, 'checkStatus', b!.id)).status).toBe('appears_authenticated');

    // Each jar holds only its own token.
    expect((await partitionCookies(run, a!.partition)).map((c) => c.value)).toEqual([tokenA]);
    expect((await partitionCookies(run, b!.partition)).map((c) => c.value)).toEqual([tokenB]);

    // The server only ever receives each profile's own token from that profile's window.
    for (const [profile, token, user] of [[a!, tokenA, 'user-a'], [b!, tokenB, 'user-b']] as const) {
      site.requests.length = 0;
      const page = await openSite(run, profile.id);
      expect(page.status).toBe(`Authenticated as ${user}`);
      const hashes = new Set(site.requests.map((r) => r.sessionTokenHash));
      expect([...hashes]).toEqual([hashToken(token)]);
    }

    // Clearing one profile leaves the other intact.
    await ok(run, 'clearProfile', a!.id);
    expect(await partitionCookies(run, a!.partition)).toEqual([]);
    expect((await ok<Profile>(run, 'checkStatus', b!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(run);
  }
});

test('page-level storage is isolated too (localStorage set by one profile is invisible to the other)', async () => {
  const dir = await workDir('storage-isolation');
  const run = await launch({ userData: dir, site });
  try {
    const [a, b] = await profiles(run);
    const login = await openSite(run, a!.id, 'interactive-login');
    expect(login.state).toBe('logged-in');
    const strictA = await openSite(run, a!.id, 'strict');
    expect(strictA.state).toBe('authenticated');
    const strictB = await openSite(run, b!.id, 'strict');
    expect(strictB.status).toBe('Not authenticated (no_session)');
    expect(await strictB.window.evaluate(() => localStorage.getItem('poc_device_token'))).toBeNull();
  } finally {
    await quit(run);
  }
});
