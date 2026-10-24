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

describe('applyCookies (session restore and import)', () => {
  it('a cookie the browser refuses is skipped and counted; the others stay set and nothing is removed', async () => {
    const { applyCookies } = await import('../src/main/electron-cookies.js');
    const cookies = ['a', 'refuse-me', 'b'].map((name) => normalize(cookieEditorEntry({ name, value: `v-${name}` })));
    const set: string[] = [];
    let removed = 0;
    const ses = {
      cookies: {
        set: async (d: { name?: string }) => {
          if (d.name === 'refuse-me') throw new Error('Failed to set cookie (content may be echoed here)');
          set.push(d.name ?? '');
        },
        remove: async () => {
          removed++;
        },
      },
    } as unknown as Parameters<typeof applyCookies>[0];
    const r = await applyCookies(ses, cookies);
    expect(r.loaded).toBe(2);
    expect(r.cookies.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.failures).toEqual({ rejected_by_browser: 1 });
    expect(set).toEqual(['a', 'b']);
    expect(removed).toBe(0);
    // The browser's own message (which can echo cookie content) is not kept anywhere in the result.
    expect(JSON.stringify(r.failures)).not.toContain('echoed');
  });
});
