import { describe, expect, it } from 'vitest';
import { parseProductList, parseProductRef, productIdFromAddress, productPageUrl, productSummary, SHOWCASE_ACTIONS, validateFacts, EMPTY_FACTS } from '../src/index.js';

const ID = '1729384756102938475';

describe('product references (offline, never fetched)', () => {
  it('accepts IDs and TikTok product links, canonical by ID', () => {
    for (const ok of [ID, ` ${ID} `, `https://www.tiktok.com/view/product/${ID}`, `https://shop.tiktok.com/view/product/${ID}?region=ID&locale=id-ID`, `https://www.tiktok.com/view/product/${ID}/`]) {
      expect(parseProductRef(ok)).toEqual({ productId: ID });
    }
    expect(productPageUrl(ID)).toBe(`https://www.tiktok.com/view/product/${ID}`);
  });

  it('refuses short links, other sites and malformed input', () => {
    expect(parseProductRef('https://vt.tiktok.com/ZSabc123/')).toEqual({ error: 'short_link_unsupported' });
    expect(parseProductRef('https://www.tiktok.com/t/ZSabc123/')).toEqual({ error: 'short_link_unsupported' });
    expect(parseProductRef(`https://tiktok.com.evil.test/view/product/${ID}`)).toEqual({ error: 'not_a_product_link' });
    expect(parseProductRef(`http://www.tiktok.com/view/product/${ID}`)).toEqual({ error: 'invalid_product_ref' });
    expect(parseProductRef('https://www.tiktok.com/@someone/video/7000000000000000001')).toEqual({ error: 'not_a_product_link' });
    expect(parseProductRef('12345')).toEqual({ error: 'invalid_product_ref' });
  });

  it('finds the product ID in a research page address only by query or path', () => {
    expect(productIdFromAddress(`https://www.kalodata.com/product/detail?id=${ID}&language=id-ID`)).toBe(ID);
    expect(productIdFromAddress(`https://www.kalodata.com/product/${ID}`)).toBe(ID);
    expect(productIdFromAddress('https://www.kalodata.com/product?page=2')).toBeNull();
    expect(productIdFromAddress('not a url')).toBeNull();
  });

  it('parses pasted lists line by line, with line numbers for rejects', () => {
    expect(parseProductList(`${ID}\n\nhttps://vt.tiktok.com/x/, https://www.tiktok.com/view/product/1729384756102938476`)).toEqual([
      { line: 1, input: ID, productId: ID },
      { line: 3, input: 'https://vt.tiktok.com/x/', error: 'short_link_unsupported' },
      { line: 3, input: 'https://www.tiktok.com/view/product/1729384756102938476', productId: '1729384756102938476' },
    ]);
  });
});

describe('listing facts and summary', () => {
  it('validates owner-verified facts and builds a rule-based summary', () => {
    const r = validateFacts({
      title: 'Kipas Angin Mini Portable',
      shopName: 'Toko Sintetis',
      priceIdr: '89.000',
      commissionPct: '12,5',
      features: ['3 kecepatan', ' baterai 2000 mAh ', '3 kecepatan'],
      references: ['https://www.tiktok.com/@synth.seller/video/7000000000000000123?lang=id'],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        title: 'Kipas Angin Mini Portable',
        shopName: 'Toko Sintetis',
        priceIdr: 89000,
        commissionPct: 12.5,
        features: ['3 kecepatan', 'baterai 2000 mAh'],
        references: ['https://www.tiktok.com/@synth.seller/video/7000000000000000123'],
        notes: '',
      },
    });
    if (r.ok) expect(productSummary(r.value)).toBe('Rp89.000 · komisi 12,5% · toko Toko Sintetis · 2 fitur terverifikasi · 1 video referensi');
    expect(productSummary(EMPTY_FACTS)).toBe('0 fitur terverifikasi · 0 video referensi');
  });

  it('reports every invalid field', () => {
    const r = validateFacts({ title: 'x'.repeat(201), priceIdr: 'abc', commissionPct: 95, features: ['ok', 7], references: ['https://example.test/v'] });
    expect(r).toEqual({ ok: false, issues: expect.arrayContaining(['invalid_title', 'invalid_price', 'invalid_commission', 'invalid_features', 'invalid_references']) });
  });
});

describe('Showcase states', () => {
  it('no owner action ever produces "confirmed by TikTok"; confirmation needs an addition in progress', () => {
    expect(Object.values(SHOWCASE_ACTIONS).some((a) => a.to === 'added_confirmed_by_tiktok')).toBe(false);
    expect(SHOWCASE_ACTIONS.confirm_seen).toEqual({ from: ['in_progress'], to: 'added_seen_by_you' });
    expect(SHOWCASE_ACTIONS.start.from).not.toContain('added_seen_by_you');
  });
});
