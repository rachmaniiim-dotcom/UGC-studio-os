#!/usr/bin/env node
// Gate 2 launcher: opens the app for the owner's manual Kalodata session test.
// Refuses to start unless cookie encryption is on and the data folder is
// private (outside the repo, outside OneDrive). Clears every synthetic/test
// switch and discards the app's console output, so nothing from the real
// session is printed. It never reads cookie files and never touches Kalodata:
// the owner imports, browses and confirms by hand.
// Usage: node scripts/run-gate2.mjs [--user-data <dir>]   (default C:\ugc-private\gate2-userData)
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const electronPath = createRequire(import.meta.url)('electron');
const args = process.argv.slice(2);
const at = args.indexOf('--user-data');
const userData = resolve(at >= 0 && args[at + 1] ? args[at + 1] : 'C:\\ugc-private\\gate2-userData');

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const fail = (msg) => {
  console.error(`Not starting: ${msg}`);
  process.exit(1);
};

if ((await getCurrentFuseWire(electronPath))[FuseV1Options.EnableCookieEncryption] !== FuseState.ENABLE) {
  fail('cookie encryption fuse is OFF. Run: node apps/desktop/scripts/enable-dev-fuses.mjs');
}
if (inside(userData, repoRoot)) fail('the data folder is inside the repository.');
for (const synced of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) {
  if (synced && inside(userData, resolve(synced))) fail('the data folder is inside OneDrive.');
}

const env = { ...process.env, UGC_PLATFORM: 'kalodata', UGC_POC_USER_DATA: userData };
for (const key of Object.keys(env)) if (key === 'NODE_OPTIONS' || (key.startsWith('UGC_POC_') && key !== 'UGC_POC_USER_DATA')) delete env[key];

console.log(`Starting the app for Kalodata (manual) with data folder ${userData}. Close the app window to finish.`);
const child = spawn(electronPath, [join(desktopDir, 'dist', 'main', 'main.js')], { env, stdio: 'ignore' });
child.on('exit', (code) => {
  console.log(`App closed (exit ${code ?? 0}).`);
  process.exit(0);
});
