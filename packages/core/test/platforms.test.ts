import { describe, expect, it } from 'vitest';
import {
  assertResearchUse,
  hostInDomains,
  ResearchUseNotAuthorized,
  urlInDomains,
  validatePlatformDefinition,
  type PlatformDefinition,
  type ResearchProviderDescriptor,
} from '../src/index.js';

const base: PlatformDefinition = {
  id: 'example',
  displayName: 'Example',
  cookieDomains: ['example.com', 'login-example.com'],
  navigationDomains: ['example.com', 'login-example.com'],
  pages: { home: 'https://www.example.com/' },
  statusCheck: { kind: 'manual' },
  authorization: { automation: 'not_permitted', aiDataUse: 'not_permitted', basis: 'terms' },
  accountBoundary: 'one_account_per_profile',
};
const issues = (patch: Partial<PlatformDefinition>) => validatePlatformDefinition({ ...base, ...patch });

describe('platform definitions', () => {
  it('accepts a manual-status definition spanning two domains', () => {
    expect(validatePlatformDefinition(base)).toEqual([]);
  });

  it.each<[string, Partial<PlatformDefinition>, string]>([
    ['bad id', { id: 'Bad Id' }, 'invalid_id'],
    ['empty name', { displayName: ' ' }, 'invalid_display_name'],
    ['a bare TLD as cookie scope', { cookieDomains: ['com'] }, 'invalid_domain'],
    ['a leading-dot domain', { cookieDomains: ['.example.com'] }, 'invalid_domain'],
    ['no cookie domains', { cookieDomains: [] }, 'no_cookie_domains'],
    ['a cookie domain the windows cannot reach', { navigationDomains: ['example.com'] }, 'cookie_domain_not_navigable'],
    ['no pages', { pages: {} }, 'no_pages'],
    ['an http page', { pages: { home: 'http://www.example.com/' } }, 'invalid_page'],
    ['an off-domain page', { pages: { home: 'https://evil.test/' } }, 'invalid_page'],
    ['a page with credentials', { pages: { home: 'https://u:p@www.example.com/' } }, 'invalid_page'],
    ['a probe without automation permission', { statusCheck: { kind: 'probe', path: '/me' } }, 'probe_without_automation_permission'],
    ['missing authorization basis', { authorization: { automation: 'permitted', aiDataUse: 'not_permitted', basis: '' } }, 'invalid_authorization'],
  ])('rejects %s', (_label, patch, issue) => {
    expect(issues(patch)).toContain(issue);
  });

  it('allows a probe only with automation permission and a plain path', () => {
    const permitted = { automation: 'permitted', aiDataUse: 'not_permitted', basis: 'synthetic' } as const;
    expect(issues({ statusCheck: { kind: 'probe', path: '/whoami' }, authorization: permitted })).toEqual([]);
    expect(issues({ statusCheck: { kind: 'probe', path: 'https://x/' }, authorization: permitted })).toContain('invalid_probe_path');
  });

  it('matches hosts and URLs by registrable domain, not by substring', () => {
    expect(hostInDomains('www.example.com', ['example.com'])).toBe(true);
    expect(hostInDomains('badexample.com', ['example.com'])).toBe(false);
    expect(hostInDomains('example.com.evil.test', ['example.com'])).toBe(false);
    expect(urlInDomains('https://a.example.com:8443/x', ['example.com'])).toBe(true);
    expect(urlInDomains('http://a.example.com/', ['example.com'])).toBe(false);
  });
});

describe('research provider authorization', () => {
  const descriptor = (automation: 'permitted' | 'not_permitted', aiDataUse: 'permitted' | 'not_permitted'): ResearchProviderDescriptor => ({
    id: 'kalodata',
    displayName: 'Kalodata',
    authorization: { automation, aiDataUse, basis: 'ToS §4.1.8, §14.3–14.6' },
  });

  it('blocks automated retrieval and AI processing without recorded permission', () => {
    expect(() => assertResearchUse(descriptor('not_permitted', 'not_permitted'), 'automated_retrieval')).toThrow(ResearchUseNotAuthorized);
    expect(() => assertResearchUse(descriptor('permitted', 'not_permitted'), 'ai_processing')).toThrow(ResearchUseNotAuthorized);
  });

  it('allows a use only when that specific permission is recorded', () => {
    expect(() => assertResearchUse(descriptor('permitted', 'not_permitted'), 'automated_retrieval')).not.toThrow();
    expect(() => assertResearchUse(descriptor('not_permitted', 'permitted'), 'ai_processing')).not.toThrow();
  });
});
