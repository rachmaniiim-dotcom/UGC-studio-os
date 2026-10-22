import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { importCookieEditorExport, type ImportOptions } from '../src/index.js';
import {
  CANARY_MARKER,
  SYNTHETIC_DOMAIN,
  SYNTHETIC_HOST,
  cookieEditorEntry,
  cookieEditorExport,
  sessionCookieEntry,
  syntheticToken,
} from '../../test-fixtures/src/fixtures.js';

const opts: ImportOptions = { allowedDomains: [SYNTHETIC_DOMAIN] };
const run = (entries: Record<string, unknown>[], o: Partial<ImportOptions> = {}) =>
  importCookieEditorExport(cookieEditorExport(entries), { ...opts, ...o });
const codeOf = (entries: Record<string, unknown>[]) => run(entries).report.entries[0]?.code;

describe('format detection', () => {
  it('accepts the Cookie-Editor Chrome JSON export', () => {
    const result = run([cookieEditorEntry()]);
    expect(result.ok).toBe(true);
    expect(result.report.format).toBe('cookie-editor-json');
    expect(result.report.imported).toBe(1);
  });

  it.each([
    ['netscape', `# Netscape HTTP Cookie File\n${SYNTHETIC_HOST}\tFALSE\t/\tTRUE\t0\tpoc_session\tabc`],
    ['header-string', 'poc_session=abc; other=def'],
    ['json-unrecognized', JSON.stringify({ cookies: [cookieEditorEntry()] })],
    ['json-unrecognized', JSON.stringify([1, 2, 3])],
    ['unknown', 'hello world, this is not cookies'],
  ])('rejects %s input with unsupported_format', (format, text) => {
    const result = importCookieEditorExport(text, opts);
    expect(result.ok).toBe(false);
    expect(result.report.format).toBe(format);
    expect(result.report.fileError).toBe('unsupported_format');
    expect(result.cookies).toHaveLength(0);
  });

  it('rejects the Firefox variant (firstPartyDomain present) as unsupported in this build', () => {
    const result = run([cookieEditorEntry({ firstPartyDomain: '' })]);
    expect(result.report.format).toBe('cookie-editor-json-firefox');
    expect(result.report.fileError).toBe('unsupported_format');
  });

  it.each([
    ['invalid_json', '[{"name": '],
    ['empty', ''],
    ['empty', '[]'],
  ])('fails safely with %s', (fileError, text) => {
    const result = importCookieEditorExport(text, opts);
    expect(result.ok).toBe(false);
    expect(result.report.fileError).toBe(fileError);
  });

  it('enforces file size and cookie count limits', () => {
    expect(run([cookieEditorEntry()], { maxBytes: 10 }).report.fileError).toBe('file_too_large');
    expect(run([cookieEditorEntry(), cookieEditorEntry({ name: 'b' })], { maxCookies: 1 }).report.fileError).toBe('too_many_cookies');
  });

  it('rejects non-UTF-8 bytes and strips a UTF-8 BOM', () => {
    expect(importCookieEditorExport(new Uint8Array([0x5b, 0xff, 0x5d]), opts).report.fileError).toBe('not_utf8');
    const withBom = new TextEncoder().encode('﻿' + cookieEditorExport([cookieEditorEntry()]));
    expect(importCookieEditorExport(withBom, opts).report.imported).toBe(1);
  });
});

describe('normalization', () => {
  it('normalizes a host-only cookie', () => {
    const [cookie] = run([cookieEditorEntry({ domain: 'AUTH.UGC-POC.TEST' })]).cookies;
    expect(cookie).toMatchObject({ domain: SYNTHETIC_HOST, hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    expect(typeof cookie?.expiresAt).toBe('number');
  });

  it('normalizes a domain cookie and strips the leading dot', () => {
    const [cookie] = run([cookieEditorEntry({ domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false })]).cookies;
    expect(cookie).toMatchObject({ domain: SYNTHETIC_DOMAIN, hostOnly: false });
  });

  it('maps sameSite values without loosening them', () => {
    const sameSiteOf = (v: unknown) => run([cookieEditorEntry({ sameSite: v })]).cookies[0]?.sameSite;
    expect(sameSiteOf('no_restriction')).toBe('none');
    expect(sameSiteOf('strict')).toBe('strict');
    expect(sameSiteOf('lax')).toBe('lax');
    expect(sameSiteOf(null)).toBe('unspecified'); // Cookie-Editor writes "unspecified" as null
    expect(sameSiteOf('unspecified')).toBe('unspecified');
    expect(codeOf([cookieEditorEntry({ sameSite: 'None' })])).toBe('invalid_same_site');
  });

  it('keeps session semantics', () => {
    const [cookie] = run([sessionCookieEntry()]).cookies;
    expect(cookie?.expiresAt).toBeNull();
  });

  it('preserves a valid partition key', () => {
    const [cookie] = run([cookieEditorEntry({ partitionKey: { topLevelSite: 'https://ugc-poc.test', hasCrossSiteAncestor: false } })]).cookies;
    expect(cookie?.partitionKey).toEqual({ topLevelSite: 'https://ugc-poc.test', hasCrossSiteAncestor: false });
  });

  it('counts unknown fields without importing them', () => {
    const result = run([cookieEditorEntry({ extra: 1, another: 'x' })]);
    expect(result.report.ignoredFieldCount).toBe(2);
    expect(Object.keys(result.cookies[0] ?? {})).not.toContain('extra');
  });

  it('is not affected by __proto__ keys in the input', () => {
    const text = cookieEditorExport([cookieEditorEntry()]).replace('"name"', '"__proto__": {"polluted": true}, "name"');
    const result = importCookieEditorExport(text, opts);
    expect(result.report.imported).toBe(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('per-cookie validation', () => {
  it.each<[string, Record<string, unknown>]>([
    ['missing_attribute', { secure: undefined }],
    ['invalid_name', { name: '' }],
    ['invalid_name', { name: 'a;b' }],
    ['invalid_name', { name: ' padded' }],
    ['invalid_value', { value: 42 }],
    ['invalid_value', { value: 'abc\ndef' }],
    ['invalid_value', { value: 'a;b' }],
    ['cookie_too_large', { value: 'x'.repeat(5000) }],
    ['invalid_flag', { secure: 'true' }],
    ['invalid_flag', { session: 'no' }],
    ['invalid_domain', { domain: 'localhost' }],
    ['invalid_domain', { domain: 'bad_domain.ugc-poc.test' }],
    ['invalid_domain', { domain: 7 }],
    ['domain_out_of_scope', { domain: 'example.com' }],
    ['domain_out_of_scope', { domain: 'ugc-poc.test.evil.com' }],
    ['domain_out_of_scope', { domain: 'notugc-poc.test' }],
    ['invalid_domain', { domain: '.test', hostOnly: false }],
    ['inconsistent_host_only', { domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: true }],
    ['invalid_path', { path: 'relative' }],
    ['invalid_expiration', { expirationDate: 'tomorrow' }],
    ['invalid_expiration', { expirationDate: -5 }],
    ['inconsistent_session', { session: true }],
    ['same_site_none_requires_secure', { sameSite: 'no_restriction', secure: false }],
    ['secure_prefix_violation', { name: '__Secure-id', secure: false }],
    ['host_prefix_violation', { name: '__Host-id', hostOnly: false, domain: `.${SYNTHETIC_DOMAIN}` }],
    ['host_prefix_violation', { name: '__host-id', path: '/app' }],
    ['invalid_partition_key', { partitionKey: { topLevelSite: 'http://ugc-poc.test' } }],
    ['invalid_partition_key', { partitionKey: { topLevelSite: 'https://ugc-poc.test' }, secure: false, sameSite: 'lax' }],
  ])('rejects %s (%o)', (code, overrides) => {
    const entry = cookieEditorEntry(overrides);
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete entry[k];
    const result = run([entry]);
    expect(result.report.entries[0]).toEqual({ index: 0, disposition: 'rejected', code });
    expect(result.cookies).toHaveLength(0);
  });

  it('rejects a cookie set on a parent of the allowed domain', () => {
    const result = run([cookieEditorEntry({ domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false })], { allowedDomains: [SYNTHETIC_HOST] });
    expect(result.report.entries[0]?.code).toBe('domain_out_of_scope');
  });

  it('rejects a non-object entry and keeps going', () => {
    const result = run(['oops' as unknown as Record<string, unknown>, cookieEditorEntry()]);
    expect(result.report.entries.map((e) => e.disposition)).toEqual(['rejected', 'imported']);
    expect(result.report.entries[0]?.code).toBe('not_an_object');
  });

  it('rejects a session:false cookie with no expiration', () => {
    const entry = cookieEditorEntry();
    delete entry['expirationDate'];
    expect(codeOf([entry])).toBe('inconsistent_session');
  });

  it('skips expired cookies', () => {
    const result = run([cookieEditorEntry({ expirationDate: 1000 })]);
    expect(result.report.entries[0]).toEqual({ index: 0, disposition: 'skipped', code: 'expired' });
    expect(result.ok).toBe(false);
  });

  it('evaluates expiry against the provided clock', () => {
    const expiry = 2_000_000_000;
    expect(run([cookieEditorEntry({ expirationDate: expiry })], { now: new Date((expiry - 1) * 1000) }).report.imported).toBe(1);
    expect(run([cookieEditorEntry({ expirationDate: expiry })], { now: new Date(expiry * 1000) }).report.skipped).toBe(1);
  });
});

describe('duplicate policy', () => {
  it('collapses exact duplicates to one cookie', () => {
    const entry = cookieEditorEntry();
    const result = run([entry, { ...entry }]);
    expect(result.cookies).toHaveLength(1);
    expect(result.report.entries).toEqual([
      { index: 0, disposition: 'imported' },
      { index: 1, disposition: 'skipped', code: 'exact_duplicate' },
    ]);
  });

  it('rejects every entry of a conflicting duplicate group, without choosing one', () => {
    const a = cookieEditorEntry({ value: syntheticToken('a') });
    const b = cookieEditorEntry({ value: syntheticToken('b'), expirationDate: (a['expirationDate'] as number) + 1000 });
    const other = cookieEditorEntry({ name: 'unrelated' });
    const result = run([a, other, b]);
    expect(result.cookies.map((c) => c.name)).toEqual(['unrelated']);
    expect(result.report.entries).toEqual([
      { index: 0, disposition: 'rejected', code: 'conflicting_duplicate' },
      { index: 1, disposition: 'imported' },
      { index: 2, disposition: 'rejected', code: 'conflicting_duplicate' },
    ]);
    expect(result.report.conflictingDuplicateGroups).toEqual([[0, 2]]);
    expect(result.report.messages.join(' ')).toContain('Entries #1, #3 describe the same cookie');
  });

  it('treats attribute-only differences as conflicts', () => {
    const a = cookieEditorEntry();
    expect(run([a, { ...a, httpOnly: false }]).report.rejected).toBe(2);
  });

  it('treats host-only and domain cookies with the same name as distinct cookies', () => {
    const host = cookieEditorEntry();
    const domain = cookieEditorEntry({ domain: `.${SYNTHETIC_HOST}`, hostOnly: false, value: syntheticToken('d') });
    expect(run([host, domain]).report.imported).toBe(2);
  });

  it('ignores an expired copy when looking for conflicts', () => {
    const live = cookieEditorEntry();
    const expired = { ...live, value: syntheticToken('old'), expirationDate: 1000 };
    const result = run([live, expired]);
    expect(result.report.imported).toBe(1);
    expect(result.report.skipped).toBe(1);
  });
});

describe('secrecy of results', () => {
  it('never exposes values in the report, serialized cookies or inspect output', () => {
    const secret = syntheticToken('leakcheck');
    const result = run([
      cookieEditorEntry({ value: secret }),
      cookieEditorEntry({ name: 'dup', value: syntheticToken('x') }),
      cookieEditorEntry({ name: 'dup', value: syntheticToken('y') }),
      cookieEditorEntry({ name: 'bad', domain: 'example.com', value: syntheticToken('z') }),
    ]);
    const surfaces = [JSON.stringify(result.report), JSON.stringify(result.cookies), inspect(result, { depth: 10 }), String(result.cookies[0]?.value)];
    for (const surface of surfaces) expect(surface).not.toContain(CANARY_MARKER);
    expect(result.cookies[0]?.value.reveal()).toBe(secret);
  });

  it('keeps cookie names out of the report', () => {
    const result = run([cookieEditorEntry({ name: 'very_specific_cookie_name' })]);
    expect(JSON.stringify(result.report)).not.toContain('very_specific_cookie_name');
  });
});
