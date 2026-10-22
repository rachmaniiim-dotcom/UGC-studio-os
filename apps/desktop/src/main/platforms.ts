import { validatePlatformDefinition, type PlatformDefinition } from '@ugc/core';
import type { RuntimeConfig } from './config.js';

/**
 * Built-in platform definitions. They are reviewed source data, validated at
 * startup; there is no user-editable definition file (see core
 * platforms/definition.ts).
 */

export const SYNTHETIC_PLATFORM_ID = 'synthetic-poc';

/**
 * Kalodata (provisional, Gate 2 preparation). The login runs on a separate
 * domain (login.kalowave.com), so the account's cookies may span both
 * domains; the Gate 2 import's domain census (E1) must confirm this list
 * before it is relied on.
 *
 * Authorization: Kalodata's Terms of Service (2026-04-16) §4.1.8 restrict
 * automated scripts that collect information from or interact with the
 * service, and §14.3–14.6 restrict system integration, persistent datasets
 * and AI/ML use of the data. No written permission is on record (R-03,
 * R-03b), so: no automated requests at all (status is owner-confirmed only)
 * and no AI use of the data.
 */
export const KALODATA: PlatformDefinition = {
  id: 'kalodata',
  displayName: 'Kalodata',
  cookieDomains: ['kalodata.com', 'kalowave.com'],
  navigationDomains: ['kalodata.com', 'kalowave.com'],
  pages: { home: 'https://www.kalodata.com/' },
  statusCheck: { kind: 'manual' },
  authorization: {
    automation: 'not_permitted',
    aiDataUse: 'not_permitted',
    basis: 'Kalodata Terms of Service (2026-04-16) §4.1.8, §14.3–14.6; no written permission on record (R-03, R-03b)',
  },
  accountBoundary: 'one_account_per_profile',
};

function syntheticPlatform(origin: string, manualStatus: boolean): PlatformDefinition {
  return {
    id: SYNTHETIC_PLATFORM_ID,
    displayName: manualStatus ? 'Synthetic site (manual status)' : 'Synthetic site',
    cookieDomains: ['ugc-poc.test'],
    navigationDomains: ['ugc-poc.test'],
    pages: {
      home: `${origin}/`,
      strict: `${origin}/strict`,
      'interactive-login': `${origin}/interactive-login`,
      rotate: `${origin}/rotate`,
      logout: `${origin}/logout`,
      'basic-auth': `${origin}/basic-auth`,
    },
    statusCheck: manualStatus ? { kind: 'manual' } : { kind: 'probe', path: '/whoami' },
    authorization: manualStatus
      ? { automation: 'not_permitted', aiDataUse: 'not_permitted', basis: 'Synthetic stand-in for a platform that forbids automation' }
      : { automation: 'permitted', aiDataUse: 'not_permitted', basis: 'Local synthetic test site; no real service' },
    accountBoundary: 'one_account_per_profile',
  };
}

export class InvalidPlatformDefinition extends Error {
  constructor(id: string, issues: readonly string[]) {
    super(`platform definition ${id} is invalid: ${issues.join(', ')}`);
  }
}

/**
 * Returns this run's validated platform, or null when none is configured.
 * Throws if a definition is invalid: the app must not start with a bad scope.
 */
export function resolvePlatform(config: RuntimeConfig): PlatformDefinition | null {
  let platform: PlatformDefinition | null = null;
  if (config.platformId === SYNTHETIC_PLATFORM_ID) {
    // Synthetic mode only; the origin carries the test server's port.
    platform = config.synthetic && config.siteOrigin ? syntheticPlatform(config.siteOrigin, config.syntheticManualStatus) : null;
  } else if (config.platformId === KALODATA.id && !config.synthetic) {
    platform = KALODATA;
  }
  if (platform) {
    const issues = validatePlatformDefinition(platform);
    if (issues.length > 0) throw new InvalidPlatformDefinition(platform.id, issues);
  }
  return platform;
}

/**
 * Cookie domains for a profile's platform without the runtime config (used by
 * the security check). Unknown platforms get none, so nothing of theirs validates.
 */
export function cookieDomainsFor(platformId: string): readonly string[] {
  if (platformId === SYNTHETIC_PLATFORM_ID) return ['ugc-poc.test'];
  if (platformId === KALODATA.id) return KALODATA.cookieDomains;
  return [];
}

/** The base URL a probe path is resolved against: the origin of the platform's home page. */
export function platformOrigin(platform: PlatformDefinition): string {
  return new URL(platform.pages['home'] ?? Object.values(platform.pages)[0]!).origin;
}
