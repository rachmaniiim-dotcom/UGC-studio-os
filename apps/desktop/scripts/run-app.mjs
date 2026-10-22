#!/usr/bin/env node
// Launcher for the owner's own use of the Session Manager (Gate 3).
// Refuses to start unless cookie encryption is on and the data folder is
// private (outside the repo, outside OneDrive). Clears every synthetic/test
// switch and discards the app's console output, so nothing from real sessions
// is printed. Real credentials are entered only in the app's own window.
// Usage: node scripts/run-app.mjs [--user-data <dir>]   (default C:\ugc-private\ugc-userData)
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const electronPath = createRequire(import.meta.url)('electron');
const args = process.argv.slice(2);
const at = args.indexOf('--user-data');
const userData = resolve(at >= 0 && args[at + 1] ? args[at + 1] : 'C:\\ugc-private\\ugc-userData');

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

const env = { ...process.env, UGC_POC_USER_DATA: userData };
for (const key of Object.keys(env)) if (key === 'NODE_OPTIONS' || key === 'UGC_PLATFORM' || (key.startsWith('UGC_POC_') && key !== 'UGC_POC_USER_DATA')) delete env[key];

console.log(`Starting UGC Production OS with data folder ${userData}. Close the window to finish.`);
const child = spawn(electronPath, [join(desktopDir, 'dist', 'main', 'main.js')], { env, stdio: 'ignore' });
child.on('exit', (code) => {
  console.log(`App closed (exit ${code ?? 0}).`);
  process.exit(0);
});
