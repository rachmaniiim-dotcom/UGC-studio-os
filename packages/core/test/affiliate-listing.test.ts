import { describe, expect, it } from 'vitest';
import { featuresFromDescription, parseRupiah, readListing, type ListingSnapshot } from '../src/index.js';

const ID = '1729384756102938471';
const base: ListingSnapshot = { url: `https://www.tiktok.com/view/product/${ID}`, title: 'TikTok Shop', meta: {}, ld: [], data: [], text: '', security: false };

describe('listing reader', () => {
  it('reads embedded product data (title, rich-text description, price, shop, image, features)', () => {
    const r = readListing(
      {
        ...base,
        data: [
          {
            loaderData: {
              page: {
                product_info: {
                  product_id: ID,
                  product_base: {
                    title: 'Serum Wajah Glow Sintetis 30 ml',
                    desc_detail: JSON.stringify([
                      { type: 'text', text: 'Manfaat:\n• Membantu mencerahkan kulit kusam\n• Tekstur ringan, cepat meresap\n• Isi 30 ml dengan pipet' },
                      { type: 'text', text: 'PROMO gratis ongkir hari ini!\nhttps://example.com/link' },
                    ]),
                    images: [{ url_list: ['https://p16-oec.example.com/serum.jpeg'] }],
                    price: { real_price: 'Rp89.000' },
                  },
                  seller: { name: 'Toko Glow Sintetis' },
                },
              },
            },
          },
        ],
      },
      ID,
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        title: 'Serum Wajah Glow Sintetis 30 ml',
        shopName: 'Toko Glow Sintetis',
        priceIdr: 89000,
        imageUrl: 'https://p16-oec.example.com/serum.jpeg',
        features: ['Membantu mencerahkan kulit kusam', 'Tekstur ringan, cepat meresap', 'Isi 30 ml dengan pipet'],
      },
    });
    if (r.ok) expect(r.found).toEqual(['title', 'description', 'price', 'shop', 'image', 'features']);
  });

  it('reads JSON-LD and meta tags, and strips the site name from the title', () => {
    const r = readListing(
      {
        ...base,
        meta: { 'og:title': 'Kipas Mini Sintetis | TikTok Shop', 'og:image': 'https://img.example.com/k.png' },
        ld: [{ '@graph': [{ '@type': 'Product', name: 'Kipas Angin Mini Sintetis', description: '3 kecepatan angin. Baterai isi ulang USB-C.', offers: { price: 89000, seller: { name: 'Toko Sintetis' } } }] }],
      },
      ID,
    );
    expect(r).toMatchObject({ ok: true, value: { title: 'Kipas Angin Mini Sintetis', shopName: 'Toko Sintetis', priceIdr: 89000, imageUrl: 'https://img.example.com/k.png', features: ['3 kecepatan angin', 'Baterai isi ulang USB-C'] } });
    expect(readListing({ ...base, meta: { 'og:title': 'Kipas Mini Sintetis | TikTok Shop' } }, ID)).toMatchObject({ ok: true, value: { title: 'Kipas Mini Sintetis', priceIdr: null, imageUrl: null, features: [] } });
  });

  it('refuses a security check, a different product, or a page without a title', () => {
    expect(readListing({ ...base, title: 'Security Check', security: true }, ID)).toEqual({ ok: false, issue: 'security_check' });
    expect(readListing({ ...base, url: 'https://www.tiktok.com/view/product/999', meta: { 'og:title': 'Other' } }, ID)).toEqual({ ok: false, issue: 'not_this_product' });
    expect(readListing(base, ID)).toEqual({ ok: false, issue: 'title_not_found' });
  });

  it('features: bullets, numbered lines and sentences; promotions, links and headings left out', () => {
    expect(featuresFromDescription('Deskripsi\n1. Bahan katun lembut\n- Ukuran S sampai XL\nDiskon 50% hari ini\n#ootd\nCocok untuk kerja. Mudah dicuci.')).toEqual([
      'Bahan katun lembut',
      'Ukuran S sampai XL',
      'Cocok untuk kerja',
      'Mudah dicuci',
    ]);
    expect(featuresFromDescription('a\nb'.repeat(3))).toEqual([]);
  });

  it('parses rupiah amounts', () => {
    expect(parseRupiah('Rp89.000')).toBe(89000);
    expect(parseRupiah('Rp 1.250.000')).toBe(1250000);
    expect(parseRupiah(45000)).toBe(45000);
    expect(parseRupiah('gratis')).toBeNull();
  });
});
