#!/usr/bin/env node
// Manual demo of the Gate 1 PoC: starts the local synthetic site, writes two
// synthetic Cookie-Editor exports, and launches the app pointed at the site.
// Build first (`pnpm build` at the repo root). Synthetic data only.
// Usage: node scripts/run-poc.mjs [--allow-unencrypted]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cookieEditorEntry, cookieEditorExport, startSyntheticSite } from '@ugc/test-fixtures';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const site = await startSyntheticSite();
const work = mkdtempSync(join(tmpdir(), 'ugc-poc-'));

for (const user of ['user-a', 'user-b']) {
  const file = join(work, `${user}.json`);
  writeFileSync(file, cookieEditorExport([cookieEditorEntry({ value: site.addUser(user) })]), { mode: 0o600 });
  console.log(`Synthetic export for ${user}: ${file}`);
}
console.log(`Synthetic site: ${site.url('')}  userData: ${join(work, 'userData')}`);

const env = { ...process.env, UGC_POC_SYNTHETIC: '1', UGC_POC_USER_DATA: join(work, 'userData'), UGC_POC_SITE_ORIGIN: site.url(''), UGC_POC_SITE_CERT_FP: site.certificateFingerprint };
delete env.NODE_OPTIONS;
if (process.argv.includes('--allow-unencrypted')) env.UGC_POC_ALLOW_UNENCRYPTED_SYNTHETIC = '1';

const child = spawn(electronPath, [join(desktopDir, 'dist', 'main', 'main.js')], { env, stdio: 'inherit' });
child.on('exit', async (code) => {
  await site.close();
  process.exit(code ?? 0);
});
