#!/usr/bin/env node
// Installs the pinned Electron binary. Electron 44's npm package has no
// postinstall: it downloads lazily on the first require('electron'). The
// root package.json runs this as its postinstall so a fresh `pnpm install`
// leaves a ready binary. Electron's install.js verifies the download against
// the package's checksums.json and does nothing if the binary is already
// present (so it never overwrites a binary flipped by enable-dev-fuses.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('electron/package.json'));
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

const result = spawnSync(process.execPath, [join(pkgDir, 'install.js')], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`Electron ${version} install failed (exit ${result.status}).`);
  process.exit(1);
}

const pathFile = join(pkgDir, 'path.txt');
const binary = existsSync(pathFile) ? join(pkgDir, 'dist', readFileSync(pathFile, 'utf8')) : null;
const installed = existsSync(join(pkgDir, 'dist', 'version')) ? readFileSync(join(pkgDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, '') : null;
if (!binary || !existsSync(binary) || installed !== version) {
  console.error(`Electron ${version} binary missing after install (found ${installed ?? 'none'}).`);
  process.exit(1);
}
console.log(`Electron ${version} binary ready: ${binary}`);
