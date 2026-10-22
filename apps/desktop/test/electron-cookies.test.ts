import { describe, expect, it } from 'vitest';
import { importCookieEditorExport } from '@ugc/core';
import { SYNTHETIC_DOMAIN, SYNTHETIC_HOST, cookieEditorEntry, cookieEditorExport, sessionCookieEntry } from '../../../packages/test-fixtures/src/fixtures.js';
import { toElectronCookie } from '../src/main/electron-cookies.js';

const normalize = (entry: Record<string, unknown>) => {
  const [cookie] = importCookieEditorExport(cookieEditorExport([entry]), { allowedDomains: [SYNTHETIC_DOMAIN] }).cookies;
  if (!cookie) throw new Error('fixture did not import');
  return cookie;
};

describe('toElectronCookie', () => {
  it('maps a host-only cookie without a domain field', () => {
    const entry = cookieEditorEntry({ value: 'v1' });
    const result = toElectronCookie(normalize(entry));
    expect(result).toEqual({
      ok: true,
      details: {
        url: `https://${SYNTHETIC_HOST}/`,
        name: 'poc_session',
        value: 'v1',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: entry['expirationDate'],
      },
    });
  });

  it('maps a domain cookie with its domain and SameSite=None as no_restriction', () => {
    const result = toElectronCookie(normalize(cookieEditorEntry({ domain: `.${SYNTHETIC_DOMAIN}`, hostOnly: false, sameSite: 'no_restriction', path: '/app' })));
    expect(result.ok && result.details).toMatchObject({ url: `https://${SYNTHETIC_DOMAIN}/app`, domain: SYNTHETIC_DOMAIN, sameSite: 'no_restriction' });
  });

  it('omits expirationDate for session cookies and keeps unspecified SameSite', () => {
    const result = toElectronCookie(normalize(sessionCookieEntry({ sameSite: null })));
    expect(result.ok && 'expirationDate' in result.details).toBe(false);
    expect(result.ok && result.details.sameSite).toBe('unspecified');
  });

  it('uses an http URL for non-secure cookies so Chromium accepts them', () => {
    const result = toElectronCookie(normalize(cookieEditorEntry({ secure: false })));
    expect(result.ok && result.details.url).toBe(`http://${SYNTHETIC_HOST}/`);
  });

  it('refuses partitioned cookies instead of storing them unpartitioned', () => {
    expect(toElectronCookie(normalize(cookieEditorEntry({ partitionKey: { topLevelSite: 'https://ugc-poc.test' } })))).toEqual({
      ok: false,
      code: 'unsupported_partitioned',
    });
  });
});
