import { parseTikTokVideoUrl } from '../research/reference.js';

/**
 * Affiliate products (A1). A product is identified only by its TikTok Shop
 * product ID, taken from a link or address the owner provides; nothing is
 * fetched. Listing facts are what the owner verified on the TikTok listing.
 * Showcase states never claim "added" on the app's own action: either TikTok's
 * confirmation was seen by the owner (assisted) or TikTok's API confirmed it
 * (official provider, later).
 */

const PRODUCT_ID = /^\d{15,20}$/;

/** The canonical TikTok product page for an ID. */
export const productPageUrl = (productId: string): string => `https://www.tiktok.com/view/product/${productId}`;
/** TikTok Shop's creator Showcase management page (desktop web). */
export const SHOWCASE_PAGE_URL = 'https://shop.tiktok.com/streamer/showcase/product/list';

export type ProductRefIssue = 'invalid_product_ref' | 'short_link_unsupported' | 'not_a_product_link';

/**
 * Parses a TikTok Shop product reference: a bare ID, or a full product link
 * (`tiktok.com/view/product/<id>`, `shop.tiktok.com/view/product/<id>`, with or
 * without query). Short links can't be resolved offline and are refused.
 */
export function parseProductRef(raw: string): { productId: string } | { error: ProductRefIssue } {
  const s = raw.trim();
  if (PRODUCT_ID.test(s)) return { productId: s };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { error: 'invalid_product_ref' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return { error: 'invalid_product_ref' };
  if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com' || /^\/t\//.test(url.pathname)) return { error: 'short_link_unsupported' };
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return { error: 'not_a_product_link' };
  const m = /^\/view\/product\/(\d{15,20})\/?$/.exec(url.pathname);
  return m ? { productId: m[1]! } : { error: 'not_a_product_link' };
}

/**
 * Finds a TikTok product ID in a research page's address (e.g. a Kalodata
 * product page): an `id` / `product_id` / `productId` query value or a path
 * segment of 15–20 digits. Only the address is read, never the page.
 */
export function productIdFromAddress(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  for (const key of ['product_id', 'productId', 'id']) {
    const v = url.searchParams.get(key);
    if (v && PRODUCT_ID.test(v)) return v;
  }
  const seg = url.pathname.split('/').find((p) => PRODUCT_ID.test(p));
  return seg ?? null;
}

/** Splits pasted text into product references (one per line, or separated by spaces/commas). */
export function parseProductList(text: string): Array<{ line: number; input: string; productId?: string; error?: ProductRefIssue }> {
  const tokens = text
    .split(/\r?\n/)
    .flatMap((l, i) => l.split(/[\s,;]+/).map((t) => ({ line: i + 1, input: t.trim() })))
    .filter((t) => t.input !== '');
  return tokens.map((t) => {
    const r = parseProductRef(t.input);
    return 'error' in r ? { ...t, error: r.error } : { ...t, productId: r.productId };
  });
}

export type ListingState = 'unverified' | 'confirmed' | 'mismatch';
export type EligibilityState = 'unknown' | 'can_promote' | 'cannot_promote';
export type ShowcaseState = 'not_requested' | 'in_progress' | 'added_seen_by_you' | 'added_confirmed_by_tiktok' | 'not_eligible' | 'failed' | 'removed';
/** What the owner can do in the assisted flow. No action produces `added_confirmed_by_tiktok`: only the official API provider will. */
export type ShowcaseAction = 'start' | 'confirm_seen' | 'not_eligible' | 'failed' | 'removed' | 'reset';

export const SHOWCASE_ACTIONS: Readonly<Record<ShowcaseAction, { readonly from: readonly ShowcaseState[]; readonly to: ShowcaseState }>> = {
  start: { from: ['not_requested', 'failed', 'removed', 'in_progress'], to: 'in_progress' },
  confirm_seen: { from: ['in_progress'], to: 'added_seen_by_you' },
  not_eligible: { from: ['not_requested', 'in_progress', 'failed'], to: 'not_eligible' },
  failed: { from: ['in_progress'], to: 'failed' },
  removed: { from: ['added_seen_by_you', 'added_confirmed_by_tiktok'], to: 'removed' },
  reset: { from: ['not_eligible', 'failed', 'removed'], to: 'not_requested' },
};

export interface ProductFacts {
  readonly title: string;
  readonly shopName: string;
  readonly priceIdr: number | null;
  readonly commissionPct: number | null;
  /** Features the owner checked on the listing (used later for scripts). */
  readonly features: readonly string[];
  /** Sales-driving TikTok videos for this product (links only). */
  readonly references: readonly string[];
  readonly notes: string;
}

export const EMPTY_FACTS: ProductFacts = { title: '', shopName: '', priceIdr: null, commissionPct: null, features: [], references: [], notes: '' };

export type FactsIssue = 'invalid_title' | 'invalid_shop' | 'invalid_price' | 'invalid_commission' | 'invalid_features' | 'invalid_references' | 'invalid_notes';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !CONTROL.test(v);

/** Validates owner-entered listing facts. Numbers may be given as text ("89.000", "12,5"). */
export function validateFacts(raw: unknown): { ok: true; value: ProductFacts } | { ok: false; issues: FactsIssue[] } {
  const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const issues: FactsIssue[] = [];
  if (!text(f['title'] ?? '', 200)) issues.push('invalid_title');
  if (!text(f['shopName'] ?? '', 100)) issues.push('invalid_shop');
  const num = (v: unknown, decimals: boolean): number | null | 'invalid' => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 'invalid';
    if (typeof v !== 'string') return 'invalid';
    const s = v.trim().replace(/^rp\s*/i, '').replace(/%$/, '');
    const n = decimals ? Number(s.replace(',', '.')) : Number(s.replace(/[.,\s]/g, ''));
    return Number.isFinite(n) && s !== '' ? n : 'invalid';
  };
  const price = num(f['priceIdr'], false);
  if (price === 'invalid' || (price !== null && (!Number.isInteger(price) || price < 0 || price > 1e9))) issues.push('invalid_price');
  const commission = num(f['commissionPct'], true);
  if (commission === 'invalid' || (commission !== null && (commission < 0 || commission > 80))) issues.push('invalid_commission');
  const list = (v: unknown, maxItems: number, maxLen: number): string[] | null => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => text(x, maxLen))) return null;
    return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
  };
  const features = list(f['features'], 20, 200);
  if (!features) issues.push('invalid_features');
  const refs = list(f['references'], 10, 500);
  const canonicalRefs: string[] = [];
  if (!refs) issues.push('invalid_references');
  else {
    for (const r of refs) {
      const parsed = parseTikTokVideoUrl(r);
      if ('error' in parsed) {
        issues.push('invalid_references');
        break;
      }
      canonicalRefs.push(parsed.url);
    }
  }
  if (!text(f['notes'] ?? '', 1000)) issues.push('invalid_notes');
  if (issues.length > 0) return { ok: false, issues: [...new Set(issues)] };
  return {
    ok: true,
    value: {
      title: String(f['title'] ?? '').trim(),
      shopName: String(f['shopName'] ?? '').trim(),
      priceIdr: price as number | null,
      commissionPct: commission as number | null,
      features: features!,
      references: [...new Set(canonicalRefs)],
      notes: String(f['notes'] ?? '').trim(),
    },
  };
}

const rupiah = (n: number): string => `Rp${n.toLocaleString('id-ID')}`;

/** A one-line summary built from the facts by fixed rules (no AI). */
export function productSummary(f: ProductFacts): string {
  const parts: string[] = [];
  if (f.priceIdr !== null) parts.push(rupiah(f.priceIdr));
  if (f.commissionPct !== null) parts.push(`komisi ${String(f.commissionPct).replace('.', ',')}%`);
  if (f.shopName) parts.push(`toko ${f.shopName}`);
  parts.push(`${f.features.length} fitur terverifikasi`);
  parts.push(`${f.references.length} video referensi`);
  return parts.join(' · ');
}

export const DEFAULT_DAILY_PRODUCTS = 3;
