import { expect, test } from '@playwright/test';
import {
  SYNTHETIC_DOMAIN,
  SYNTHETIC_HOST,
  cookieEditorEntry,
  sessionCookieEntry,
  startSyntheticSite,
  syntheticToken,
  type SyntheticSite,
} from '@ugc/test-fixtures';
import { importFile, launch, ok, openSite, partitionCookies, profiles, quit, workDir, writeExport, type Profile } from './harness.js';

let site: SyntheticSite;
test.beforeAll(async () => {
  site = await startSyntheticSite();
});
test.afterAll(async () => {
  await site.close();
});

test('imports a valid synthetic export and the site recognizes the session', async () => {
  const dir = await workDir('import');
  const token = site.addUser('user-a');
  const file = await writeExport(dir, 'valid', [cookieEditorEntry({ value: token })]);
  const run = await launch({ userData: dir + '/userData', site });
  try {
    const [a] = await profiles(run);
    expect(a?.status).toBe('never_configured');

    const imported = await importFile(run, a!.id, file);
    expect(imported.status).toBe('imported_unverified');
    expect(imported.lastImport).toMatchObject({ format: 'cookie-editor-json', examined: 1, imported: 1, browserLoaded: 1 });

    const checked = await ok<Profile>(run, 'checkStatus', a!.id);
    expect(checked.status).toBe('appears_authenticated');

    const page = await openSite(run, a!.id);
    expect(page.status).toBe('Authenticated as user-a');
  } finally {
    await quit(run);
  }
});

test('malformed and unsupported files fail safely and leave existing cookies untouched', async () => {
  const dir = await workDir('malformed');
  const token = site.addUser('user-keep');
  const valid = await writeExport(dir, 'valid', [cookieEditorEntry({ value: token })]);
  const broken = await writeExport(dir, 'broken', '[{"name": "poc_session", "value": ');
  const netscape = await writeExport(dir, 'netscape', `# Netscape HTTP Cookie File\n${SYNTHETIC_HOST}\tFALSE\t/\tTRUE\t0\tpoc_session\t${token}\n`);
  const run = await launch({ userData: dir + '/userData', site });
  try {
    const [a] = await profiles(run);
    await importFile(run, a!.id, valid);

    const afterBroken = await importFile(run, a!.id, broken);
    expect(afterBroken.status).toBe('imported_unverified');
    expect(afterBroken.lastImport).toMatchObject({ fileError: 'invalid_json', imported: 0, browserLoaded: 0 });

    const afterNetscape = await importFile(run, a!.id, netscape);
    expect(afterNetscape.lastImport).toMatchObject({ format: 'netscape', fileError: 'unsupported_format' });

    expect((await partitionCookies(run, a!.partition)).map((c) => c.value)).toEqual([token]);
    expect((await ok<Profile>(run, 'checkStatus', a!.id)).status).toBe('appears_authenticated');
  } finally {
    await quit(run);
  }
});

test('mixed export: invalid entries are reported, attributes survive the trip into Electron', async () => {
  const dir = await workDir('mixed');
  const token = site.addUser('user-mixed');
  const file = await writeExport(dir, 'mixed', [
    cookieEditorEntry({ value: token }),
    cookieEditorEntry({ name: 'domain_cookie', domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false, httpOnly: false, sameSite: 'strict', value: syntheticToken('d') }),
    cookieEditorEntry({ name: 'cross_site', sameSite: 'no_restriction', value: syntheticToken('n') }),
    cookieEditorEntry({ name: 'unspecified_ss', sameSite: null, value: syntheticToken('u') }),
    sessionCookieEntry({ name: 'session_only', value: syntheticToken('s') }),
    cookieEditorEntry({ name: 'foreign', domain: 'example.com', value: syntheticToken('f') }),
    cookieEditorEntry({ name: 'old', expirationDate: 1000, value: syntheticToken('o') }),
    cookieEditorEntry({ name: 'dup', value: syntheticToken('x') }),
    cookieEditorEntry({ name: 'dup', value: syntheticToken('y') }),
    cookieEditorEntry({ name: 'chips', partitionKey: { topLevelSite: 'https://ugc-poc.test' }, value: syntheticToken('p') }),
  ]);
  const run = await launch({ userData: dir + '/userData', site });
  try {
    const [a] = await profiles(run);
    const profile = await importFile(run, a!.id, file);
    expect(profile.lastImport).toMatchObject({
      examined: 10,
      imported: 6,
      skipped: 1,
      rejected: 3,
      reasons: { domain_out_of_scope: 1, expired: 1, conflicting_duplicate: 2 },
      browserLoaded: 5,
      browserFailures: { unsupported_partitioned: 1 },
    });
    expect(profile.lastImport?.messages.join(' ')).toContain('Entries #8, #9 describe the same cookie');

    const jar = Object.fromEntries((await partitionCookies(run, a!.partition)).map((c) => [c.name, c]));
    expect(Object.keys(jar).sort()).toEqual(['cross_site', 'domain_cookie', 'poc_session', 'session_only', 'unspecified_ss']);
    expect(jar['poc_session']).toMatchObject({ domain: SYNTHETIC_HOST, hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax', session: false });
    expect(jar['domain_cookie']).toMatchObject({ domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false, httpOnly: false, sameSite: 'strict' });
    expect(jar['cross_site']).toMatchObject({ sameSite: 'no_restriction', secure: true });
    expect(jar['unspecified_ss']).toMatchObject({ sameSite: 'unspecified' });
    expect(jar['session_only']).toMatchObject({ session: true });
    expect(jar['session_only']?.expirationDate).toBeUndefined();
  } finally {
    await quit(run);
  }
});

test('a revoked session reads as rejected and clearing returns the profile to never_configured', async () => {
  const dir = await workDir('revoke');
  const token = site.addUser('user-revoked');
  const file = await writeExport(dir, 'valid', [cookieEditorEntry({ value: token })]);
  const run = await launch({ userData: dir + '/userData', site });
  try {
    const [a] = await profiles(run);
    await importFile(run, a!.id, file);
    expect((await ok<Profile>(run, 'checkStatus', a!.id)).status).toBe('appears_authenticated');

    site.revokeToken(token);
    expect(await ok<Profile>(run, 'checkStatus', a!.id)).toMatchObject({ status: 'rejected', statusReason: 'site_rejected_session' });

    const cleared = await ok<Profile>(run, 'clearProfile', a!.id);
    expect(cleared).toMatchObject({ status: 'never_configured', lastImport: null });
    expect(await partitionCookies(run, a!.partition)).toEqual([]);
    expect((await ok<Profile>(run, 'checkStatus', a!.id)).status).toBe('never_configured');
  } finally {
    await quit(run);
  }
});
