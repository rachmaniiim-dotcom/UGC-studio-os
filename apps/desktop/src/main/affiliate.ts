import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_DAILY_PRODUCTS,
  EMPTY_FACTS,
  parseProductList,
  productIdFromAddress,
  productPageUrl,
  productSummary,
  SHOWCASE_ACTIONS,
  validateFacts,
  type EligibilityState,
  type ListingState,
  type Logger,
  type ProductFacts,
  type ShowcaseAction,
  type ShowcaseState,
} from '@ugc/core';
import type { BundleStore, MetadataDb } from './profiles.js';

/**
 * Affiliate Products (A1): products per affiliate account, by TikTok product
 * ID only (no research data stored), today's selection, owner-verified
 * listing facts, and the assisted Showcase flow. The app never marks a
 * product as added on its own: in the assisted flow the owner confirms that
 * TikTok shows it in the Showcase. Logs carry ids, counts and states only.
 */

export type AffiliateErrorCode =
  | 'not_affiliate_account'
  | 'unknown_product'
  | 'invalid_product_list'
  | 'invalid_facts'
  | 'invalid_daily_products'
  | 'daily_selection_full'
  | 'listing_not_confirmed'
  | 'showcase_action_not_allowed'
  | 'no_product_in_address';

export class AffiliateError extends Error {
  constructor(
    readonly code: AffiliateErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface AffiliateProduct {
  readonly id: string;
  readonly productId: string;
  readonly productUrl: string;
  readonly source: 'link' | 'research_address';
  readonly facts: ProductFacts;
  readonly summary: string;
  readonly selectedToday: boolean;
  readonly listing: ListingState;
  readonly eligibility: EligibilityState;
  readonly showcase: ShowcaseState;
  readonly showcaseMethod: 'assisted' | 'api' | null;
  readonly showcaseChangedAt: string | null;
  /** The listing photo saved as a reference image for Flow (A3), if any. */
  readonly imageAssetId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AffiliateView {
  readonly products: readonly AffiliateProduct[];
  readonly today: string;
  readonly dailyLimit: number;
  readonly selectedToday: number;
}

export interface AddResult {
  readonly added: string[];
  readonly existing: string[];
  readonly rejected: Array<{ line: number; input: string; issue: string }>;
}

interface Row {
  id: string;
  bundle_id: string;
  platform_product_id: string;
  source: 'link' | 'research_address';
  facts_json: string;
  selected_on: string | null;
  listing_state: ListingState;
  eligibility_state: EligibilityState;
  showcase_state: ShowcaseState;
  showcase_method: 'assisted' | 'api' | null;
  showcase_changed_at: string | null;
  image_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

export class AffiliateService {
  readonly #db: DatabaseSync;
  readonly #bundles: BundleStore;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(meta: MetadataDb, bundles: BundleStore, log: Logger, now: () => Date = () => new Date()) {
    if (!meta.db) throw new Error('affiliate store needs a writable database');
    this.#db = meta.db;
    this.#bundles = bundles;
    this.#log = log;
    this.#now = now;
  }

  #require(bundleId: string): void {
    if (this.#bundles.get(bundleId)?.mode !== 'affiliate_ugc') throw new AffiliateError('not_affiliate_account');
  }

  /** Today on this computer's clock, as YYYY-MM-DD. */
  #today(): string {
    const d = this.#now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  #row(bundleId: string, id: string): Row {
    const row = this.#db.prepare('SELECT * FROM affiliate_products WHERE id = ? AND bundle_id = ?').get(id, bundleId) as unknown as Row | undefined;
    if (!row) throw new AffiliateError('unknown_product');
    return row;
  }

  #touch(id: string, sets: string, ...args: Array<string | number | null>): void {
    this.#db.prepare(`UPDATE affiliate_products SET ${sets}, updated_at = ? WHERE id = ?`).run(...args, this.#now().toISOString(), id);
  }

  #insert(bundleId: string, productId: string, source: Row['source']): 'added' | 'existing' {
    const exists = this.#db.prepare('SELECT 1 FROM affiliate_products WHERE bundle_id = ? AND platform_product_id = ?').get(bundleId, productId);
    if (exists) return 'existing';
    const now = this.#now().toISOString();
    this.#db
      .prepare('INSERT INTO affiliate_products (id, bundle_id, platform_product_id, source, facts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), bundleId, productId, source, JSON.stringify(EMPTY_FACTS), now, now);
    return 'added';
  }

  /** Adds products from pasted TikTok product links or IDs (one account only). */
  addFromText(bundleId: string, text: string): AddResult {
    this.#require(bundleId);
    if (typeof text !== 'string' || text.length > 20000) throw new AffiliateError('invalid_product_list');
    const parsed = parseProductList(text);
    if (parsed.length === 0 || parsed.length > 200) throw new AffiliateError('invalid_product_list');
    const result: AddResult = { added: [], existing: [], rejected: [] };
    for (const p of parsed) {
      if (!p.productId) {
        result.rejected.push({ line: p.line, input: p.input.slice(0, 120), issue: p.error! });
        continue;
      }
      if (result.added.includes(p.productId) || result.existing.includes(p.productId)) continue;
      (this.#insert(bundleId, p.productId, 'link') === 'added' ? result.added : result.existing).push(p.productId);
    }
    this.#log.info('affiliate_products_added', { bundleId, added: result.added.length, existing: result.existing.length, rejected: result.rejected.length });
    return result;
  }

  /** Adds the product whose page is open in the account's research window (its address only). */
  addFromAddress(bundleId: string, address: string | null): { productId: string; outcome: 'added' | 'existing' } {
    this.#require(bundleId);
    const productId = address ? productIdFromAddress(address) : null;
    if (!productId) throw new AffiliateError('no_product_in_address');
    const outcome = this.#insert(bundleId, productId, 'research_address');
    this.#log.info('affiliate_product_captured', { bundleId, outcome });
    return { productId, outcome };
  }

  remove(bundleId: string, id: string): void {
    this.#require(bundleId);
    this.#row(bundleId, id);
    this.#db.prepare('DELETE FROM affiliate_products WHERE id = ? AND bundle_id = ?').run(id, bundleId);
  }

  dailyLimit(bundleId: string): number {
    const row = this.#db.prepare('SELECT daily_products FROM production_targets WHERE bundle_id = ?').get(bundleId) as { daily_products: number | null } | undefined;
    return row?.daily_products ?? DEFAULT_DAILY_PRODUCTS;
  }

  setDailyLimit(bundleId: string, limit: unknown): void {
    this.#require(bundleId);
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) throw new AffiliateError('invalid_daily_products');
    this.#db
      .prepare(
        `INSERT INTO production_targets (bundle_id, daily_videos, daily_products, updated_at) VALUES (?, 10, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET daily_products = excluded.daily_products, updated_at = excluded.updated_at`,
      )
      .run(bundleId, limit as number, this.#now().toISOString());
  }

  /** Puts a product in (or takes it out of) today's selection, up to the daily limit. */
  select(bundleId: string, id: string, selected: boolean): void {
    this.#require(bundleId);
    const row = this.#row(bundleId, id);
    const today = this.#today();
    if (selected && row.selected_on !== today) {
      const count = (this.#db.prepare('SELECT COUNT(*) AS n FROM affiliate_products WHERE bundle_id = ? AND selected_on = ?').get(bundleId, today) as { n: number }).n;
      if (count >= this.dailyLimit(bundleId)) throw new AffiliateError('daily_selection_full');
    }
    this.#touch(id, 'selected_on = ?', selected ? today : null);
  }

  /** Listing facts the owner verified on the TikTok listing. */
  updateFacts(bundleId: string, id: string, raw: unknown): void {
    this.#require(bundleId);
    this.#row(bundleId, id);
    const valid = validateFacts(raw);
    if (!valid.ok) throw new AffiliateError('invalid_facts', valid.issues);
    this.#touch(id, 'facts_json = ?', JSON.stringify(valid.value));
  }

  /**
   * Facts read from this product's own listing page (A3): title, shop, price,
   * the description (kept in notes) and its feature lines. The page showed
   * this exact product ID, so the listing counts as confirmed. Commission and
   * reference videos the owner entered are kept.
   */
  applyListing(bundleId: string, id: string, listing: { title: string; shopName: string; priceIdr: number | null; description: string; features: readonly string[] }, imageAssetId: string | null): void {
    this.#require(bundleId);
    const row = this.#row(bundleId, id);
    const current = JSON.parse(row.facts_json) as ProductFacts;
    const valid = validateFacts({
      ...current,
      title: listing.title,
      shopName: listing.shopName || current.shopName,
      priceIdr: listing.priceIdr ?? current.priceIdr,
      features: listing.features.length > 0 ? listing.features.slice(0, 20) : current.features,
      notes: listing.description ? listing.description.slice(0, 1000) : current.notes,
    });
    if (!valid.ok) throw new AffiliateError('invalid_facts', valid.issues);
    this.#touch(id, 'facts_json = ?, listing_state = ?, image_asset_id = COALESCE(?, image_asset_id)', JSON.stringify(valid.value), 'confirmed', imageAssetId);
    this.#log.info('listing_read', { bundleId, productRow: id, features: valid.value.features.length, photo: imageAssetId !== null });
  }

  setListing(bundleId: string, id: string, state: unknown): void {
    this.#require(bundleId);
    this.#row(bundleId, id);
    if (state !== 'unverified' && state !== 'confirmed' && state !== 'mismatch') throw new AffiliateError('showcase_action_not_allowed');
    this.#touch(id, 'listing_state = ?', state);
  }

  setEligibility(bundleId: string, id: string, state: unknown): void {
    this.#require(bundleId);
    this.#row(bundleId, id);
    if (state !== 'unknown' && state !== 'can_promote' && state !== 'cannot_promote') throw new AffiliateError('showcase_action_not_allowed');
    this.#touch(id, 'eligibility_state = ?', state);
  }

  /**
   * Assisted Showcase steps. "start" is recorded when the app opens TikTok's
   * Showcase page in the account's window; "confirm_seen" only after the
   * listing was confirmed, and only by the owner.
   */
  showcase(bundleId: string, id: string, action: ShowcaseAction): ShowcaseState {
    this.#require(bundleId);
    const row = this.#row(bundleId, id);
    const rule = SHOWCASE_ACTIONS[action];
    if (!rule || !rule.from.includes(row.showcase_state)) throw new AffiliateError('showcase_action_not_allowed');
    if (action === 'start' && row.listing_state !== 'confirmed') throw new AffiliateError('listing_not_confirmed');
    if (action === 'confirm_seen' && row.listing_state !== 'confirmed') throw new AffiliateError('listing_not_confirmed');
    this.#touch(id, 'showcase_state = ?, showcase_method = ?, showcase_changed_at = ?', rule.to, rule.to === 'not_requested' ? null : 'assisted', this.#now().toISOString());
    this.#log.info('showcase_state_changed', { bundleId, productRow: id, to: rule.to, method: 'assisted' });
    return rule.to;
  }

  productUrl(bundleId: string, id: string): { productId: string; url: string } {
    const row = this.#row(bundleId, id);
    return { productId: row.platform_product_id, url: productPageUrl(row.platform_product_id) };
  }

  view(bundleId: string): AffiliateView {
    this.#require(bundleId);
    const today = this.#today();
    const rows = this.#db.prepare('SELECT * FROM affiliate_products WHERE bundle_id = ? ORDER BY created_at DESC, rowid DESC').all(bundleId) as unknown as Row[];
    const products = rows.map((r): AffiliateProduct => {
      const facts = JSON.parse(r.facts_json) as ProductFacts;
      return {
        id: r.id,
        productId: r.platform_product_id,
        productUrl: productPageUrl(r.platform_product_id),
        source: r.source,
        facts,
        summary: productSummary(facts),
        selectedToday: r.selected_on === today,
        listing: r.listing_state,
        eligibility: r.eligibility_state,
        showcase: r.showcase_state,
        showcaseMethod: r.showcase_method,
        showcaseChangedAt: r.showcase_changed_at,
        imageAssetId: r.image_asset_id ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
    return { products, today, dailyLimit: this.dailyLimit(bundleId), selectedToday: products.filter((p) => p.selectedToday).length };
  }
}
