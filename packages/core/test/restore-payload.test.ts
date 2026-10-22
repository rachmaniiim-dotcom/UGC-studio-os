import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decodeSessionRestore, encodeSessionRestore, importCookieEditorExport, restorableSessionCookies, type NormalizedCookie } from '../src/index.js';
import {
  CANARY_MARKER,
  SYNTHETIC_DOMAIN,
  cookieEditorEntry,
  cookieEditorExport,
  sessionCookieEntry,
  syntheticToken,
} from '../../test-fixtures/src/fixtures.js';

const allowed = [SYNTHETIC_DOMAIN];
const binding = { profileId: randomUUID(), partition: `persist:ps_${randomUUID()}` };
const load = (entries: Record<string, unknown>[]): NormalizedCookie[] => {
  const result = importCookieEditorExport(cookieEditorExport(entries), { allowedDomains: allowed });
  if (!result.ok) throw new Error('fixture import failed');
  return [...result.cookies];
};
const plain = (c: NormalizedCookie) => ({ ...c, value: c.value.reveal() });

describe('session restore payload', () => {
  it('keeps only session cookies, and partitioned ones are never kept', () => {
    const cookies = load([
      cookieEditorEntry({ name: 'persistent' }),
      sessionCookieEntry({ name: 'session' }),
      sessionCookieEntry({ name: 'partitioned', partitionKey: { topLevelSite: 'https://ugc-poc.test' } }),
    ]);
    expect(restorableSessionCookies(cookies).map((c) => c.name)).toEqual(['session']);
  });

  it('round-trips every attribute through the importer', () => {
    const cookies = load([
      sessionCookieEntry({ name: 'host', value: syntheticToken('h'), sameSite: 'strict' }),
      sessionCookieEntry({ name: 'dom', domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false, httpOnly: false, sameSite: null, path: '/app' }),
      sessionCookieEntry({ name: 'none', sameSite: 'no_restriction' }),
    ]);
    const decoded = decodeSessionRestore(encodeSessionRestore(binding, cookies), binding, allowed);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.cookies.map(plain)).toEqual(cookies.map(plain));
  });

  it('refuses a record bound to another profile or partition', () => {
    const text = encodeSessionRestore(binding, load([sessionCookieEntry()]));
    expect(decodeSessionRestore(text, { ...binding, profileId: randomUUID() }, allowed)).toEqual({ ok: false, code: 'binding_mismatch' });
    expect(decodeSessionRestore(text, { ...binding, partition: `persist:ps_${randomUUID()}` }, allowed)).toEqual({
      ok: false,
      code: 'binding_mismatch',
    });
  });

  it.each([
    ['not JSON', 'not json', 'malformed'],
    ['an array', '[]', 'malformed'],
    ['no cookies', JSON.stringify({ version: 1, ...binding, cookies: [] }), 'malformed'],
    ['another version', JSON.stringify({ version: 2, ...binding, cookies: [] }), 'unsupported_version'],
  ])('rejects %s', (_label, text, code) => {
    expect(decodeSessionRestore(text, binding, allowed)).toEqual({ ok: false, code });
  });

  it('rejects the whole record if any cookie fails validation', () => {
    const record = JSON.parse(encodeSessionRestore(binding, load([sessionCookieEntry({ name: 'a' }), sessionCookieEntry({ name: 'b' })])));
    for (const tamper of [
      (c: Record<string, unknown>) => (c['domain'] = 'example.com'),
      (c: Record<string, unknown>) => (c['expirationDate'] = 4_000_000_000),
      (c: Record<string, unknown>) => (c['name'] = 'bad;name'),
      (c: Record<string, unknown>) => (c['partitionKey'] = { topLevelSite: 'https://ugc-poc.test' }),
    ]) {
      const copy = structuredClone(record);
      tamper(copy.cookies[1]);
      expect(decodeSessionRestore(JSON.stringify(copy), binding, allowed)).toEqual({ ok: false, code: 'invalid_cookies' });
    }
  });

  it('error results never carry record content', () => {
    const text = encodeSessionRestore(binding, load([sessionCookieEntry({ value: syntheticToken('leak') })]));
    for (const result of [
      decodeSessionRestore(text, { ...binding, profileId: randomUUID() }, allowed),
      decodeSessionRestore(text, binding, ['other.test']),
      decodeSessionRestore(text.slice(0, -5), binding, allowed),
    ]) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(CANARY_MARKER);
    }
  });
});
