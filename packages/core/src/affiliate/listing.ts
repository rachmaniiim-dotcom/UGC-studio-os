// Reads a product's facts from its TikTok listing page (A3): the page the
// owner opened in the affiliate account's own TikTok window. The snapshot is
// taken in an isolated world (the page's scripts can't see or change it) and
// parsed here, offline, by fixed rules. Nothing is clicked, no other page is
// requested, and a security check is left for the owner to complete.

/** What the snapshot script returns from the open listing page. */
export interface ListingSnapshot {
  readonly url: string;
  readonly title: string;
  readonly meta: Readonly<Record<string, string>>;
  /** Parsed JSON-LD blocks. */
  readonly ld: readonly unknown[];
  /** Parsed embedded JSON data blocks that mention products. */
  readonly data: readonly unknown[];
  /** Visible page text (start only). */
  readonly text: string;
  /** The page is a security check / CAPTCHA, for the owner to complete. */
  readonly security: boolean;
}

export interface ListingFacts {
  readonly title: string;
  readonly shopName: string;
  readonly priceIdr: number | null;
  readonly description: string;
  readonly imageUrl: string | null;
  /** Feature lines taken from the description, in order. */
  readonly features: readonly string[];
}

export type ListingIssue = 'security_check' | 'not_this_product' | 'title_not_found';

/**
 * Runs in an isolated world of the listing window and returns a ListingSnapshot.
 * Read-only: it only reads meta tags, JSON blocks and visible text.
 */
export const LISTING_SNAPSHOT_SCRIPT = `(() => {
  const meta = {};
  for (const m of document.querySelectorAll('meta[property],meta[name],meta[itemprop]')) {
    const k = (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || '').toLowerCase();
    if (k && !(k in meta)) meta[k] = String(m.getAttribute('content') || '').slice(0, 5000);
  }
  const ld = [], data = [];
  for (const s of document.querySelectorAll('script')) {
    const t = s.textContent || '';
    if (t.length < 2 || t.length > 4000000) continue;
    const type = (s.getAttribute('type') || '').toLowerCase();
    try {
      if (type === 'application/ld+json') ld.push(JSON.parse(t));
      else if ((type === 'application/json' || /^\\s*[{[]/.test(t)) && /product/i.test(t) && data.length < 8) data.push(JSON.parse(t));
    } catch (e) {}
  }
  const text = String((document.body && document.body.innerText) || '').slice(0, 20000);
  const head = (document.title + ' ' + text.slice(0, 600)).toLowerCase();
  const security = /security check|verify to continue|captcha|drag the slider|pemeriksaan keamanan|verifikasi/.test(head) && text.length < 1500;
  return { url: location.href, title: document.title, meta, ld, data, text, security };
})()`;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string, max: number): string => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

interface Leaf {
  readonly key: string;
  readonly path: string;
  readonly value: string | number;
}

/** Every string/number leaf with its key and lower-cased path (bounded). */
function leaves(root: unknown): Leaf[] {
  const out: Leaf[] = [];
  const stack: Array<{ node: unknown; path: string; key: string; depth: number }> = [{ node: root, path: '', key: '', depth: 0 }];
  let seen = 0;
  while (stack.length > 0 && seen < 300_000) {
    const { node, path, key, depth } = stack.pop()!;
    seen++;
    if (typeof node === 'string' || typeof node === 'number') out.push({ key: key.toLowerCase(), path, value: node });
    else if (node && typeof node === 'object' && depth < 40) {
      const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i]!;
        stack.push({ node: v, path: `${path}.${k.toLowerCase()}`, key: Array.isArray(node) ? key : k, depth: depth + 1 });
      }
    }
  }
  return out;
}

/** JSON-LD Product nodes (also inside @graph or arrays). */
function ldProducts(ld: readonly unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (n: unknown, depth: number): void => {
    if (!n || typeof n !== 'object' || depth > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, depth + 1));
    const o = n as Record<string, unknown>;
    const type = o['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) out.push(o);
    if (o['@graph']) visit(o['@graph'], depth + 1);
  };
  ld.forEach((n) => visit(n, 0));
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "Rp89.000", "89.000", "Rp 1.250.000", 89000 → whole rupiah. */
export function parseRupiah(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 100 && v <= 1e9 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = /(?:rp\s*)?(\d{1,3}(?:[.\s]\d{3})+|\d{3,9})(?:,\d{1,2})?/i.exec(v.replace(/ /g, ' '));
  if (!m) return null;
  const n = Number(m[1]!.replace(/[.\s]/g, ''));
  return n >= 100 && n <= 1e9 ? n : null;
}

/** A rich-text description stored as JSON ([{type:'text', text:'…'}, …]) becomes plain text. */
function plainDescription(v: string): string {
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v;
  try {
    return leaves(JSON.parse(t))
      .filter((l) => typeof l.value === 'string' && (l.key === 'text' || l.key === 'content' || l.key === 'value'))
      .map((l) => String(l.value))
      .join('\n');
  } catch {
    return v;
  }
}

const SITE_SUFFIX = /\s*[|\-–—]\s*(tiktok( shop)?|tokopedia)[^|]*$/i;
const GENERIC_TITLE = /^(tiktok|tiktok shop|security check|loading|product)$/i;

const PROMO = /\b(diskon|promo|voucher|gratis ongkir|ongkir|flash ?sale|cod|cashback|checkout|beli sekarang|order sekarang|stok terbatas|terlaris|best ?seller|termurah|harga|rp\s?\d)/i;

/** Shop and listing stats, not product features: "190.7K sold", "9.4K+ followers", "4.8 rating", "Shop X on TikTok Shop". */
const STATS =
  /(\d[\d.,]*\s*(k|rb|jt|m)?\+?\s*(sold|terjual|followers?|pengikut|reviews?|ulasan|penilaian|ratings?)\b)|\b(terjual|sold)\s*\d|\b(rating|bintang|stars?)\b|\bshop\b.*\bon tiktok\b|\b(tiktok shop|tokopedia)\b|\b(followers?|pengikut)\b/i;

/** Short feature lines from a product description (bullets, lines, sentences), promotions left out. */
export function featuresFromDescription(description: string, max = 6): string[] {
  const parts = description
    .replace(/\r/g, '')
    .split(/\n|[•·✅✔✓★☆■◆▪►▶➤❖✨🔥]|;|(?<=[.!?])\s+(?=[A-Z0-9])/u)
    // A line ending in ":" is a heading ("Manfaat:", "Spesifikasi:").
    .filter((p) => !/:\s*$/.test(p))
    .map((p) =>
      p
        .replace(/^\s*(?:[-*–—>]+|\d{1,2}[.)]|[a-z][.)])\s*/i, '')
        .replace(/[\p{Extended_Pictographic}️]/gu, '')
        .replace(/\s+/g, ' ')
        .replace(/[.:;,\s]+$/, '')
        .trim(),
    );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (p.length < 6 || p.length > 120) continue;
    if (/https?:\/\/|www\./i.test(p) || /^#/.test(p) || PROMO.test(p) || STATS.test(p)) continue;
    if (/^(deskripsi|description|spesifikasi|specification|detail produk|product details?|manfaat|keunggulan|kelebihan|fitur|features?|benefits?|komposisi|ingredients|cara pakai)\b/i.test(p) && p.length < 30) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** Text that follows a "Deskripsi" / "Description" heading in the visible page text. */
function descriptionFromText(text: string): string {
  const m = /(?:^|\n)\s*(?:deskripsi produk|deskripsi|product description|description)\s*\n([\s\S]{20,3000})/i.exec(text);
  return m ? m[1]!.split(/\n\s*(?:ulasan|reviews?|penilaian|you may also like|produk serupa|toko)\b/i)[0]! : '';
}

/**
 * Parses a listing snapshot for one product ID. The product ID must appear in
 * the page address or its data, so a different product is never filled in.
 */
export function readListing(s: ListingSnapshot, productId: string): { ok: true; value: ListingFacts; found: string[] } | { ok: false; issue: ListingIssue } {
  if (s.security) return { ok: false, issue: 'security_check' };
  const blobs = [...s.data, ...s.ld];
  const all = leaves(blobs);
  const mentions = s.url.includes(productId) || all.some((l) => String(l.value) === productId || (typeof l.value === 'string' && l.value.includes(`/${productId}`)));
  if (!mentions) return { ok: false, issue: 'not_this_product' };
  const found: string[] = [];
  const product = ldProducts(s.ld)[0];
  const inProduct = (l: Leaf): boolean => /product|item|goods|sku|spu/.test(l.path);
  const pick = (keys: readonly string[], ok: (l: Leaf) => boolean): Leaf | undefined => {
    for (const k of keys) {
      const hit = all.find((l) => l.key === k && ok(l));
      if (hit) return hit;
    }
    return undefined;
  };
  const textLeaf = (min: number, max: number) => (l: Leaf) => typeof l.value === 'string' && l.value.trim().length >= min && l.value.length <= max;

  // Title.
  const titleCandidates = [
    str(product?.['name']),
    String(pick(['product_name', 'productname', 'title'], (l) => inProduct(l) && textLeaf(5, 300)(l))?.value ?? ''),
    s.meta['og:title'] ?? '',
    s.meta['twitter:title'] ?? '',
    s.title,
  ].map((t) => clean(t.replace(SITE_SUFFIX, ''), 200));
  const title = titleCandidates.find((t) => t.length >= 3 && !GENERIC_TITLE.test(t)) ?? '';
  if (!title) return { ok: false, issue: 'title_not_found' };
  found.push('title');

  // Description.
  const descLeaf = pick(['desc_detail', 'description', 'product_description', 'desc', 'detail'], (l) => inProduct(l) && textLeaf(20, 20000)(l));
  const rawDescription = plainDescription(
    str(product?.['description']) || String(descLeaf?.value ?? '') || s.meta['og:description'] || s.meta['description'] || descriptionFromText(s.text),
  ).replace(CONTROL, ' ');
  const description = clean(rawDescription, 3000);
  if (description) found.push('description');

  // Price.
  const offers = product?.['offers'];
  const offer = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;
  const priceIdr =
    parseRupiah(offer?.['price'] ?? offer?.['lowPrice']) ??
    parseRupiah(pick(['real_price', 'sale_price', 'min_price', 'price', 'format_price', 'sale_price_format'], (l) => /price/.test(l.path))?.value) ??
    parseRupiah(s.meta['product:price:amount'] ?? s.meta['og:price:amount']) ??
    parseRupiah(/rp\s?\d{1,3}(?:\.\d{3})+/i.exec(s.text)?.[0]);
  if (priceIdr !== null) found.push('price');

  // Shop.
  const brand = product?.['brand'] as Record<string, unknown> | string | undefined;
  const seller = offer?.['seller'] as Record<string, unknown> | undefined;
  const shopName = clean(
    str(seller?.['name']) ||
      String(pick(['shop_name', 'seller_name', 'shopname', 'sellername'], textLeaf(2, 100))?.value ?? '') ||
      String(pick(['name'], (l) => /seller|shop|store/.test(l.path) && textLeaf(2, 100)(l))?.value ?? '') ||
      (typeof brand === 'string' ? brand : str(brand?.['name'])),
    100,
  );
  if (shopName) found.push('shop');

  // Main image.
  const ldImage = product?.['image'];
  const firstImage = Array.isArray(ldImage) ? ldImage[0] : ldImage;
  const imageCandidates = [
    typeof firstImage === 'string' ? firstImage : str((firstImage as Record<string, unknown> | undefined)?.['url']),
    String(all.find((l) => /image|img|cover|thumb/.test(l.path) && inProduct(l) && typeof l.value === 'string' && /^https:\/\//.test(l.value))?.value ?? ''),
    s.meta['og:image'] ?? '',
  ];
  const imageUrl = imageCandidates.find((u) => /^https:\/\/[^\s"'<>]+$/.test(u) && u.length <= 2000) ?? null;
  if (imageUrl) found.push('image');

  const features = featuresFromDescription(rawDescription).map((f) => clean(f, 200));
  if (features.length > 0) found.push('features');
  return { ok: true, value: { title, shopName, priceIdr, description, imageUrl, features }, found };
}
