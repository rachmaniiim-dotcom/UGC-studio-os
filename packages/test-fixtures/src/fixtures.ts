import { randomBytes } from 'node:crypto';

/** Reserved .test TLD: these names never resolve on the public internet. */
export const SYNTHETIC_DOMAIN = 'ugc-poc.test';
export const SYNTHETIC_HOST = `auth.${SYNTHETIC_DOMAIN}`;
export const SESSION_COOKIE = 'poc_session';

/**
 * Every synthetic secret contains this marker so leak tests can search logs,
 * databases, IPC payloads and the repository for it.
 */
export const CANARY_MARKER = 'SYNTHETICCANARY';

export function syntheticToken(label: string): string {
  return `${CANARY_MARKER}_${label}_${randomBytes(12).toString('hex')}`;
}

export type CookieEditorEntry = Record<string, unknown>;

const DAY = 24 * 60 * 60;

/**
 * One cookie in the shape Cookie-Editor 1.13 exports from Chrome: the
 * chrome.cookies.Cookie object with storeId set to null and an
 * "unspecified" sameSite written as null.
 */
export function cookieEditorEntry(overrides: CookieEditorEntry = {}): CookieEditorEntry {
  return {
    domain: SYNTHETIC_HOST,
    expirationDate: Math.floor(Date.now() / 1000) + 30 * DAY + 0.5,
    hostOnly: true,
    httpOnly: true,
    name: SESSION_COOKIE,
    path: '/',
    sameSite: 'lax',
    secure: true,
    session: false,
    storeId: null,
    value: syntheticToken('default'),
    ...overrides,
  };
}

/** A session cookie as Cookie-Editor exports it: no expirationDate. */
export function sessionCookieEntry(overrides: CookieEditorEntry = {}): CookieEditorEntry {
  const entry = cookieEditorEntry({ session: true, ...overrides });
  delete entry['expirationDate'];
  return entry;
}

export function cookieEditorExport(entries: readonly CookieEditorEntry[]): string {
  return JSON.stringify(entries, null, 4);
}
