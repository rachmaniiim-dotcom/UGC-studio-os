import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANARY_MARKER, cookieEditorEntry, sessionCookieEntry, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import {
  filesContaining,
  fusedElectron,
  importFile,
  launch,
  openSite,
  profiles,
  quit,
  securityCheck,
  unfusedElectron,
  waitForRevision,
  workDir,
  writeExport,
} from './harness.js';

// C4: the local security check finds leaked copies of the live cookie values
// and reports only sanitized findings.

let site: SyntheticSite;
test.beforeAll(async () => {
  site = await startSyntheticSite();
});
test.afterAll(async () => {
  await site.close();
});

test('passes on a clean encrypted profile, without adding plaintext copies', async () => {
  const executablePath = await fusedElectron();
  const dir = await workDir('check-clean');
  const userData = join(dir, 'userData');
  const session = site.addUser('user-check');
  const run = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  const [a] = await profiles(run);
  try {
    const p = await importFile(run, a!.id, await writeExport(dir, 'a', [sessionCookieEntry({ value: session }), cookieEditorEntry({ name: 'keep', value: site.addUser('user-check-p') })]));
    await openSite(run, a!.id, 'rotate');
    await waitForRevision(run, a!.id, p.sessionSync.revision + 1);
  } finally {
    await quit(run);
  }

  const check = await securityCheck({ userData, executablePath });
  expect(check.code).toBe(0);
  expect(check.report.result).toBe('pass');
  expect(check.report.findings).toEqual([]);
  expect(check.report.environment).toMatchObject({ cookieEncryptionFuse: 'on', protectedStorage: 'available' });
  const pa = check.report.profiles[0]!;
  expect(pa.snapshot).toBe('ok');
  expect(pa.needles).toBeGreaterThanOrEqual(2);
  expect(pa.cookieDb).toMatchObject({ plaintextRows: 0 });
  expect(Object.keys(pa.cookieDb!.prefixes)).toEqual(['v10']);
  expect(check.report.scan.files).toBeGreaterThan(10);
  expect(check.output).not.toContain(CANARY_MARKER);
  expect(filesContaining(userData, CANARY_MARKER)).toEqual([]);
});

test('reports leaked copies, plaintext cookie rows and shared accounts by location and count only', async () => {
  const executablePath = await unfusedElectron();
  const dir = await workDir('check-leaks');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-leaked');
  const exportFile = await writeExport(dir, 'a', [cookieEditorEntry({ value: token })]);
  // Same account in both profiles (account boundary violation).
  const run = await launch({ userData, site, executablePath });
  const [a, b] = await profiles(run);
  try {
    await importFile(run, a!.id, exportFile);
    await importFile(run, b!.id, exportFile);
  } finally {
    await quit(run);
  }
  mkdirSync(join(userData, 'notes'));
  writeFileSync(join(userData, 'notes', 'pasted.txt'), `debug ${encodeURIComponent(token)} end`);
  const exportsDir = join(dir, 'exports');
  mkdirSync(exportsDir);
  writeFileSync(join(exportsDir, 'forgotten-export.json'), readFileSync(exportFile));

  const check = await securityCheck({ userData, executablePath, scan: [exportsDir] });
  expect(check.code).toBe(1);
  expect(check.report.result).toBe('fail');
  const byCheck = (name: string) => check.report.findings.filter((f) => f.check === name);
  expect(byCheck('cookie_encryption_fuse_off')).toHaveLength(1);
  expect(byCheck('plaintext_cookie_rows').map((f) => f.where).sort()).toEqual(['Synthetic Profile A', 'Synthetic Profile B']);
  expect(byCheck('value_shared_between_profiles')).toEqual([{ check: 'value_shared_between_profiles', severity: 'medium', count: 1 }]);
  const leaks = byCheck('plaintext_secret_in_file').map((f) => f.where!);
  expect(leaks).toContain('userData/notes/pasted.txt');
  expect(leaks).toContain('scan1/forgotten-export.json');
  expect(leaks.some((w) => /^userData\/Partitions\/.+\/Cookies$/.test(w))).toBe(true);
  // Sanitized: no value, no cookie name, anywhere in what the command printed.
  expect(check.output).not.toContain(CANARY_MARKER);
  expect(check.output).not.toContain('poc_session');
});

test('refuses to run while the app is using the same profile data', async () => {
  const executablePath = await fusedElectron();
  const dir = await workDir('check-running');
  const userData = join(dir, 'userData');
  const run = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  try {
    const check = await securityCheck({ userData, executablePath });
    expect(check.code).toBe(2);
    expect(check.report).toMatchObject({ result: 'error', error: 'app_running' });
  } finally {
    await quit(run);
  }
});

