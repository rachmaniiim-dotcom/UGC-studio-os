import { describe, expect, it } from 'vitest';
import { validatePlatformDefinition } from '@ugc/core';
import type { RuntimeConfig } from '../src/main/config.js';
import { cookieDomainsFor, GOOGLE_FLOW, KALODATA, resolvePlatforms, SHOPEE, TIKTOK } from '../src/main/platforms.js';

const config = (patch: Partial<RuntimeConfig>): RuntimeConfig => ({
  synthetic: false,
  siteOrigin: null,
  siteCertFingerprint: null,
  allowUnencryptedSyntheticCookies: false,
  userDataOverride: null,
  seedLegacyProfiles: false,
  syntheticManualStatus: false,
  requirePersistedKey: false,
  ...patch,
});

describe('built-in platforms', () => {
  it('all four bundle platforms are valid, manual-status only, with no automation or AI data use authorized', () => {
    for (const p of [TIKTOK, GOOGLE_FLOW, KALODATA, SHOPEE]) {
      expect(validatePlatformDefinition(p), p.id).toEqual([]);
      expect(p.statusCheck).toEqual({ kind: 'manual' });
      expect(p.authorization).toMatchObject({ automation: 'not_permitted', aiDataUse: 'not_permitted' });
    }
    expect(KALODATA.cookieDomains).toEqual(['kalodata.com', 'kalowave.com']);
    expect(KALODATA.authorization.basis).toMatch(/4\.1\.8/);
    expect(GOOGLE_FLOW.cookieDomains).toEqual(['google.com', 'labs.google']);
  });

  it('real runs: exactly the four platforms', () => {
    expect([...resolvePlatforms(config({})).keys()]).toEqual(['tiktok', 'google-flow', 'kalodata', 'shopee']);
  });

  it('synthetic runs: stand-ins on their own synthetic hosts, plus the legacy test platform', () => {
    const origin = 'https://auth.ugc-poc.test:4443';
    const platforms = resolvePlatforms(config({ synthetic: true, siteOrigin: origin }));
    expect([...platforms.keys()]).toEqual(['synthetic-poc', 'tiktok', 'google-flow', 'kalodata', 'shopee']);
    const tiktok = platforms.get('tiktok')!;
    expect(tiktok.cookieDomains).toEqual(['tiktok.ugc-poc.test']);
    expect(tiktok.pages['home']).toBe('https://tiktok.ugc-poc.test:4443/');
    expect(tiktok.authorization.automation).toBe('not_permitted');
    expect(platforms.get('synthetic-poc')!.statusCheck).toEqual({ kind: 'probe', path: '/whoami' });
    expect(resolvePlatforms(config({ synthetic: true, siteOrigin: origin, syntheticManualStatus: true })).get('synthetic-poc')!.statusCheck).toEqual({
      kind: 'manual',
    });
    expect(resolvePlatforms(config({ synthetic: true, siteOrigin: null })).size).toBe(0);
  });

  it('cookie domains for the security check cover the real and synthetic scopes', () => {
    expect(cookieDomainsFor('synthetic-poc')).toEqual(['ugc-poc.test']);
    expect(cookieDomainsFor('kalodata')).toEqual(['kalodata.com', 'kalowave.com', 'kalodata.ugc-poc.test']);
    expect(cookieDomainsFor('other')).toEqual([]);
  });
});
