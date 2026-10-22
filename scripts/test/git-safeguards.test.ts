import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain JS module without types
import { scanPath } from '../check-no-secrets.mjs';
import { CANARY_MARKER, cookieEditorEntry, cookieEditorExport, syntheticToken } from '../../packages/test-fixtures/src/fixtures.js';

// C5: sensitive runtime data stays out of version control (ignore rules) and
// the pre-commit hook blocks it if it is staged anyway.

const SENSITIVE_PATHS = [
  'cookies.json',
  'kalodata-cookies.json',
  'exports/my.cookies.json',
  'notes/cookie-export.txt',
  'capture.har',
  '.env',
  '.env.local',
  'vault/key.bin',
  'ugc-private/kalodata.json',
  'userData/Local State',
  'apps/desktop/userData/poc-profiles.json',
  'session-restore/3f1a.sealed',
  'backup/3f1a.sealed',
  'backup/3f1a.rev',
  'Partitions/ps_x/Network/Cookies',
  'Network/Cookies',
  'Cookies-journal',
  'Local State',
  'Login Data',
  'poc-profiles.json',
  'ugc.db',
  'userData/ugc.db-journal',
  'proxy-secrets/3f1a.proxy',
  'backup/3f1a.proxy',
  'logs/poc.log',
  'debug.log',
  'poc-profiles.json.tmp',
  'security-check-report.json',
];

describe('ignore rules', () => {
  it.each(SENSITIVE_PATHS)('ignores %s', (path) => {
    const r = spawnSync('git', ['check-ignore', '--no-index', '-q', path]);
    expect(r.status, path).toBe(0);
  });

  it('does not ignore source files', () => {
    // packages/core/src/cookies/ guards against a bare "Cookies" rule (git ignores case on Windows).
    for (const path of ['apps/desktop/src/main/session-sync.ts', 'packages/core/src/cookies/import.ts', 'packages/core/src/cookies/new-file.ts', 'docs/RISK_REGISTER.md']) {
      expect(spawnSync('git', ['check-ignore', '--no-index', '-q', path]).status, path).toBe(1);
    }
  });
});

describe('path rules', () => {
  // Everything above except generic runtime files that are only ignored, not session data.
  const notSessionData = new Set(['debug.log', 'poc-profiles.json.tmp', 'security-check-report.json']);
  it.each(SENSITIVE_PATHS.filter((p) => !notSessionData.has(p)))('flags %s', (path) => {
    expect(scanPath(path).length, path).toBeGreaterThan(0);
  });

  it('does not flag source files', () => {
    expect(scanPath('apps/desktop/src/main/electron-cookies.ts')).toEqual([]);
    expect(scanPath('apps/desktop/test/electron-cookies.test.ts')).toEqual([]);
  });
});

describe('pre-commit hook (real git, temporary repository)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ugc-hook-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, '.githooks'));
  copyFileSync('scripts/check-no-secrets.mjs', join(repo, 'scripts', 'check-no-secrets.mjs'));
  copyFileSync('.githooks/pre-commit', join(repo, '.githooks', 'pre-commit'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const [k, v] of [
    ['user.name', 'hook-test'],
    ['user.email', 'hook-test@example.invalid'],
    ['core.hooksPath', '.githooks'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    execFileSync('git', ['config', k, v], { cwd: repo });
  }
  git('add', 'scripts', '.githooks');
  expect(git('commit', '-q', '-m', 'tooling').status).toBe(0);

  it('blocks a staged secret without printing it', () => {
    const token = syntheticToken('hook');
    writeFileSync(join(repo, 'notes.md'), `token: ${token}\n`);
    git('add', 'notes.md');
    const r = git('commit', '-q', '-m', 'leak');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('notes.md: synthetic-canary');
    expect(r.stdout + r.stderr).not.toContain(token);
    git('reset', '-q', 'notes.md');
  });

  it('checks the staged content, not the working tree', () => {
    writeFileSync(join(repo, 'staged.md'), `token: ${syntheticToken('staged')}\n`);
    git('add', 'staged.md');
    writeFileSync(join(repo, 'staged.md'), 'clean now\n');
    expect(git('commit', '-q', '-m', 'staged leak').status).not.toBe(0);
    git('reset', '-q', 'staged.md');
  });

  it('blocks force-added session data even when its content looks harmless', () => {
    mkdirSync(join(repo, 'session-restore'));
    writeFileSync(join(repo, 'session-restore', 'abc.sealed'), 'v10 encrypted bytes');
    writeFileSync(join(repo, 'kalodata-cookies.json'), cookieEditorExport([cookieEditorEntry({ value: 'short' })]));
    git('add', '-f', 'session-restore/abc.sealed', 'kalodata-cookies.json');
    const r = git('commit', '-q', '-m', 'session data');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('session-restore/abc.sealed: sealed-session');
    expect(r.stderr).toContain('kalodata-cookies.json: cookie-export-file');
    git('reset', '-q');
  });

  it('allows an ordinary commit', () => {
    writeFileSync(join(repo, 'README.md'), '# fine\n');
    git('add', 'README.md');
    const r = git('commit', '-q', '-m', 'ok');
    expect(r.status, r.stderr).toBe(0);
    expect(git('log', '--oneline').stdout).not.toContain(CANARY_MARKER);
  });
});
