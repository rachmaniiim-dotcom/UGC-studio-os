#!/usr/bin/env node
// Points this clone's git hooks at .githooks/ (pre-commit secret scan, C5).
// Runs from the root postinstall; does nothing outside a git work tree.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
try {
  if (git('rev-parse', '--is-inside-work-tree') !== 'true') process.exit(0);
} catch {
  process.exit(0);
}
let current = '';
try {
  current = git('config', '--get', 'core.hooksPath');
} catch {
  // Not set (git exits 1).
}
if (current.replace(/\/$/, '') !== '.githooks') {
  git('config', 'core.hooksPath', '.githooks');
}
console.log('Git hooks: .githooks (pre-commit secret scan) active.');
