import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
// @ts-expect-error plain JS module without types
import { scanText } from '../check-no-secrets.mjs';

describe('secret scanner', () => {
  it.each([
    ['synthetic-canary', 'value: SYNTHETICCANARY_a_123'],
    ['private-key', '-----BEGIN EC PRIVATE KEY-----\nabc'],
    ['cookie-editor-export', '{"domain": ".x.com", "hostOnly": false, "name": "sid", "value": "abcdefghijklmnopqrstuvwxyz"}'],
    ['cookie-header', 'Cookie: sid=abcdefghijklmnopqrstuvwxyz'],
    ['bearer-token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'],
  ])('flags %s', (id, text) => {
    expect(scanText(text)).toContain(id);
  });

  it('does not flag ordinary code', () => {
    expect(scanText("const cookie = { name: 'poc_session', value: token };")).toEqual([]);
  });

  it('finds nothing in the repository', () => {
    expect(() => execFileSync('node', ['scripts/check-no-secrets.mjs'], { stdio: 'pipe' })).not.toThrow();
  });
});
