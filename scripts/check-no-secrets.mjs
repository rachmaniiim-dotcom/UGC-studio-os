#!/usr/bin/env node
// Scans files tracked by git for things that must never be committed:
// synthetic canaries, cookie exports, private keys and credential-shaped strings.
// Usage: node scripts/check-no-secrets.mjs [--staged]
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

// Files that legitimately contain the patterns as patterns.
const ALLOW = new Set(['scripts/check-no-secrets.mjs', 'scripts/test/check-no-secrets.test.ts']);

export function scanText(text) {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

function trackedFiles(staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'] : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = [];
  for (const file of trackedFiles(process.argv.includes('--staged'))) {
    if (ALLOW.has(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const id of scanText(text)) findings.push(`${file}: ${id}`);
  }
  if (findings.length) {
    console.error(`Possible secrets found (values not shown):\n${findings.join('\n')}`);
    process.exit(1);
  }
  console.log('No secrets found.');
}
