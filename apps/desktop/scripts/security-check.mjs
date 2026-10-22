#!/usr/bin/env node
// Local security check (C4): starts the app in --security-check mode, which
// reads the profiles' cookie values in memory and searches userData (and any
// --scan folders) for them. Prints sanitized findings only: counts, profile
// labels and file paths, never cookie names or values. Close the app first.
// Usage: node scripts/security-check.mjs [--user-data <dir>] [--scan <dir>]... [--json] [--electron <exe>]
// Exit code: 0 pass, 1 findings, 2 could not run.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
// --electron <exe> runs the check with another Electron binary (tests use fuse-on/off copies).
const electronPath = valueOf('--electron')[0] ?? createRequire(import.meta.url)('electron');

const env = { ...process.env };
delete env.NODE_OPTIONS;
const [userData] = valueOf('--user-data');
if (userData) env.UGC_POC_USER_DATA = resolve(userData);
const scans = valueOf('--scan').flatMap((dir) => ['--scan', resolve(dir)]);

const child = spawn(electronPath, [join(desktopDir, 'dist', 'main', 'main.js'), '--security-check', ...scans], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.resume(); // Chromium diagnostics are not part of the report.
child.on('exit', (code) => {
  const line = out.split(/\r?\n/).find((l) => l.startsWith('UGC_SECURITY_CHECK '));
  if (!line) {
    console.error(`Security check did not produce a report (exit ${code}).`);
    process.exit(2);
  }
  const report = JSON.parse(line.slice('UGC_SECURITY_CHECK '.length));
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.result === 'error') {
    console.error(`Security check could not run: ${report.error}`);
  } else {
    const env = report.environment;
    console.log(`Security check: ${report.result.toUpperCase()} (${report.summary.findings} finding(s), ${report.summary.high} high)`);
    console.log(`  cookie encryption fuse: ${env.cookieEncryptionFuse}; OS protected storage: ${env.protectedStorage}`);
    for (const p of report.profiles) {
      const db = p.cookieDb ? `${p.cookieDb.rows} DB rows, ${p.cookieDb.plaintextRows} plaintext, prefixes ${JSON.stringify(p.cookieDb.prefixes)}` : 'no cookie DB';
      console.log(`  ${p.label} [${p.platformId}]: ${p.jarCookies} cookies in jar; ${db}; snapshot ${p.snapshot}; ${p.needles} values searched, ${p.skippedShort} too short`);
    }
    const s = report.scan;
    console.log(`  scanned ${s.files} files (${(s.bytes / 1048576).toFixed(1)} MB) in ${s.roots} root(s); ${s.unreadable} unreadable, ${s.skippedLarge} too large`);
    for (const f of report.findings) console.log(`  FINDING [${f.severity}] ${f.check} x${f.count}${f.where ? ` at ${f.where}` : ''}`);
  }
  process.exit(code ?? 2);
});
