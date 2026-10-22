import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  decodeRevisionRecord,
  decodeSessionRestore,
  encodeRevisionRecord,
  encodeSessionRestore,
  importCookieEditorExport,
  restorableSessionCookies,
  SecretValue,
  type NormalizedCookie,
} from '../src/index.js';
import { CANARY_MARKER, SYNTHETIC_DOMAIN, cookieEditorEntry, cookieEditorExport, sessionCookieEntry, syntheticToken } from '../../test-fixtures/src/fixtures.js';

const allowed = [SYNTHETIC_DOMAIN];
const binding = { profileId: randomUUID(), partition: `persist:ps_${randomUUID()}`, platformId: 'synthetic-poc' };
const load = (entries: Record<string, unknown>[]): NormalizedCookie[] => {
  const result = importCookieEditorExport(cookieEditorExport(entries), { allowedDomains: allowed });
  if (!result.ok) throw new Error('fixture import failed');
  return [...result.cookies];
};
const plain = (c: NormalizedCookie) => ({ ...c, value: c.value.reveal() });

describe('restorable session cookies', () => {
  it('keeps only valid in-scope session cookies and counts the rest', () => {
    const cookies = load([
      cookieEditorEntry({ name: 'persistent' }),
      sessionCookieEntry({ name: 'session' }),
      sessionCookieEntry({ name: 'partitioned', partitionKey: { topLevelSite: 'https://ugc-poc.test' } }),
    ]);
    // A live-jar cookie the importer would refuse (e.g. read from another domain) is dropped, not sealed.
    const foreign: NormalizedCookie = { ...cookies[1]!, name: 'foreign', domain: 'example.com', value: new SecretValue('x') };
    const result = restorableSessionCookies([...cookies, foreign], allowed);
    expect(result.cookies.map((c) => c.name)).toEqual(['session']);
    expect(result.dropped).toBe(2);
  });
});

describe('session snapshot payload', () => {
  it('round-trips every attribute and the revision through the importer', () => {
    const cookies = load([
      sessionCookieEntry({ name: 'host', value: syntheticToken('h'), sameSite: 'strict' }),
      sessionCookieEntry({ name: 'dom', domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false, httpOnly: false, sameSite: null, path: '/app' }),
      sessionCookieEntry({ name: 'none', sameSite: 'no_restriction' }),
    ]);
    const decoded = decodeSessionRestore(encodeSessionRestore(binding, 7, cookies), binding, allowed);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.revision).toBe(7);
      expect(decoded.cookies.map(plain)).toEqual(cookies.map(plain));
    }
  });

  it.each([
    ['profile', { profileId: randomUUID() }],
    ['partition', { partition: `persist:ps_${randomUUID()}` }],
    ['platform', { platformId: 'kalodata' }],
  ])('refuses a snapshot bound to another %s', (_label, change) => {
    const text = encodeSessionRestore(binding, 1, load([sessionCookieEntry()]));
    expect(decodeSessionRestore(text, { ...binding, ...change }, allowed)).toEqual({ ok: false, code: 'binding_mismatch' });
  });

  it.each([
    ['not JSON', 'not json', 'malformed'],
    ['an array', '[]', 'malformed'],
    ['version 1 (Gate 1 format)', JSON.stringify({ version: 1, ...binding, cookies: [] }), 'unsupported_version'],
    ['no revision', JSON.stringify({ version: 2, ...binding, cookies: [{}] }), 'invalid_revision'],
    ['revision 0', JSON.stringify({ version: 2, ...binding, revision: 0, cookies: [{}] }), 'invalid_revision'],
    ['no cookies', JSON.stringify({ version: 2, ...binding, revision: 1, cookies: [] }), 'malformed'],
  ])('rejects %s', (_label, text, code) => {
    expect(decodeSessionRestore(text, binding, allowed)).toEqual({ ok: false, code });
  });

  it('rejects the whole snapshot if any cookie fails validation', () => {
    const record = JSON.parse(encodeSessionRestore(binding, 3, load([sessionCookieEntry({ name: 'a' }), sessionCookieEntry({ name: 'b' })])));
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

  it('error results never carry snapshot content', () => {
    const text = encodeSessionRestore(binding, 1, load([sessionCookieEntry({ value: syntheticToken('leak') })]));
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

describe('revision record', () => {
  it('round-trips revision and count, and is bound like the snapshot', () => {
    const text = encodeRevisionRecord(binding, 12, 3);
    expect(decodeRevisionRecord(text, binding)).toEqual({ ok: true, revision: 12, count: 3 });
    expect(decodeRevisionRecord(text, { ...binding, platformId: 'kalodata' })).toEqual({ ok: false, code: 'binding_mismatch' });
    expect(decodeRevisionRecord(encodeSessionRestore(binding, 1, load([sessionCookieEntry()])), binding)).toEqual({ ok: false, code: 'unsupported_version' });
  });

  it('refuses invalid revisions and counts', () => {
    expect(() => encodeRevisionRecord(binding, 0, 1)).toThrow();
    expect(() => encodeRevisionRecord(binding, 1, -1)).toThrow();
    expect(() => encodeSessionRestore(binding, 1.5, [])).toThrow();
    const tampered = JSON.stringify({ ...JSON.parse(encodeRevisionRecord(binding, 2, 1)), count: 'x' });
    expect(decodeRevisionRecord(tampered, binding)).toEqual({ ok: false, code: 'malformed' });
  });
});
