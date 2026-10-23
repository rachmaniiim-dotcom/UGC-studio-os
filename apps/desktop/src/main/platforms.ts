import { BUNDLE_PLATFORMS, validatePlatformDefinition, type PlatformDefinition } from '@ugc/core';
import type { RuntimeConfig } from './config.js';

/**
 * Built-in platform definitions. They are reviewed source data, validated at
 * startup; there is no user-editable definition file (see core
 * platforms/definition.ts). Domain lists are provisional until confirmed by a
 * real import's domain census, and none of these platforms has automation or
 * AI data use authorized: status is confirmed by the owner, and the app sends
 * nothing to them on its own.
 */

export const SYNTHETIC_PLATFORM_ID = 'synthetic-poc';

const MANUAL_ONLY = (basis: string) =>
  ({ statusCheck: { kind: 'manual' }, authorization: { automation: 'not_permitted', aiDataUse: 'not_permitted', basis } }) as const;

/**
 * Kalodata. The login runs on a separate domain (login.kalowave.com), so the
 * account's cookies may span both domains. Terms of Service (2026-04-16)
 * §4.1.8 restrict automated interaction; §14.3–14.6 restrict integration,
 * persistent datasets and AI use (R-03, R-03b, D14, D16).
 */
export const KALODATA: PlatformDefinition = {
  id: 'kalodata',
  displayName: 'Kalodata',
  cookieDomains: ['kalodata.com', 'kalowave.com'],
  navigationDomains: ['kalodata.com', 'kalowave.com'],
  pages: { home: 'https://www.kalodata.com/' },
  ...MANUAL_ONLY('Kalodata Terms of Service (2026-04-16) §4.1.8, §14.3–14.6; no written permission on record (R-03, R-03b)'),
  accountBoundary: 'one_account_per_profile',
};

/**
 * TikTok (incl. TikTok Shop seller pages on subdomains). In Indonesia, TikTok Shop product pages
 * (tiktok.com/view/product/<id>) redirect to Tokopedia (shop-id.tokopedia.com/pdp/<id>; observed
 * 2026-10-23), so the window may follow them there. Session backup stays on tiktok.com cookies.
 * Publishing, Showcase and yellow-basket automation are later gates.
 */
export const TIKTOK: PlatformDefinition = {
  id: 'tiktok',
  displayName: 'TikTok',
  cookieDomains: ['tiktok.com'],
  navigationDomains: ['tiktok.com', 'tokopedia.com'],
  pages: { home: 'https://www.tiktok.com/' },
  ...MANUAL_ONLY('No TikTok automation approved yet (publishing, Showcase, yellow basket are later gates; R-01, R-04)'),
  accountBoundary: 'one_account_per_profile',
};

/** Google Flow. Google's sign-in cookies live on google.com; Flow itself on labs.google. Generation automation not approved (R-02). */
export const GOOGLE_FLOW: PlatformDefinition = {
  id: 'google-flow',
  displayName: 'Google Flow',
  cookieDomains: ['google.com', 'labs.google'],
  navigationDomains: ['google.com', 'labs.google'],
  // Flow moved to flow.google.com (the labs.google address redirects there; observed 2026-10-22).
  pages: { home: 'https://flow.google.com/' },
  ...MANUAL_ONLY('No Google Flow automation approved; manual session only (R-02)'),
  accountBoundary: 'one_account_per_profile',
};

/** Shopee Indonesia (optional per bundle). */
export const SHOPEE: PlatformDefinition = {
  id: 'shopee',
  displayName: 'Shopee',
  cookieDomains: ['shopee.co.id'],
  navigationDomains: ['shopee.co.id'],
  pages: { home: 'https://shopee.co.id/' },
  ...MANUAL_ONLY('No Shopee automation approved; manual session only'),
  accountBoundary: 'one_account_per_profile',
};

const REAL_BUNDLE_PLATFORMS: Record<string, PlatformDefinition> = {
  tiktok: TIKTOK,
  'google-flow': GOOGLE_FLOW,
  kalodata: KALODATA,
  shopee: SHOPEE,
};

/** Each real platform's synthetic stand-in lives on its own host of the synthetic site, e.g. tiktok.ugc-poc.test. */
export const syntheticHostFor = (platformId: string): string => `${platformId}.ugc-poc.test`;

function syntheticStandIn(real: PlatformDefinition, origin: string): PlatformDefinition {
  const host = syntheticHostFor(real.id);
  const base = `https://${host}:${new URL(origin).port}`;
  return {
    ...real,
    cookieDomains: [host],
    navigationDomains: [host],
    // Test-only pages (rotation, logout, a site asking for HTTP auth) exist on the synthetic stand-ins only.
    pages: { home: `${base}/`, rotate: `${base}/rotate`, logout: `${base}/logout`, 'basic-auth': `${base}/basic-auth`, download: `${base}/flow-download` },
  };
}

function legacySyntheticPlatform(origin: string, manualStatus: boolean): PlatformDefinition {
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
 * Every platform this run can use, by id. Real runs: the four bundle
 * platforms. Synthetic runs: their synthetic stand-ins plus the legacy
 * synthetic test platform. Throws if any definition is invalid: the app must
 * not start with a bad cookie or navigation scope.
 */
export function resolvePlatforms(config: RuntimeConfig): ReadonlyMap<string, PlatformDefinition> {
  const platforms = new Map<string, PlatformDefinition>();
  if (config.synthetic) {
    if (!config.siteOrigin) return platforms;
    platforms.set(SYNTHETIC_PLATFORM_ID, legacySyntheticPlatform(config.siteOrigin, config.syntheticManualStatus));
    for (const { id } of BUNDLE_PLATFORMS) platforms.set(id, syntheticStandIn(REAL_BUNDLE_PLATFORMS[id]!, config.siteOrigin));
  } else {
    for (const { id } of BUNDLE_PLATFORMS) platforms.set(id, REAL_BUNDLE_PLATFORMS[id]!);
  }
  for (const platform of platforms.values()) {
    const issues = validatePlatformDefinition(platform);
    if (issues.length > 0) throw new InvalidPlatformDefinition(platform.id, issues);
  }
  return platforms;
}

/**
 * Cookie domains a platform's sealed snapshot may contain, without the runtime
 * config (security check integrity test): the real domains and the synthetic
 * stand-in's host. Unknown platforms get none.
 */
export function cookieDomainsFor(platformId: string): readonly string[] {
  if (platformId === SYNTHETIC_PLATFORM_ID) return ['ugc-poc.test'];
  const real = REAL_BUNDLE_PLATFORMS[platformId];
  return real ? [...real.cookieDomains, syntheticHostFor(platformId)] : [];
}

/** The base URL a probe path is resolved against: the origin of the platform's home page. */
export function platformOrigin(platform: PlatformDefinition): string {
  return new URL(platform.pages['home'] ?? Object.values(platform.pages)[0]!).origin;
}
