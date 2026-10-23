import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@ugc/core';
import { AffiliateError, AffiliateService } from '../src/main/affiliate.js';
import { BundleStore, MetadataDb, ProfileStore } from '../src/main/profiles.js';

const A = '1729384756102938471';
const B = '1729384756102938472';
const C = '1729384756102938473';
const D = '1729384756102938474';

function setup(now = () => new Date('2026-10-23T09:00:00')) {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-aff-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const lines: string[] = [];
  const service = new AffiliateService(meta, bundles, createLogger((l) => lines.push(l)), now);
  const make = (name: string, mode: 'affiliate_ugc' | 'account_growth' = 'affiliate_ugc') => bundles.create({ displayName: name, mode }, [], new ProfileStore(meta));
  return { service, make, lines, meta, bundles };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof AffiliateError ? e.code : 'other';
  }
  return undefined;
};

describe('affiliate products (SQLite, synthetic)', () => {
  it('adds pasted links/IDs to one account only; duplicates and bad lines reported', () => {
    const { service, make, lines } = setup();
    const one = make('Synthetic Affiliate 01');
    const two = make('Synthetic Affiliate 02');
    const r = service.addFromText(one.id, `${A}\nhttps://www.tiktok.com/view/product/${B}\nhttps://vt.tiktok.com/ZS1/\n${A}`);
    expect(r).toEqual({ added: [A, B], existing: [], rejected: [{ line: 3, input: 'https://vt.tiktok.com/ZS1/', issue: 'short_link_unsupported' }] });
    expect(service.addFromText(one.id, A)).toMatchObject({ added: [], existing: [A] });
    expect(service.view(one.id).products.map((p) => p.productId).sort()).toEqual([A, B]);
    expect(service.view(two.id).products).toHaveLength(0); // accounts are independent
    service.addFromText(two.id, A);
    expect(service.view(two.id).products[0]).toMatchObject({ productId: A, showcase: 'not_requested', listing: 'unverified' });
    expect(code(() => service.addFromText(one.id, '   '))).toBe('invalid_product_list');
    expect(lines.join('\n')).not.toContain(A);
  });

  it('captures the product from a research window address (ID only)', () => {
    const { service, make } = setup();
    const a = make('Synthetic Affiliate 01');
    expect(service.addFromAddress(a.id, `https://www.kalodata.com/product/detail?id=${C}`)).toEqual({ productId: C, outcome: 'added' });
    expect(service.addFromAddress(a.id, `https://www.kalodata.com/product/detail?id=${C}`)).toEqual({ productId: C, outcome: 'existing' });
    expect(code(() => service.addFromAddress(a.id, 'https://www.kalodata.com/product?page=2'))).toBe('no_product_in_address');
    expect(service.view(a.id).products[0]).toMatchObject({ source: 'research_address', facts: { title: '' } });
  });

  it('refuses Ternak Akun accounts (factories stay separate)', () => {
    const { service, make } = setup();
    const g = make('Synthetic Ternak 01', 'account_growth');
    expect(code(() => service.view(g.id))).toBe('not_affiliate_account');
    expect(code(() => service.addFromText(g.id, A))).toBe('not_affiliate_account');
  });

  it("today's selection is limited per day and resets on the next day", () => {
    let now = new Date('2026-10-23T09:00:00');
    const { service, make } = setup(() => now);
    const a = make('Synthetic Affiliate 01');
    service.addFromText(a.id, [A, B, C, D].join('\n'));
    const ids = Object.fromEntries(service.view(a.id).products.map((p) => [p.productId, p.id]));
    for (const p of [A, B, C]) service.select(a.id, ids[p]!, true);
    expect(code(() => service.select(a.id, ids[D]!, true))).toBe('daily_selection_full');
    expect(service.view(a.id)).toMatchObject({ selectedToday: 3, dailyLimit: 3, today: '2026-10-23' });
    service.setDailyLimit(a.id, 4);
    service.select(a.id, ids[D]!, true);
    expect(code(() => service.setDailyLimit(a.id, 0))).toBe('invalid_daily_products');
    service.select(a.id, ids[A]!, false);
    expect(service.view(a.id).selectedToday).toBe(3);
    now = new Date('2026-10-24T09:00:00');
    expect(service.view(a.id).selectedToday).toBe(0);
  });

  it('assisted Showcase: listing first, "added" only after the owner sees TikTok confirm it', () => {
    const { service, make, lines } = setup();
    const a = make('Synthetic Affiliate 01');
    service.addFromText(a.id, A);
    const id = service.view(a.id).products[0]!.id;
    expect(code(() => service.showcase(a.id, id, 'start'))).toBe('listing_not_confirmed');
    expect(code(() => service.showcase(a.id, id, 'confirm_seen'))).toBe('showcase_action_not_allowed'); // never without opening TikTok's page
    service.setListing(a.id, id, 'confirmed');
    expect(service.showcase(a.id, id, 'start')).toBe('in_progress');
    expect(service.view(a.id).products[0]).toMatchObject({ showcase: 'in_progress', showcaseMethod: 'assisted' });
    expect(service.showcase(a.id, id, 'confirm_seen')).toBe('added_seen_by_you');
    expect(code(() => service.showcase(a.id, id, 'start'))).toBe('showcase_action_not_allowed');
    expect(service.showcase(a.id, id, 'removed')).toBe('removed');
    expect(service.showcase(a.id, id, 'start')).toBe('in_progress');
    expect(service.showcase(a.id, id, 'failed')).toBe('failed');
    expect(service.showcase(a.id, id, 'reset')).toBe('not_requested');
    expect(lines.join('\n')).toContain('showcase_state_changed');
  });

  it('stores verified facts with validation; eligibility and deletion', () => {
    const { service, make } = setup();
    const a = make('Synthetic Affiliate 01');
    service.addFromText(a.id, A);
    const id = service.view(a.id).products[0]!.id;
    expect(code(() => service.updateFacts(a.id, id, { priceIdr: 'lots' }))).toBe('invalid_facts');
    service.updateFacts(a.id, id, { title: 'Kipas Mini Sintetis', shopName: 'Toko Sintetis', priceIdr: '89.000', commissionPct: '12', features: ['3 kecepatan'], references: [] });
    service.setEligibility(a.id, id, 'can_promote');
    expect(service.view(a.id).products[0]).toMatchObject({ eligibility: 'can_promote', summary: 'Rp89.000 · komisi 12% · toko Toko Sintetis · 1 fitur terverifikasi · 0 video referensi' });
    expect(service.productUrl(a.id, id)).toEqual({ productId: A, url: `https://www.tiktok.com/view/product/${A}` });
    service.remove(a.id, id);
    expect(service.view(a.id).products).toHaveLength(0);
    expect(code(() => service.remove(a.id, id))).toBe('unknown_product');
  });
});
