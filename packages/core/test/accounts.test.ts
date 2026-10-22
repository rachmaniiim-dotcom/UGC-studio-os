import { describe, expect, it } from 'vitest';
import { BUNDLE_PLATFORMS, bundleStatus, validateAccountInput } from '../src/index.js';

describe('account input', () => {
  it('accepts a trimmed name and a known mode', () => {
    expect(validateAccountInput({ displayName: '  Skincare ID 01 ', mode: 'affiliate_ugc' })).toEqual({
      ok: true,
      value: { displayName: 'Skincare ID 01', mode: 'affiliate_ugc' },
    });
    expect(validateAccountInput({ displayName: 'Growth', mode: 'account_growth' }).ok).toBe(true);
  });

  it.each([
    [{ displayName: '', mode: 'affiliate_ugc' }, ['invalid_display_name']],
    [{ displayName: 'x'.repeat(65), mode: 'affiliate_ugc' }, ['invalid_display_name']],
    [{ displayName: 'tab\there', mode: 'affiliate_ugc' }, ['invalid_display_name']],
    [{ displayName: 'ok', mode: 'growth' }, ['invalid_mode']],
    [{ displayName: 42, mode: null }, ['invalid_display_name', 'invalid_mode']],
  ])('rejects %j', (input, issues) => {
    expect(validateAccountInput(input)).toEqual({ ok: false, issues });
  });
});

describe('bundle status', () => {
  const ok = { status: 'ok' as const, lastPassedAt: '2026-10-22T00:00:00Z' };
  it('is a draft until a proxy has passed its test', () => {
    expect(bundleStatus(null, [])).toBe('draft');
    expect(bundleStatus({ status: 'untested', lastPassedAt: null }, [])).toBe('draft');
  });
  it('needs a proxy check after a restart, is operational once it passes, needs attention on failure', () => {
    expect(bundleStatus({ status: 'untested', lastPassedAt: '2026-10-22T00:00:00Z' }, [])).toBe('proxy_check_needed');
    expect(bundleStatus(ok, [{ status: 'confirmed_by_user' }, { status: 'imported_unverified' }])).toBe('operational');
    expect(bundleStatus({ status: 'failed', lastPassedAt: null }, [])).toBe('attention');
    expect(bundleStatus(ok, [{ status: 'expired' }])).toBe('attention');
  });
  it('covers TikTok, Google Flow, Kalodata and Shopee, with Kalodata and Shopee optional', () => {
    expect(BUNDLE_PLATFORMS.map((p) => [p.id, p.optional])).toEqual([
      ['tiktok', false],
      ['google-flow', false],
      ['kalodata', true],
      ['shopee', true],
    ]);
  });
});
