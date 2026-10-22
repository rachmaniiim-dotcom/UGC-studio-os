import type { Cookie, CookiesSetDetails, Session } from 'electron';
import { SecretValue, type NormalizedCookie, type SameSite } from '@ugc/core';

export type BrowserLoadIssue = 'unsupported_partitioned' | 'rejected_by_browser';

const SAME_SITE: Record<SameSite, NonNullable<CookiesSetDetails['sameSite']>> = {
  strict: 'strict',
  lax: 'lax',
  none: 'no_restriction',
  unspecified: 'unspecified',
};

const SAME_SITE_IN: Record<Cookie['sameSite'], SameSite> = {
  strict: 'strict',
  lax: 'lax',
  no_restriction: 'none',
  unspecified: 'unspecified',
};

/**
 * Converts a cookie read from Electron's jar into a normalized session
 * cookie, or null if it has an expiry (Chromium persists those itself).
 * The value is wrapped in SecretValue at once.
 */
export function fromElectronSessionCookie(c: Cookie): NormalizedCookie | null {
  if (!c.session || c.expirationDate !== undefined || !c.domain) return null;
  const hostOnly = c.hostOnly ?? !c.domain.startsWith('.');
  return {
    name: c.name,
    value: new SecretValue(c.value),
    domain: c.domain.replace(/^\./, '').toLowerCase(),
    hostOnly,
    path: c.path ?? '/',
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: SAME_SITE_IN[c.sameSite],
    expiresAt: null,
  };
}

/**
 * Converts a normalized cookie into Electron's cookies.set() details.
 * Host-only cookies omit `domain` (Electron then scopes them to the URL host).
 * Electron 44's cookies.set() has no partition key, so partitioned (CHIPS)
 * cookies are refused rather than silently stored unpartitioned.
 */
export function toElectronCookie(
  cookie: NormalizedCookie,
): { ok: true; details: CookiesSetDetails } | { ok: false; code: BrowserLoadIssue } {
  if (cookie.partitionKey) return { ok: false, code: 'unsupported_partitioned' };
  const details: CookiesSetDetails = {
    url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`,
    name: cookie.name,
    value: cookie.value.reveal(),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: SAME_SITE[cookie.sameSite],
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    ...(cookie.expiresAt === null ? {} : { expirationDate: cookie.expiresAt }),
  };
  return { ok: true, details };
}

export interface LoadResult {
  readonly loaded: number;
  /** The cookies the browser accepted. Holds secrets: never log or return to a renderer. */
  readonly cookies: readonly NormalizedCookie[];
  readonly failures: Partial<Record<BrowserLoadIssue, number>>;
}

/** Replaces all cookies in a partition with `cookies`, then flushes them to disk. */
export async function replaceCookies(ses: Session, cookies: readonly NormalizedCookie[]): Promise<LoadResult> {
  await ses.clearStorageData({ storages: ['cookies'] });
  const accepted: NormalizedCookie[] = [];
  const failures: Partial<Record<BrowserLoadIssue, number>> = {};
  for (const cookie of cookies) {
    const converted = toElectronCookie(cookie);
    if (!converted.ok) {
      failures[converted.code] = (failures[converted.code] ?? 0) + 1;
      continue;
    }
    try {
      await ses.cookies.set(converted.details);
      accepted.push(cookie);
    } catch {
      // Chromium's own rejection message can echo cookie content; keep only the code.
      failures.rejected_by_browser = (failures.rejected_by_browser ?? 0) + 1;
    }
  }
  await ses.cookies.flushStore();
  return { loaded: accepted.length, cookies: accepted, failures };
}
