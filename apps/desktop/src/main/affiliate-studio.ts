import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  AFFILIATE_TEMPLATE,
  BLOCKING_PLAN_FLAGS,
  checkClip,
  checkFinal,
  characterKey,
  characterSheetPrompt,
  clipManualSteps,
  DEFAULT_AFFILIATE_CONFIG,
  duplicatePlans,
  planClipPairs,
  planFlags,
  productReadiness,
  referenceLine,
  productSummary,
  renderText,
  validateAffiliateConfig,
  type AffiliateCreativeConfig,
  type ContinuityMode,
  type Logger,
  type PlanFlag,
  type ProductFacts,
  type PromptContent,
} from '@ugc/core';
import type { FfmpegRunner } from './ffmpeg.js';
import type { FlowPoolService } from './flow-pool.js';
import type { GenerationJob, GenerationStore } from './generation-store.js';
import type { VideoLibrary } from './library.js';
import type { BundleStore, MetadataDb } from './profiles.js';
import type { ReferenceAsset } from './prompt-studio.js';

/**
 * Affiliate Creative Studio (A2). For a selected product: plans of one
 * finished video each (Clip A: hook and demonstration; Clip B: comedic
 * payoff and CTA, as a seamless continuation or a deliberate cut), approved
 * before any credits are spent; clips produced by hand in Google Flow and
 * linked back by download or import; local FFmpeg stitching into one
 * ~16-second MP4 with validation; manual review; a library per account.
 * Attempts, failed renders, unusable outputs and approvals are logged
 * separately; credit budgets are enforced per Flow account. Prompts and
 * product text are never logged.
 */

export type AffiliateStudioErrorCode =
  | 'not_affiliate_account'
  | 'unknown_product'
  | 'product_not_ready'
  | 'invalid_creative_config'
  | 'unknown_video'
  | 'unknown_clip'
  | 'invalid_plan_edit'
  | 'plan_blocked'
  | 'plan_action_not_allowed'
  | 'clip_action_not_allowed'
  | 'attempt_limit_reached'
  | 'product_daily_limit_reached'
  | 'flow_budget_exhausted'
  | 'not_a_flow_account'
  | 'ffmpeg_missing'
  | 'invalid_clip_file'
  | 'stitch_failed'
  | 'invalid_limits'
  | 'invalid_reason'
  | 'nothing_to_send'
  | 'references_missing'
  | 'unknown_character';

export class AffiliateStudioError extends Error {
  constructor(
    readonly code: AffiliateStudioErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export type VideoStatus = 'draft' | 'approved' | 'rejected' | 'producing' | 'stitching' | 'review' | 'final_approved';
export type ClipStatus = 'waiting' | 'in_flow' | 'received' | 'unusable' | 'approved';
export const FAILURE_REASONS = ['refused', 'render_error', 'no_output', 'other'] as const;
export const UNUSABLE_REASONS = ['wrong_product', 'artifacts', 'audio', 'continuity', 'off_script', 'other'] as const;

export interface AffiliateLimits {
  /** Attempts per clip (generation tries, including failed and unusable ones). */
  readonly maxClipAttempts: number;
  /** Finished videos started per product per day. */
  readonly videosPerProductPerDay: number;
}
export const DEFAULT_LIMITS: AffiliateLimits = { maxClipAttempts: 3, videosPerProductPerDay: 10 };

export interface ClipView {
  readonly id: string;
  readonly slot: 'A' | 'B';
  readonly status: ClipStatus;
  readonly flowBundleId: string | null;
  readonly flowName: string | null;
  readonly jobId: string | null;
  readonly attempts: number;
  readonly credits: number;
  readonly lastReason: string | null;
  readonly manualSteps: readonly string[];
  readonly updatedAt: string;
}

export interface AffiliateVideoView {
  readonly id: string;
  readonly productRowId: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly showcase: string;
  readonly batchId: string;
  readonly position: number;
  readonly continuity: ContinuityMode;
  readonly axes: Readonly<Record<string, string>>;
  readonly clipA: PromptContent;
  readonly clipB: PromptContent;
  readonly textA: string;
  readonly textB: string;
  readonly caption: string;
  readonly edited: boolean;
  readonly flags: readonly PlanFlag[];
  readonly duplicates: readonly number[];
  readonly status: VideoStatus;
  readonly clips: readonly ClipView[];
  readonly final: { file: string; durationSeconds: number; width: number; height: number; bytes: number; sha256: string } | null;
  readonly reviewNote: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProductCounts {
  readonly attempts: number;
  readonly generationFailed: number;
  readonly unusable: number;
  readonly clipsApproved: number;
  readonly finalsApproved: number;
  readonly startedToday: number;
}

export interface StudioProduct {
  readonly id: string;
  readonly productId: string;
  readonly title: string;
  readonly summary: string;
  readonly listing: string;
  readonly showcase: string;
  readonly readiness: readonly string[];
  readonly features: readonly string[];
}

export interface StudioCharacter {
  readonly key: string;
  readonly text: string;
  readonly assetId: string | null;
  readonly assetName: string | null;
  readonly sheetPrompt: string;
  /** Plans of this product that use it (not rejected). */
  readonly plans: number;
}

/** What goes into Flow with one clip: its reference images. */
export interface ClipReferences {
  readonly product: { id: string; name: string; path: string } | null;
  readonly character: { id: string; name: string; path: string } | null;
  readonly characterText: string;
}

export interface AffiliateStudioView {
  readonly product: StudioProduct | null;
  readonly config: AffiliateCreativeConfig;
  readonly limits: AffiliateLimits;
  readonly ffmpeg: { available: boolean; version: string | null };
  readonly references: readonly ReferenceAsset[];
  /** Characters this product's plans use, with their reference image (if added) and a sheet prompt for Flow. */
  readonly characters: readonly StudioCharacter[];
  /** The listing photo used as the product reference, if saved. */
  readonly productPhoto: { id: string; name: string } | null;
  readonly videos: readonly AffiliateVideoView[];
  readonly today: ProductCounts | null;
}

interface VideoRow {
  id: string;
  bundle_id: string;
  product_row_id: string;
  product_id: string;
  batch_id: string;
  position: number;
  config_json: string;
  facts_json: string;
  has_reference: number;
  continuity: ContinuityMode;
  axes_json: string;
  clip_a_json: string;
  clip_b_json: string;
  caption: string;
  edited: number;
  flags_json: string;
  duplicates_json: string;
  status: VideoStatus;
  final_file: string | null;
  final_meta_json: string | null;
  final_sha256: string | null;
  review_note: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ClipRow {
  id: string;
  video_id: string;
  bundle_id: string;
  slot: 'A' | 'B';
  status: ClipStatus;
  flow_bundle_id: string | null;
  job_id: string | null;
  attempts: number;
  credits: number;
  last_reason: string | null;
  updated_at: string;
}

export interface AffiliateStudioDeps {
  readonly meta: MetadataDb;
  readonly bundles: BundleStore;
  readonly jobs: GenerationStore;
  readonly library: VideoLibrary;
  readonly pool: FlowPoolService;
  readonly log: Logger;
  /** Reference files (product images) with the owner's rights confirmation. */
  readonly assets: (bundleId: string) => ReferenceAsset[];
  /** Absolute path of a reference file (product photo, character sheet). */
  readonly referencePath?: (bundleId: string, assetId: string) => string;
  /** Resolved once at start; null if FFmpeg isn't installed. */
  readonly ffmpeg: () => FfmpegRunner | null;
  readonly flowSessionOf: (bundleId: string) => string | null;
  readonly now?: () => Date;
}

export class AffiliateStudioService {
  readonly #db: DatabaseSync;
  readonly #deps: AffiliateStudioDeps;
  readonly #now: () => Date;
  readonly #running = new Map<string, Promise<void>>();

  constructor(deps: AffiliateStudioDeps) {
    if (!deps.meta.db) throw new Error('affiliate studio needs a writable database');
    this.#db = deps.meta.db;
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #midnight(): string {
    const n = this.#now();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString();
  }

  #require(bundleId: string): void {
    if (this.#deps.bundles.get(bundleId)?.mode !== 'affiliate_ugc') throw new AffiliateStudioError('not_affiliate_account');
  }

  // ---- Settings ----

  config(bundleId: string): AffiliateCreativeConfig {
    const row = this.#db.prepare('SELECT config_json FROM template_configs WHERE bundle_id = ? AND template_key = ?').get(bundleId, AFFILIATE_TEMPLATE.key) as { config_json: string } | undefined;
    if (!row) return DEFAULT_AFFILIATE_CONFIG;
    const valid = validateAffiliateConfig(JSON.parse(row.config_json));
    return valid.ok ? valid.value : DEFAULT_AFFILIATE_CONFIG;
  }

  saveConfig(bundleId: string, raw: unknown): void {
    this.#require(bundleId);
    const valid = validateAffiliateConfig(raw);
    if (!valid.ok) throw new AffiliateStudioError('invalid_creative_config', valid.issues);
    const images = new Set(this.#deps.assets(bundleId).filter((a) => a.kind === 'image').map((a) => a.id));
    if (!valid.value.referenceAssetIds.every((id) => images.has(id))) throw new AffiliateStudioError('invalid_creative_config', ['invalid_reference_assets']);
    this.#db
      .prepare(
        `INSERT INTO template_configs (bundle_id, template_key, config_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(bundle_id, template_key) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      )
      .run(bundleId, AFFILIATE_TEMPLATE.key, JSON.stringify(valid.value), this.#iso());
  }

  limits(bundleId: string): AffiliateLimits {
    const row = this.#db.prepare('SELECT max_clip_attempts, daily_videos_per_product FROM production_targets WHERE bundle_id = ?').get(bundleId) as
      | { max_clip_attempts: number | null; daily_videos_per_product: number | null }
      | undefined;
    return { maxClipAttempts: row?.max_clip_attempts ?? DEFAULT_LIMITS.maxClipAttempts, videosPerProductPerDay: row?.daily_videos_per_product ?? DEFAULT_LIMITS.videosPerProductPerDay };
  }

  setLimits(bundleId: string, raw: unknown): void {
    this.#require(bundleId);
    const l = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const ok = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
    if (!ok(l['maxClipAttempts'], 20) || !ok(l['videosPerProductPerDay'], 50)) throw new AffiliateStudioError('invalid_limits');
    this.#db
      .prepare(
        `INSERT INTO production_targets (bundle_id, daily_videos, max_clip_attempts, daily_videos_per_product, updated_at) VALUES (?, 10, ?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET max_clip_attempts = excluded.max_clip_attempts, daily_videos_per_product = excluded.daily_videos_per_product, updated_at = excluded.updated_at`,
      )
      .run(bundleId, l['maxClipAttempts'] as number, l['videosPerProductPerDay'] as number, this.#iso());
  }

  // ---- Products ----

  #product(bundleId: string, productRowId: string): { row: { id: string; platform_product_id: string; listing_state: string; showcase_state: string }; facts: ProductFacts } {
    const row = this.#db
      .prepare('SELECT id, platform_product_id, facts_json, listing_state, showcase_state FROM affiliate_products WHERE id = ? AND bundle_id = ?')
      .get(productRowId, bundleId) as { id: string; platform_product_id: string; facts_json: string; listing_state: string; showcase_state: string } | undefined;
    if (!row) throw new AffiliateStudioError('unknown_product');
    return { row, facts: JSON.parse(row.facts_json) as ProductFacts };
  }

  /** The listing photo saved for this product (A3), if it still exists. */
  #productPhoto(bundleId: string, productRowId: string): { id: string; name: string } | null {
    const row = this.#db.prepare('SELECT image_asset_id FROM affiliate_products WHERE id = ? AND bundle_id = ?').get(productRowId, bundleId) as { image_asset_id: string | null } | undefined;
    const asset = row?.image_asset_id ? this.#deps.assets(bundleId).find((a) => a.id === row.image_asset_id && a.kind === 'image') : undefined;
    return asset ? { id: asset.id, name: asset.name } : null;
  }

  #studioProduct(bundleId: string, productRowId: string): StudioProduct {
    const { row, facts } = this.#product(bundleId, productRowId);
    return {
      id: row.id,
      productId: row.platform_product_id,
      title: facts.title,
      summary: productSummary(facts),
      listing: row.listing_state,
      showcase: row.showcase_state,
      readiness: productReadiness(facts, row.listing_state),
      features: facts.features,
    };
  }

  // ---- Plans ----

  /** Plans `count` finished videos (Clip A + Clip B) for one product, as drafts. No credits are involved. */
  generate(bundleId: string, productRowId: string): string {
    this.#require(bundleId);
    const { row, facts } = this.#product(bundleId, productRowId);
    const readiness = productReadiness(facts, row.listing_state);
    if (readiness.length > 0) throw new AffiliateStudioError('product_not_ready', readiness);
    const config = this.config(bundleId);
    const hasRef = config.referenceAssetIds.length > 0 || this.#productPhoto(bundleId, productRowId) !== null;
    const previous = (this.#db.prepare("SELECT axes_json FROM affiliate_videos WHERE product_row_id = ? AND status != 'rejected' ORDER BY created_at DESC LIMIT 60").all(productRowId) as Array<{ axes_json: string }>).map(
      (r) => {
        const { reactor: _r, ...axes } = JSON.parse(r.axes_json) as Record<string, string>;
        return axes;
      },
    );
    const batchId = randomUUID();
    const { plans } = planClipPairs(facts, config, batchId, { hasReferenceImage: hasRef, exclude: previous });
    const now = this.#iso();
    this.#db.exec('BEGIN');
    try {
      plans.forEach((p, i) => {
        const id = randomUUID();
        this.#db
          .prepare(
            `INSERT INTO affiliate_videos (id, bundle_id, product_row_id, product_id, batch_id, position, template_key, template_version, config_json, facts_json, has_reference,
               continuity, axes_json, clip_a_json, clip_b_json, caption, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          )
          .run(
            id,
            bundleId,
            productRowId,
            row.platform_product_id,
            batchId,
            i + 1,
            AFFILIATE_TEMPLATE.key,
            AFFILIATE_TEMPLATE.version,
            JSON.stringify(config),
            JSON.stringify(facts),
            hasRef ? 1 : 0,
            p.continuity,
            JSON.stringify(p.axes),
            JSON.stringify(p.clipA),
            JSON.stringify(p.clipB),
            p.caption,
            now,
            now,
          );
        for (const slot of ['A', 'B'] as const) {
          this.#db.prepare("INSERT INTO affiliate_clips (id, video_id, bundle_id, slot, status, updated_at) VALUES (?, ?, ?, ?, 'waiting', ?)").run(randomUUID(), id, bundleId, slot, now);
        }
      });
      this.#refreshFlags(batchId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#deps.log.info('affiliate_plans_generated', { bundleId, batchId, product: productRowId, plans: plans.length });
    return batchId;
  }

  #video(bundleId: string, id: string): VideoRow {
    const row = this.#db.prepare('SELECT * FROM affiliate_videos WHERE id = ? AND bundle_id = ?').get(id, bundleId) as unknown as VideoRow | undefined;
    if (!row) throw new AffiliateStudioError('unknown_video');
    return row;
  }

  #clip(bundleId: string, id: string): ClipRow {
    const row = this.#db.prepare('SELECT * FROM affiliate_clips WHERE id = ? AND bundle_id = ?').get(id, bundleId) as unknown as ClipRow | undefined;
    if (!row) throw new AffiliateStudioError('unknown_clip');
    return row;
  }

  #clipsOf(videoId: string): { A: ClipRow; B: ClipRow } {
    const rows = this.#db.prepare('SELECT * FROM affiliate_clips WHERE video_id = ?').all(videoId) as unknown as ClipRow[];
    return { A: rows.find((r) => r.slot === 'A')!, B: rows.find((r) => r.slot === 'B')! };
  }

  #refreshFlags(batchId: string): void {
    const rows = this.#db.prepare('SELECT * FROM affiliate_videos WHERE batch_id = ? ORDER BY position').all(batchId) as unknown as VideoRow[];
    const active = rows.filter((r) => r.status !== 'rejected');
    const dups = duplicatePlans(active.map((r) => ({ clipA: JSON.parse(r.clip_a_json) as PromptContent, clipB: JSON.parse(r.clip_b_json) as PromptContent })));
    for (const r of rows) {
      const k = active.indexOf(r);
      const duplicates = k >= 0 ? dups[k]!.map((j) => active[j]!.position) : [];
      const flags = planFlags(
        JSON.parse(r.facts_json) as ProductFacts,
        { continuity: r.continuity, clipA: JSON.parse(r.clip_a_json), clipB: JSON.parse(r.clip_b_json), axes: JSON.parse(r.axes_json) },
        r.has_reference === 1,
      );
      if (duplicates.length > 0) flags.push('near_duplicate');
      this.#db.prepare('UPDATE affiliate_videos SET flags_json = ?, duplicates_json = ? WHERE id = ?').run(JSON.stringify(flags), JSON.stringify(duplicates), r.id);
    }
  }

  /** Owner edits of both clips' sections and the caption; the plan returns to draft. */
  updatePlan(bundleId: string, videoId: string, raw: unknown): void {
    this.#require(bundleId);
    const v = this.#video(bundleId, videoId);
    if (v.status !== 'draft' && v.status !== 'approved' && v.status !== 'rejected') throw new AffiliateStudioError('plan_action_not_allowed');
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const merge = (current: PromptContent, edits: unknown): PromptContent => {
      if (!Array.isArray(edits) || edits.length !== current.sections.length) throw new AffiliateStudioError('invalid_plan_edit');
      return {
        sections: current.sections.map((s, i) => {
          const e = edits[i] as { key?: unknown; text?: unknown };
          if (e?.key !== s.key || typeof e.text !== 'string' || e.text.trim() === '' || e.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(e.text)) {
            throw new AffiliateStudioError('invalid_plan_edit');
          }
          return { ...s, text: e.text.trim() };
        }),
        caption: '',
      };
    };
    const clipA = merge(JSON.parse(v.clip_a_json) as PromptContent, body['clipA']);
    const clipB = merge(JSON.parse(v.clip_b_json) as PromptContent, body['clipB']);
    const caption = body['caption'];
    if (typeof caption !== 'string' || caption.length > 2200) throw new AffiliateStudioError('invalid_plan_edit');
    this.#db
      .prepare("UPDATE affiliate_videos SET clip_a_json = ?, clip_b_json = ?, caption = ?, edited = 1, status = 'draft', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(clipA), JSON.stringify(clipB), caption.trim(), this.#iso(), videoId);
    this.#refreshFlags(v.batch_id);
  }

  /** approve (the step before any credits are spent), reject, or reopen a plan. */
  planAction(bundleId: string, videoId: string, action: 'approve' | 'reject' | 'reopen'): void {
    this.#require(bundleId);
    const v = this.#video(bundleId, videoId);
    const from: Record<string, VideoStatus[]> = { approve: ['draft'], reject: ['draft', 'approved'], reopen: ['approved', 'rejected'] };
    const to: Record<string, VideoStatus> = { approve: 'approved', reject: 'rejected', reopen: 'draft' };
    if (!from[action]?.includes(v.status)) throw new AffiliateStudioError('plan_action_not_allowed');
    if (action === 'approve') {
      const blocking = (JSON.parse(v.flags_json) as PlanFlag[]).filter((f) => BLOCKING_PLAN_FLAGS.includes(f));
      if (blocking.length > 0) throw new AffiliateStudioError('plan_blocked', blocking);
    }
    this.#db.prepare('UPDATE affiliate_videos SET status = ?, updated_at = ? WHERE id = ?').run(to[action]!, this.#iso(), videoId);
    if (action !== 'approve') this.#refreshFlags(v.batch_id);
  }

  /** Approves every draft plan of this product that has no blocking flag (A3). */
  approveAll(bundleId: string, productRowId: string): { approved: number; blocked: number } {
    this.#require(bundleId);
    const drafts = this.#db
      .prepare("SELECT id, flags_json FROM affiliate_videos WHERE bundle_id = ? AND product_row_id = ? AND status = 'draft' ORDER BY created_at, position")
      .all(bundleId, productRowId) as Array<{ id: string; flags_json: string }>;
    let approved = 0;
    for (const d of drafts) {
      if ((JSON.parse(d.flags_json) as PlanFlag[]).some((f) => BLOCKING_PLAN_FLAGS.includes(f))) continue;
      this.#db.prepare("UPDATE affiliate_videos SET status = 'approved', updated_at = ? WHERE id = ?").run(this.#iso(), d.id);
      approved++;
    }
    return { approved, blocked: drafts.length - approved };
  }

  /** One click (A3): plans the configured number of videos for this product and approves those without a blocking flag. */
  makeVideos(bundleId: string, productRowId: string): { batchId: string; approved: number; blocked: number } {
    const batchId = this.generate(bundleId, productRowId);
    return { batchId, ...this.approveAll(bundleId, productRowId) };
  }

  /**
   * The next clip to take to Flow (A3), in plan order: Clip A, then Clip B, of
   * each approved video; unusable clips come back while attempts remain. Only
   * one clip of a product is in Flow at a time, so each download is matched
   * to the right clip.
   */
  nextClip(bundleId: string, productRowId: string): string {
    this.#require(bundleId);
    const inFlow = this.#db
      .prepare("SELECT v.position AS position, c.slot AS slot FROM affiliate_clips c JOIN affiliate_videos v ON v.id = c.video_id WHERE v.bundle_id = ? AND v.product_row_id = ? AND c.status = 'in_flow' LIMIT 1")
      .get(bundleId, productRowId) as { position: number; slot: string } | undefined;
    if (inFlow) throw new AffiliateStudioError('nothing_to_send', ['clip_in_flow', `${inFlow.position}${inFlow.slot}`]);
    const next = this.#db
      .prepare(
        `SELECT c.id AS id FROM affiliate_clips c JOIN affiliate_videos v ON v.id = c.video_id
         WHERE v.bundle_id = ? AND v.product_row_id = ? AND v.status IN ('approved', 'producing') AND c.status IN ('waiting', 'unusable') AND c.attempts < ?
         ORDER BY v.created_at, v.position, c.slot LIMIT 1`,
      )
      .get(bundleId, productRowId, this.limits(bundleId).maxClipAttempts) as { id: string } | undefined;
    if (!next) throw new AffiliateStudioError('nothing_to_send', ['nothing_waiting']);
    return next.id;
  }

  // ---- Clip production ----

  #event(bundleId: string, productId: string, videoId: string, clipId: string | null, flow: string | null, kind: string, reason: string | null, credits = 0): void {
    this.#db
      .prepare('INSERT INTO production_events (bundle_id, product_id, video_id, clip_id, flow_bundle_id, at, kind, reason, credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(bundleId, productId, videoId, clipId, flow, this.#iso(), kind, reason, credits);
  }

  #startedToday(productRowId: string): Set<string> {
    return new Set(
      (
        this.#db
          .prepare(
            "SELECT DISTINCT e.video_id AS id FROM production_events e JOIN affiliate_videos v ON v.id = e.video_id WHERE v.product_row_id = ? AND e.kind = 'attempt' AND e.at >= ?",
          )
          .all(productRowId, this.#midnight()) as Array<{ id: string }>
      ).map((r) => r.id),
    );
  }

  /**
   * Takes one clip of an approved plan to a Flow account (a pool account
   * chosen by credits, or a given account's own Flow session). Checks the
   * attempt limit, the product's daily limit and that Flow account's credit
   * budget; counts an attempt. Returns the prompt text to paste in Flow.
   */
  handOff(bundleId: string, clipId: string, flowBundleId: string | null): { text: string; flowBundleId: string } {
    this.#require(bundleId);
    const clip = this.#clip(bundleId, clipId);
    const v = this.#video(bundleId, clip.video_id);
    if (!['approved', 'producing', 'review'].includes(v.status)) throw new AffiliateStudioError('clip_action_not_allowed', ['plan_not_approved']);
    if (clip.status !== 'waiting' && clip.status !== 'unusable' && clip.status !== 'in_flow') throw new AffiliateStudioError('clip_action_not_allowed');
    const limits = this.limits(bundleId);
    if (clip.attempts >= limits.maxClipAttempts) throw new AffiliateStudioError('attempt_limit_reached');
    const started = this.#startedToday(v.product_row_id);
    if (!started.has(v.id) && started.size >= limits.videosPerProductPerDay) throw new AffiliateStudioError('product_daily_limit_reached');
    let flow: string;
    if (flowBundleId === null) {
      flow = this.#deps.pool.pick().id;
    } else {
      if (!this.#deps.flowSessionOf(flowBundleId)) throw new AffiliateStudioError('not_a_flow_account');
      flow = flowBundleId;
    }
    const budget = this.#deps.pool.canSpend(flow);
    if (!budget.ok) throw new AffiliateStudioError('flow_budget_exhausted', [budget.reason]);
    // One clip per Flow window at a time: a download is filed under the clip that window is waiting for.
    const waiting = this.#db.prepare("SELECT 1 FROM affiliate_clips WHERE flow_bundle_id = ? AND status = 'in_flow' AND id != ? LIMIT 1").get(flow, clipId);
    if (waiting) throw new AffiliateStudioError('clip_action_not_allowed', ['another_clip_in_flow']);
    this.#db
      .prepare("UPDATE affiliate_clips SET status = 'in_flow', flow_bundle_id = ?, job_id = NULL, attempts = attempts + 1, last_reason = NULL, updated_at = ? WHERE id = ?")
      .run(flow, this.#iso(), clipId);
    this.#db.prepare("UPDATE affiliate_videos SET status = 'producing', last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('approved', 'review')").run(this.#iso(), v.id);
    this.#event(bundleId, v.product_id, v.id, clipId, flow, 'attempt', null);
    this.#deps.log.info('affiliate_clip_handoff', { bundleId, video: v.id, slot: clip.slot, flow });
    return { text: this.clipText(bundleId, clipId), flowBundleId: flow };
  }

  // ---- Reference images for Flow (product photo + character sheet) ----

  #characterAsset(bundleId: string, text: string): { id: string; name: string } | null {
    const row = this.#db.prepare('SELECT asset_id FROM affiliate_characters WHERE bundle_id = ? AND character_key = ?').get(bundleId, characterKey(text)) as { asset_id: string } | undefined;
    const asset = row ? this.#deps.assets(bundleId).find((a) => a.id === row.asset_id && a.kind === 'image') : undefined;
    return asset ? { id: asset.id, name: asset.name } : null;
  }

  /** Characters used by this product's plans (not rejected), most used first. */
  characters(bundleId: string, productRowId: string): StudioCharacter[] {
    this.#require(bundleId);
    const config = this.config(bundleId);
    const counts = new Map<string, number>();
    for (const r of this.#db.prepare("SELECT axes_json FROM affiliate_videos WHERE bundle_id = ? AND product_row_id = ? AND status != 'rejected'").all(bundleId, productRowId) as Array<{ axes_json: string }>) {
      const c = (JSON.parse(r.axes_json) as Record<string, string>)['character'];
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([text, plans]) => {
        const asset = this.#characterAsset(bundleId, text);
        return { key: characterKey(text), text, assetId: asset?.id ?? null, assetName: asset?.name ?? null, sheetPrompt: characterSheetPrompt(text, config.style), plans };
      });
  }

  /** Links a character description to its reference image (an image reference of this account). */
  setCharacterImage(bundleId: string, productRowId: string, key: string, assetId: string): void {
    this.#require(bundleId);
    const character = this.characters(bundleId, productRowId).find((c) => c.key === key);
    if (!character) throw new AffiliateStudioError('unknown_character');
    if (!this.#deps.assets(bundleId).some((a) => a.id === assetId && a.kind === 'image')) throw new AffiliateStudioError('unknown_character', ['not_an_image']);
    this.#db
      .prepare(
        `INSERT INTO affiliate_characters (bundle_id, character_key, character_text, asset_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bundle_id, character_key) DO UPDATE SET character_text = excluded.character_text, asset_id = excluded.asset_id, updated_at = excluded.updated_at`,
      )
      .run(bundleId, key, character.text, assetId, this.#iso());
  }

  /** The product photo and the character sheet that go into Flow with this clip. */
  clipReferences(bundleId: string, clipId: string): ClipReferences {
    const clip = this.#clip(bundleId, clipId);
    const v = this.#video(bundleId, clip.video_id);
    const characterText = (JSON.parse(v.axes_json) as Record<string, string>)['character'] ?? '';
    const withPath = (a: { id: string; name: string } | null) => (a && this.#deps.referencePath ? { ...a, path: this.#deps.referencePath(bundleId, a.id) } : null);
    return {
      product: withPath(this.#productPhoto(bundleId, v.product_row_id)),
      character: characterText ? withPath(this.#characterAsset(bundleId, characterText)) : null,
      characterText,
    };
  }

  /** Refuses a hand-off without the product photo or the character sheet, unless the owner chose to send anyway. */
  requireReferences(bundleId: string, clipId: string): ClipReferences {
    const refs = this.clipReferences(bundleId, clipId);
    const missing = [...(refs.product ? [] : ['product_photo']), ...(refs.character ? [] : ['character_sheet'])];
    if (missing.length > 0) throw new AffiliateStudioError('references_missing', missing);
    return refs;
  }

  /** The prompt text of a clip (to copy again). */
  clipText(bundleId: string, clipId: string): string {
    const clip = this.#clip(bundleId, clipId);
    const v = this.#video(bundleId, clip.video_id);
    const refs = this.clipReferences(bundleId, clipId);
    const line = referenceLine({ product: refs.product !== null, character: refs.character !== null });
    return [renderText(JSON.parse(clip.slot === 'A' ? v.clip_a_json : v.clip_b_json) as PromptContent), line].filter(Boolean).join('\n\n');
  }

  /** For the Flow download handler: the oldest clip waiting in this Flow account's window. */
  claimForFlow(flowBundleId: string): { clipId: string; targetBundleId: string; since: string } | null {
    const row = this.#db
      .prepare(
        `SELECT id, bundle_id, updated_at FROM affiliate_clips c WHERE status = 'in_flow' AND flow_bundle_id = ?
         AND NOT EXISTS (SELECT 1 FROM generation_jobs j WHERE j.affiliate_clip_id = c.id AND j.state IN ('pending', 'running'))
         ORDER BY updated_at, rowid LIMIT 1`,
      )
      .get(flowBundleId) as { id: string; bundle_id: string; updated_at: string } | undefined;
    return row ? { clipId: row.id, targetBundleId: row.bundle_id, since: row.updated_at } : null;
  }

  /** The owner reports that Flow refused or failed to render this clip (no file). */
  clipFailed(bundleId: string, clipId: string, reason: string): void {
    this.#require(bundleId);
    if (!(FAILURE_REASONS as readonly string[]).includes(reason)) throw new AffiliateStudioError('invalid_reason');
    const clip = this.#clip(bundleId, clipId);
    if (clip.status !== 'in_flow') throw new AffiliateStudioError('clip_action_not_allowed');
    const v = this.#video(bundleId, clip.video_id);
    this.#db.prepare("UPDATE affiliate_clips SET status = 'waiting', last_reason = ?, updated_at = ? WHERE id = ?").run(`generation_failed:${reason}`, this.#iso(), clipId);
    this.#event(bundleId, v.product_id, v.id, clipId, clip.flow_bundle_id, 'generation_failed', reason);
  }

  /** The owner rejects a received clip before stitching (file kept; counts as an unusable output). */
  markUnusable(bundleId: string, clipId: string, reason: string): void {
    this.#require(bundleId);
    if (!(UNUSABLE_REASONS as readonly string[]).includes(reason)) throw new AffiliateStudioError('invalid_reason');
    const clip = this.#clip(bundleId, clipId);
    if (clip.status !== 'received') throw new AffiliateStudioError('clip_action_not_allowed');
    this.#unusable(bundleId, clip, reason);
  }

  #unusable(bundleId: string, clip: ClipRow, reason: string): void {
    const v = this.#video(bundleId, clip.video_id);
    this.#db.prepare("UPDATE affiliate_clips SET status = 'unusable', last_reason = ?, updated_at = ? WHERE id = ?").run(`unusable:${reason}`, this.#iso(), clip.id);
    this.#db.prepare("UPDATE affiliate_videos SET status = 'producing', updated_at = ? WHERE id = ? AND status IN ('review', 'stitching')").run(this.#iso(), v.id);
    this.#event(bundleId, v.product_id, v.id, clip.id, clip.flow_bundle_id, 'unusable_output', reason);
  }

  /** A download or import for a clip finished: validate it, count its credits, stitch when both clips are in. */
  async jobEnded(job: GenerationJob, credits: number): Promise<void> {
    if (!job.affiliateClipId) return;
    const clip = this.#db.prepare('SELECT * FROM affiliate_clips WHERE id = ? AND bundle_id = ?').get(job.affiliateClipId, job.bundleId) as unknown as ClipRow | undefined;
    if (!clip || (clip.status !== 'in_flow' && clip.status !== 'waiting' && clip.status !== 'unusable')) return;
    const v = this.#video(job.bundleId, clip.video_id);
    if (job.state !== 'completed' || !job.videoFile) {
      this.#db.prepare('UPDATE affiliate_clips SET last_reason = ?, updated_at = ? WHERE id = ?').run('download_failed', this.#iso(), clip.id);
      return;
    }
    this.#db.prepare('UPDATE affiliate_clips SET credits = credits + ?, job_id = ?, updated_at = ? WHERE id = ?').run(credits, job.id, this.#iso(), clip.id);
    const ff = this.#deps.ffmpeg();
    if (!ff) {
      this.#db.prepare("UPDATE affiliate_clips SET status = 'received', last_reason = 'not_validated_ffmpeg_missing' WHERE id = ?").run(clip.id);
      return;
    }
    let issues: string[];
    try {
      const check = checkClip(await ff.probe(this.#deps.library.absolute(job.videoFile)));
      issues = check.issues;
    } catch {
      issues = ['unreadable'];
    }
    if (issues.length > 0) {
      // A file arrived (credits were spent) but it isn't a usable clip.
      this.#unusable(job.bundleId, { ...clip, flow_bundle_id: job.flowBundleId ?? clip.flow_bundle_id }, `invalid_clip:${issues.join('+')}`);
      return;
    }
    this.#db.prepare("UPDATE affiliate_clips SET status = 'received', last_reason = NULL, updated_at = ? WHERE id = ?").run(this.#iso(), clip.id);
    const both = this.#clipsOf(v.id);
    if (both.A.status === 'received' && both.B.status === 'received') await this.stitch(job.bundleId, v.id);
  }

  /** Imports a clip file the owner downloaded elsewhere (validated MP4 copied into the account library). */
  async importClip(bundleId: string, clipId: string, sourcePath: string): Promise<GenerationJob> {
    this.#require(bundleId);
    const clip = this.#clip(bundleId, clipId);
    const v = this.#video(bundleId, clip.video_id);
    if (!['approved', 'producing', 'review'].includes(v.status)) throw new AffiliateStudioError('clip_action_not_allowed', ['plan_not_approved']);
    if (clip.status === 'received' || clip.status === 'approved') throw new AffiliateStudioError('clip_action_not_allowed');
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isFile() || info.size > 512 * 1024 * 1024) throw new AffiliateStudioError('invalid_clip_file', ['unreadable']);
    if (clip.status !== 'in_flow') {
      const limits = this.limits(bundleId);
      if (clip.attempts >= limits.maxClipAttempts) throw new AffiliateStudioError('attempt_limit_reached');
      this.#db.prepare('UPDATE affiliate_clips SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(this.#iso(), clipId);
      this.#db.prepare("UPDATE affiliate_videos SET status = 'producing', updated_at = ? WHERE id = ? AND status IN ('approved', 'review')").run(this.#iso(), v.id);
      this.#event(bundleId, v.product_id, v.id, clipId, null, 'attempt', 'import');
    }
    const job = this.#deps.jobs.create({
      bundleId,
      source: 'manual_download',
      providerId: 'local-import',
      settings: null,
      affiliateClipId: clipId,
      flowBundleId: clip.status === 'in_flow' ? clip.flow_bundle_id : null,
    });
    this.#deps.jobs.transition(job.id, 'running', { code: 'import_started' });
    const part = this.#deps.library.partPath(bundleId, job.id);
    await copyFile(sourcePath, part);
    const stored = this.#deps.library.finalize(part);
    if (!stored) {
      this.#deps.jobs.transition(job.id, 'failed', { errorCode: 'output_invalid' });
      throw new AffiliateStudioError('invalid_clip_file', ['not_mp4']);
    }
    const done = this.#deps.jobs.transition(job.id, 'completed', { video: stored, code: 'local_import' });
    const credits = this.#deps.pool.recordDownload(done);
    await this.jobEnded(done, credits);
    return done;
  }

  /** Saves Clip A's last frame as a PNG (for a seamless Clip B in Flow). Returns its absolute path. */
  async exportLastFrame(bundleId: string, clipId: string): Promise<string> {
    this.#require(bundleId);
    const clip = this.#clip(bundleId, clipId);
    if (!clip.job_id || (clip.status !== 'received' && clip.status !== 'approved')) throw new AffiliateStudioError('clip_action_not_allowed');
    const ff = this.#deps.ffmpeg();
    if (!ff) throw new AffiliateStudioError('ffmpeg_missing');
    const job = this.#deps.jobs.get(clip.job_id)!;
    const dir = join(this.#deps.library.dirFor(bundleId), 'frames');
    await mkdir(dir, { recursive: true });
    const png = join(dir, `${clip.video_id}-${clip.slot}-last.png`);
    await ff.lastFrame(this.#deps.library.absolute(job.videoFile!), png);
    return png;
  }

  /** Joins Clip A and Clip B into one MP4 and validates it; the video then waits for the owner's review. */
  async stitch(bundleId: string, videoId: string): Promise<void> {
    const pending = this.#running.get(videoId);
    if (pending) return pending;
    const run = this.#stitch(bundleId, videoId).finally(() => this.#running.delete(videoId));
    this.#running.set(videoId, run);
    return run;
  }

  async #stitch(bundleId: string, videoId: string): Promise<void> {
    this.#require(bundleId);
    const v = this.#video(bundleId, videoId);
    const { A, B } = this.#clipsOf(videoId);
    if (A.status !== 'received' || B.status !== 'received' || !A.job_id || !B.job_id) throw new AffiliateStudioError('clip_action_not_allowed', ['clips_not_ready']);
    const ff = this.#deps.ffmpeg();
    if (!ff) throw new AffiliateStudioError('ffmpeg_missing');
    this.#db.prepare("UPDATE affiliate_videos SET status = 'stitching', last_error = NULL, updated_at = ? WHERE id = ?").run(this.#iso(), videoId);
    const fail = (code: string): never => {
      this.#db.prepare("UPDATE affiliate_videos SET status = 'producing', last_error = ?, updated_at = ? WHERE id = ?").run(code, this.#iso(), videoId);
      this.#event(bundleId, v.product_id, videoId, null, null, 'stitch_failed', code);
      throw new AffiliateStudioError('stitch_failed', [code]);
    };
    const files = [A, B].map((c) => this.#deps.library.absolute(this.#deps.jobs.get(c.job_id!)!.videoFile!));
    const dir = join(this.#deps.library.dirFor(bundleId), 'finals');
    await mkdir(dir, { recursive: true });
    const version = (this.#db.prepare("SELECT COUNT(*) AS n FROM production_events WHERE video_id = ? AND kind IN ('final_rejected', 'stitch_failed')").get(videoId) as { n: number }).n + 1;
    const out = join(dir, `${videoId}-v${version}.mp4`);
    try {
      const probes = await Promise.all(files.map((f) => ff.probe(f)));
      const checks = probes.map((p) => checkClip(p));
      if (checks.some((c) => !c.ok)) return fail('invalid_clip');
      await ff.stitch(
        [
          { file: files[0]!, hasAudio: checks[0]!.hasAudio, durationSeconds: checks[0]!.durationSeconds },
          { file: files[1]!, hasAudio: checks[1]!.hasAudio, durationSeconds: checks[1]!.durationSeconds },
        ],
        out,
      );
    } catch (err) {
      if (err instanceof AffiliateStudioError) throw err;
      await rm(out, { force: true });
      return fail('ffmpeg_error');
    }
    const probe = await ff.probe(out).catch(() => null);
    const issues = probe ? checkFinal(probe) : ['unreadable'];
    if (issues.length > 0 || !(await ff.decodes(out))) {
      await rm(out, { force: true });
      return fail(`invalid_output:${issues.join('+') || 'decode_errors'}`);
    }
    const bytes = await readFile(out);
    const video = probe!.streams.find((s) => s.codecType === 'video')!;
    const meta = { durationSeconds: Math.round(probe!.durationSeconds * 100) / 100, width: video.width!, height: video.height!, bytes: bytes.byteLength };
    const rel = `library/${bundleId}/finals/${videoId}-v${version}.mp4`;
    this.#db
      .prepare("UPDATE affiliate_videos SET status = 'review', final_file = ?, final_meta_json = ?, final_sha256 = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(rel, JSON.stringify(meta), createHash('sha256').update(bytes).digest('hex'), this.#iso(), videoId);
    this.#deps.log.info('affiliate_video_stitched', { bundleId, video: videoId, seconds: meta.durationSeconds });
  }

  /** The owner's review of the finished video. Rejecting sends the chosen clip(s) back for another attempt. */
  review(bundleId: string, videoId: string, decision: { approve: true } | { approve: false; reason: string; redo: 'A' | 'B' | 'both' }): void {
    this.#require(bundleId);
    const v = this.#video(bundleId, videoId);
    if (v.status !== 'review') throw new AffiliateStudioError('plan_action_not_allowed');
    const { A, B } = this.#clipsOf(videoId);
    if (decision.approve) {
      this.#db.prepare("UPDATE affiliate_videos SET status = 'final_approved', review_note = NULL, updated_at = ? WHERE id = ?").run(this.#iso(), videoId);
      for (const c of [A, B]) {
        this.#db.prepare("UPDATE affiliate_clips SET status = 'approved', updated_at = ? WHERE id = ?").run(this.#iso(), c.id);
        this.#event(bundleId, v.product_id, videoId, c.id, c.flow_bundle_id, 'clip_approved', null);
      }
      this.#event(bundleId, v.product_id, videoId, null, null, 'final_approved', null);
      return;
    }
    if (!(UNUSABLE_REASONS as readonly string[]).includes(decision.reason) || !['A', 'B', 'both'].includes(decision.redo)) throw new AffiliateStudioError('invalid_reason');
    this.#event(bundleId, v.product_id, videoId, null, null, 'final_rejected', decision.reason);
    this.#db.prepare('UPDATE affiliate_videos SET review_note = ?, updated_at = ? WHERE id = ?').run(decision.reason, this.#iso(), videoId);
    for (const c of decision.redo === 'both' ? [A, B] : decision.redo === 'A' ? [A] : [B]) this.#unusable(bundleId, c, decision.reason);
  }

  /** Waits for running stitches (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }

  // ---- Views ----

  #counts(productRowId: string): ProductCounts {
    const n = (kind: string) =>
      (
        this.#db
          .prepare('SELECT COUNT(*) AS n FROM production_events e JOIN affiliate_videos v ON v.id = e.video_id WHERE v.product_row_id = ? AND e.kind = ? AND e.at >= ?')
          .get(productRowId, kind, this.#midnight()) as { n: number }
      ).n;
    return {
      attempts: n('attempt'),
      generationFailed: n('generation_failed'),
      unusable: n('unusable_output'),
      clipsApproved: n('clip_approved'),
      finalsApproved: n('final_approved'),
      startedToday: this.#startedToday(productRowId).size,
    };
  }

  #videoView(r: VideoRow): AffiliateVideoView {
    const { A, B } = this.#clipsOf(r.id);
    const facts = JSON.parse(r.facts_json) as ProductFacts;
    const config = JSON.parse(r.config_json) as AffiliateCreativeConfig;
    const photo = this.#productPhoto(r.bundle_id, r.product_row_id);
    const characterText = (JSON.parse(r.axes_json) as Record<string, string>)['character'] ?? '';
    const sheet = characterText ? this.#characterAsset(r.bundle_id, characterText) : null;
    const others = this.#deps.assets(r.bundle_id).filter((a) => config.referenceAssetIds.includes(a.id) && a.id !== photo?.id && a.id !== sheet?.id).map((a) => a.name);
    const refs = { product: photo !== null, character: sheet !== null, others };
    const product = this.#db.prepare('SELECT showcase_state FROM affiliate_products WHERE id = ?').get(r.product_row_id) as { showcase_state: string } | undefined;
    const clipView = (c: ClipRow): ClipView => ({
      id: c.id,
      slot: c.slot,
      status: c.status,
      flowBundleId: c.flow_bundle_id,
      flowName: c.flow_bundle_id ? (this.#deps.bundles.get(c.flow_bundle_id)?.displayName ?? null) : null,
      jobId: c.job_id,
      attempts: c.attempts,
      credits: c.credits,
      lastReason: c.last_reason,
      manualSteps: clipManualSteps(r.continuity, c.slot, refs),
      updatedAt: c.updated_at,
    });
    const clipA = JSON.parse(r.clip_a_json) as PromptContent;
    const clipB = JSON.parse(r.clip_b_json) as PromptContent;
    const meta = r.final_meta_json ? (JSON.parse(r.final_meta_json) as { durationSeconds: number; width: number; height: number; bytes: number }) : null;
    return {
      id: r.id,
      productRowId: r.product_row_id,
      productId: r.product_id,
      productTitle: facts.title,
      showcase: product?.showcase_state ?? 'unknown',
      batchId: r.batch_id,
      position: r.position,
      continuity: r.continuity,
      axes: JSON.parse(r.axes_json) as Record<string, string>,
      clipA,
      clipB,
      textA: renderText(clipA),
      textB: renderText(clipB),
      caption: r.caption,
      edited: r.edited === 1,
      flags: JSON.parse(r.flags_json) as PlanFlag[],
      duplicates: JSON.parse(r.duplicates_json) as number[],
      status: r.status,
      clips: [clipView(A), clipView(B)],
      final: r.final_file && meta ? { file: r.final_file, sha256: r.final_sha256 ?? '', ...meta } : null,
      reviewNote: r.review_note,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  view(bundleId: string, productRowId: string): AffiliateStudioView {
    this.#require(bundleId);
    const product = this.#studioProduct(bundleId, productRowId);
    const rows = this.#db.prepare('SELECT * FROM affiliate_videos WHERE bundle_id = ? AND product_row_id = ? ORDER BY created_at DESC, position').all(bundleId, productRowId) as unknown as VideoRow[];
    const ff = this.#deps.ffmpeg();
    return {
      product,
      config: this.config(bundleId),
      limits: this.limits(bundleId),
      ffmpeg: { available: !!ff, version: ff?.install.version ?? null },
      references: this.#deps.assets(bundleId).filter((a) => a.kind === 'image'),
      characters: this.characters(bundleId, productRowId),
      productPhoto: this.#productPhoto(bundleId, productRowId),
      videos: rows.map((r) => this.#videoView(r)),
      today: this.#counts(productRowId),
    };
  }

  /** Every video of the account past the draft stage, newest first (the Affiliate Video Library). */
  library(bundleId: string): { videos: AffiliateVideoView[]; ffmpeg: { available: boolean; version: string | null } } {
    this.#require(bundleId);
    const rows = this.#db
      .prepare("SELECT * FROM affiliate_videos WHERE bundle_id = ? AND status NOT IN ('draft', 'rejected') ORDER BY updated_at DESC")
      .all(bundleId) as unknown as VideoRow[];
    const ff = this.#deps.ffmpeg();
    return { videos: rows.map((r) => this.#videoView(r)), ffmpeg: { available: !!ff, version: ff?.install.version ?? null } };
  }

  /** Absolute path of a finished video (for the media protocol and Show in folder). */
  finalPath(videoId: string): string | null {
    const row = this.#db.prepare('SELECT final_file FROM affiliate_videos WHERE id = ?').get(videoId) as { final_file: string | null } | undefined;
    return row?.final_file ? this.#deps.library.absolute(row.final_file) : null;
  }
}
