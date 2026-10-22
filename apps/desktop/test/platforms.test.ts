import { describe, expect, it } from 'vitest';
import { validatePlatformDefinition } from '@ugc/core';
import type { RuntimeConfig } from '../src/main/config.js';
import { cookieDomainsFor, KALODATA, resolvePlatform } from '../src/main/platforms.js';

const config = (patch: Partial<RuntimeConfig>): RuntimeConfig => ({
  synthetic: false,
  siteOrigin: null,
  siteCertFingerprint: null,
  allowUnencryptedSyntheticCookies: false,
  userDataOverride: null,
  platformId: null,
  syntheticManualStatus: false,
  requirePersistedKey: false,
  ...patch,
});

describe('built-in platforms', () => {
  it('Kalodata: valid, two cookie domains, manual status, no automation, no AI data use', () => {
    expect(validatePlatformDefinition(KALODATA)).toEqual([]);
    expect(KALODATA.cookieDomains).toEqual(['kalodata.com', 'kalowave.com']);
    expect(KALODATA.statusCheck).toEqual({ kind: 'manual' });
    expect(KALODATA.authorization).toMatchObject({ automation: 'not_permitted', aiDataUse: 'not_permitted' });
    expect(KALODATA.authorization.basis).toMatch(/4\.1\.8/);
  });

  it('resolves only what the run allows', () => {
    expect(resolvePlatform(config({}))).toBeNull();
    expect(resolvePlatform(config({ platformId: 'kalodata' }))?.id).toBe('kalodata');
    expect(resolvePlatform(config({ platformId: 'unknown' }))).toBeNull();
    // Kalodata is never active in synthetic (test-certificate) mode.
    expect(resolvePlatform(config({ synthetic: true, platformId: 'kalodata', siteOrigin: 'https://auth.ugc-poc.test:1' }))).toBeNull();
  });

  it('synthetic platform: probe by default, manual when asked, origin from the test server', () => {
    const origin = 'https://auth.ugc-poc.test:4443';
    const probe = resolvePlatform(config({ synthetic: true, platformId: 'synthetic-poc', siteOrigin: origin }))!;
    expect(probe.statusCheck).toEqual({ kind: 'probe', path: '/whoami' });
    expect(probe.pages['home']).toBe(`${origin}/`);
    const manual = resolvePlatform(config({ synthetic: true, platformId: 'synthetic-poc', siteOrigin: origin, syntheticManualStatus: true }))!;
    expect(manual.statusCheck).toEqual({ kind: 'manual' });
    expect(manual.authorization.automation).toBe('not_permitted');
    expect(resolvePlatform(config({ synthetic: true, platformId: 'synthetic-poc', siteOrigin: null }))).toBeNull();
  });

  it('cookie domains for the security check', () => {
    expect(cookieDomainsFor('synthetic-poc')).toEqual(['ugc-poc.test']);
    expect(cookieDomainsFor('kalodata')).toEqual(KALODATA.cookieDomains);
    expect(cookieDomainsFor('other')).toEqual([]);
  });
});
