#!/usr/bin/env node
// Scans files for things that must never be committed: synthetic canaries,
// cookie exports, private keys, credential-shaped strings, and paths that
// hold browser or session data. Never prints the matched content.
// Usage: node scripts/check-no-secrets.mjs           (tracked + untracked, not ignored)
//        node scripts/check-no-secrets.mjs --staged  (the staged blobs; used by the pre-commit hook)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RULES = [
  { id: 'synthetic-canary', pattern: /SYNTHETICCANARY_[A-Za-z0-9]/ },
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'cookie-editor-export', pattern: /"hostOnly"\s*:\s*(true|false)\s*,[\s\S]{0,400}"value"\s*:\s*"[^"]{16,}"/ },
  { id: 'cookie-header', pattern: /^\s*cookie:\s*[^\s=]+=[^\s;]{16,}/im },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

// Paths that hold session exports, browser profiles, sealed snapshots or runtime data.
// They are also in .gitignore; this catches `git add -f` and renamed copies.
export const PATH_RULES = [
  { id: 'cookie-export-file', pattern: /(^|\/)[^/]*cookie[^/]*\.(json|txt)$/i },
  { id: 'har-file', pattern: /\.har$/i },
  { id: 'env-file', pattern: /(^|\/)\.env(\.|$)/ },
  { id: 'sealed-session', pattern: /\.(sealed|rev)$/ },
  { id: 'session-restore-dir', pattern: /(^|\/)session-restore\// },
  { id: 'browser-profile', pattern: /(^|\/)(userData|Partitions|vault|ugc-private)\// },
  { id: 'chromium-state', pattern: /(^|\/)(Cookies|Cookies-journal|Local State|Login Data|Web Data|Preferences)$/ },
  { id: 'profile-metadata', pattern: /(^|\/)(poc-profiles\.json(\.migrated)?|ugc\.db(-journal|-wal)?)$/ },
  { id: 'proxy-credentials', pattern: /(^|\/)proxy-secrets\/|\.proxy$/ },
  { id: 'app-log', pattern: /(^|\/)logs\/[^/]*\.log$/ },
  { id: 'video-or-library', pattern: /(^|\/)library\/|\.(mp4|mp4\.part|mov|webm)$/i },
];

// Files that legitimately contain the patterns as patterns.
const ALLOW = new Set(['scripts/check-no-secrets.mjs', 'scripts/test/check-no-secrets.test.ts', 'scripts/test/git-safeguards.test.ts']);

export function scanText(text) {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

export function scanPath(path) {
  return PATH_RULES.filter((rule) => rule.pattern.test(path)).map((rule) => rule.id);
}

function files(staged) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

/** Staged mode reads the blob in the index, which is what the commit will contain. */
function content(file, staged) {
  return staged ? execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 }) : readFileSync(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const staged = process.argv.includes('--staged');
  const findings = [];
  for (const file of files(staged)) {
    for (const id of scanPath(file)) findings.push(`${file}: ${id}`);
    if (ALLOW.has(file)) continue;
    let text;
    try {
      text = content(file, staged).toString('utf8');
    } catch {
      continue;
    }
    for (const id of scanText(text)) findings.push(`${file}: ${id}`);
  }
  if (findings.length) {
    console.error(`Possible secrets or session data${staged ? ' staged for commit' : ''} (values not shown):\n${findings.join('\n')}`);
    if (staged) console.error('Commit blocked. Unstage these files (git restore --staged <file>).');
    process.exit(1);
  }
  console.log('No secrets found.');
}
