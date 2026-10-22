import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { cookieEditorEntry, sessionCookieEntry, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import {
  call,
  createAccount,
  fusedElectron,
  importFile,
  launch,
  ok,
  openSite,
  profiles,
  quit,
  sessionOf,
  waitForProtectedKey,
  workDir,
  writeExport,
  type Profile,
  type Running,
} from './harness.js';

// C2/C3: platform definitions and owner-confirmed status. The synthetic site
// in "manual" mode stands in for a platform that forbids automation, so the
// test can count every request the app sends to it.

let site: SyntheticSite;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await site.close();
});

const manual = (userData: string): Promise<Running> =>
  launch({ userData, site, executablePath, allowUnencryptedSynthetic: false, env: { UGC_POC_STATUS_MODE: 'manual' } });

test('a no-automation platform: no automated check, no app-initiated request, owner confirmation kept distinct', async () => {
  const dir = await workDir('manual-status');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-manual');
  const sessionFile = await writeExport(dir, 'session', [sessionCookieEntry({ value: token })]);
  const requestsBefore = site.requests.length;

  const first = await manual(userData);
  const [a, b] = await profiles(first);
  try {
    expect(await ok(first, 'getPlatform')).toMatchObject({ statusCheck: 'manual', automation: 'not_permitted' });
    await expect(first.ui.locator('#platform')).toHaveAttribute('data-status-check', 'manual');
    await expect(first.ui.getByRole('button', { name: 'Check status' })).toHaveCount(0);
    await expect(first.ui.getByRole('button', { name: 'I see I am logged in' })).toHaveCount(2);

    expect(await call(first, 'checkStatus', a!.id)).toEqual({ ok: false, error: { code: 'automated_check_not_permitted' } });
    expect((await importFile(first, a!.id, sessionFile)).status).toBe('imported_unverified');
    expect(await call(first, 'confirmStatus', a!.id, 'maybe')).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await ok<Profile>(first, 'confirmStatus', a!.id, 'logged_in')).toMatchObject({ status: 'confirmed_by_user', statusReason: 'owner_confirmed' });
    expect(await ok<Profile>(first, 'confirmStatus', b!.id, 'logged_out')).toMatchObject({ status: 'expired', statusReason: 'owner_reported_logged_out' });
  } finally {
    await quit(first);
  }

  const second = await manual(userData);
  try {
    // Restored, but a confirmation from the previous run is not carried over.
    expect((await profiles(second))[0]).toMatchObject({ status: 'imported_unverified', statusReason: 'session_restored' });
  } finally {
    await quit(second);
  }
  // Import, confirmation, restore and restart sent nothing to the site.
  expect(site.requests.length).toBe(requestsBefore);
});

test('confirmation is withdrawn when the site deletes the session cookies, and after a restart', async () => {
  const dir = await workDir('manual-withdraw');
  const userData = join(dir, 'userData');
  const first = await manual(userData);
  const [a, b] = await profiles(first);
  try {
    await importFile(first, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: site.addUser('user-wd-a') })]));
    await importFile(first, b!.id, await writeExport(dir, 'b', [cookieEditorEntry({ value: site.addUser('user-wd-b') })]));
    await ok(first, 'confirmStatus', a!.id, 'logged_in');
    await ok(first, 'confirmStatus', b!.id, 'logged_in');
    // The owner browses to the logout page in A's window (a user action, not app automation).
    await openSite(first, a!.id, 'logout');
    await expect.poll(async () => (await profiles(first))[0]!.status).toBe('expired');
    expect((await profiles(first))[0]!.statusReason).toBe('session_cookies_removed');
  } finally {
    await quit(first);
  }
  const second = await manual(userData);
  try {
    // B only had a persistent cookie: still there, but the confirmation must be made again.
    expect((await profiles(second))[1]).toMatchObject({ status: 'imported_unverified', statusReason: 'restarted_unverified' });
  } finally {
    await quit(second);
  }
});

test('real mode, Kalodata session of an account (offline): its own cookie scope, no automated check, no browsing without a proxy', async () => {
  // Synthetic data only, no window, no network. The synthetic cookies are
  // outside Kalodata's scope, so nothing is loaded; this checks the boundary,
  // not Kalodata.
  const dir = await workDir('kalodata-boundary');
  const userData = join(dir, 'userData');
  const synthetic = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  const [s] = await profiles(synthetic);
  await quit(synthetic);

  const run = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false, synthetic: false });
  try {
    // Real runs have no test profiles and no test platform.
    expect(await ok(run, 'getPlatform')).toBeNull();
    expect(await profiles(run)).toEqual([]);
    expect(await call(run, 'confirmStatus', s!.id, 'logged_in')).toEqual({ ok: false, error: { code: 'platform_not_active' } });

    const account = await createAccount(run, 'Boundary check');
    const kalodata = sessionOf(account, 'kalodata');
    expect(kalodata.platform).toEqual({ id: 'kalodata', displayName: 'Kalodata', statusCheck: 'manual', automation: 'not_permitted', pages: ['home'] });
    expect(account.sessions.every((x) => x.platform.automation === 'not_permitted' && x.platform.statusCheck === 'manual')).toBe(true);
    expect(await call(run, 'checkStatus', kalodata.id)).toEqual({ ok: false, error: { code: 'automated_check_not_permitted' } });
    expect(await call(run, 'openSite', kalodata.id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_configured' } });
    await waitForProtectedKey(userData);
    const imported = await importFile(run, kalodata.id, await writeExport(dir, 'synthetic', [sessionCookieEntry(), cookieEditorEntry({ name: 'p' })]));
    expect(imported.lastImport).toMatchObject({ imported: 0, rejected: 2, reasons: { domain_out_of_scope: 2 } });
    expect(imported.status).toBe('never_configured');
  } finally {
    await quit(run);
  }
});
