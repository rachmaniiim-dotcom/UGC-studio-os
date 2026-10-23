import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { captionFlags, type CaptionFlag, type Logger, type ReferenceAnalysis } from '@ugc/core';
import type { GenerationJob, GenerationStore } from './generation-store.js';
import type { VideoLibrary } from './library.js';
import { AnalysisError, type AnalysisService } from './media-analyzer.js';
import type { BundleStore, MetadataDb } from './profiles.js';
import type { PromptBatch, PromptStudioService } from './prompt-studio.js';

/**
 * Ternak Akun posting queue (G1). Two sources feed one queue per account:
 * ready-made MP4s the owner imports (copied into the library; originals are
 * never moved or changed) and AI-generated videos finished through the
 * existing Flow workflow. Each video gets a caption and hashtags from a
 * multimodal analysis of the actual video (plus the prompt it was made from,
 * if any); a video the model can't make out is flagged, never guessed.
 * Duplicates are caught by file hash. Posting is the owner's: the app opens
 * TikTok's own upload page with the caption on the clipboard and records
 * "posted" only when the owner says so.
 */

export type QueueStatus = 'analyzing' | 'needs_review' | 'ready' | 'posted' | 'rejected' | 'analysis_failed';
export type QueueFlag = CaptionFlag | 'duplicate_in_other_account';
export type GrowthQueueErrorCode = 'not_growth_account' | 'unknown_queue_item' | 'queue_action_not_allowed' | 'invalid_caption' | 'invalid_post_url' | 'unknown_reference' | 'invalid_reference_request';

export class GrowthQueueError extends Error {
  constructor(
    readonly code: GrowthQueueErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface QueueItem {
  readonly id: string;
  readonly source: 'ready_made' | 'ai_generated';
  readonly jobId: string;
  readonly promptItemId: string | null;
  readonly originalName: string;
  readonly status: QueueStatus;
  readonly caption: string;
  readonly hashtags: readonly string[];
  readonly summary: string;
  readonly note: string;
  readonly flags: readonly QueueFlag[];
  readonly analysisError: string | null;
  readonly captionEdited: boolean;
  readonly postUrl: string | null;
  readonly postedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FypReference {
  readonly id: string;
  readonly assetIds: readonly string[];
  readonly note: string;
  readonly analysis: ReferenceAnalysis;
  readonly createdAt: string;
}

export interface ImportResult {
  readonly added: string[];
  readonly duplicates: string[];
  readonly rejected: Array<{ name: string; reason: string }>;
}

interface Row {
  id: string;
  bundle_id: string;
  source: 'ready_made' | 'ai_generated';
  job_id: string;
  prompt_item_id: string | null;
  original_name: string;
  sha256: string;
  status: QueueStatus;
  caption: string;
  hashtags_json: string;
  summary: string;
  note: string;
  flags_json: string;
  analysis_error: string | null;
  caption_edited: number;
  post_url: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrowthQueueDeps {
  readonly meta: MetadataDb;
  readonly bundles: BundleStore;
  readonly jobs: GenerationStore;
  readonly library: VideoLibrary;
  readonly analysis: AnalysisService;
  readonly prompts: PromptStudioService;
  readonly log: Logger;
  readonly now?: () => Date;
}

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const POST_URL = /^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]{2,24}\/video\/\d{8,25}(\?.*)?$/;

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export class GrowthQueueService {
  readonly #db: DatabaseSync;
  readonly #d: GrowthQueueDeps;
  #running: Promise<void> | null = null;

  constructor(deps: GrowthQueueDeps) {
    if (!deps.meta.db) throw new Error('posting queue needs a writable database');
    this.#db = deps.meta.db;
    this.#d = deps;
  }

  #iso(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  #require(bundleId: string): void {
    if (this.#d.bundles.get(bundleId)?.mode !== 'account_growth') throw new GrowthQueueError('not_growth_account');
  }

  #row(bundleId: string, id: string): Row {
    const r = this.#db.prepare('SELECT * FROM post_queue WHERE id = ? AND bundle_id = ?').get(id, bundleId) as unknown as Row | undefined;
    if (!r) throw new GrowthQueueError('unknown_queue_item');
    return r;
  }

  #insert(bundleId: string, source: Row['source'], job: GenerationJob, originalName: string, sha: string, promptItemId: string | null, note: string): string {
    const id = randomUUID();
    const now = this.#iso();
    const elsewhere = this.#db.prepare('SELECT 1 FROM post_queue WHERE sha256 = ? AND bundle_id != ? LIMIT 1').get(sha, bundleId) !== undefined;
    this.#db
      .prepare(
        `INSERT INTO post_queue (id, bundle_id, source, job_id, prompt_item_id, original_name, sha256, status, note, flags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'analyzing', ?, ?, ?, ?)`,
      )
      .run(id, bundleId, source, job.id, promptItemId, originalName, sha, note, JSON.stringify(elsewhere ? ['duplicate_in_other_account'] : []), now, now);
    return id;
  }

  /**
   * Imports finished MP4s: each is hashed, copied into the account's library
   * (the original stays where it is, untouched) and queued for analysis. A
   * file already in this account's queue is skipped as a duplicate.
   */
  async importFiles(bundleId: string, paths: readonly string[]): Promise<ImportResult> {
    this.#require(bundleId);
    const result: ImportResult = { added: [], duplicates: [], rejected: [] };
    for (const p of paths) {
      const name = basename(p);
      const info = await stat(p).catch(() => null);
      if (extname(p).toLowerCase() !== '.mp4') {
        result.rejected.push({ name, reason: 'not_mp4' });
        continue;
      }
      if (!info?.isFile()) {
        result.rejected.push({ name, reason: 'unreadable' });
        continue;
      }
      if (info.size > MAX_IMPORT_BYTES) {
        result.rejected.push({ name, reason: 'video_file_too_large' });
        continue;
      }
      const sha = await sha256Of(p);
      if (this.#db.prepare('SELECT 1 FROM post_queue WHERE bundle_id = ? AND sha256 = ?').get(bundleId, sha)) {
        result.duplicates.push(name);
        continue;
      }
      const job = this.#d.jobs.create({ bundleId, source: 'manual_download', providerId: 'ready-made-import', settings: null });
      this.#d.jobs.transition(job.id, 'running', { code: 'import_started' });
      const part = this.#d.library.partPath(bundleId, job.id);
      await copyFile(p, part);
      const stored = this.#d.library.finalize(part);
      if (!stored) {
        this.#d.jobs.transition(job.id, 'failed', { errorCode: 'output_invalid' });
        result.rejected.push({ name, reason: 'not_a_video' });
        continue;
      }
      const done = this.#d.jobs.transition(job.id, 'completed', { video: stored, code: 'ready_made_import' });
      this.#insert(bundleId, 'ready_made', done, name, sha, null, '');
      result.added.push(name);
    }
    this.#d.log.info('ready_made_imported', { bundleId, added: result.added.length, duplicates: result.duplicates.length, rejected: result.rejected.length });
    this.kick();
    return result;
  }

  /** A video finished through the Flow workflow for a Prompt Studio prompt joins the queue. */
  addFromJob(job: GenerationJob): void {
    if (job.state !== 'completed' || !job.videoFile || !job.videoSha256 || !job.promptItemId) return;
    if (this.#d.bundles.get(job.bundleId)?.mode !== 'account_growth') return;
    if (this.#db.prepare('SELECT 1 FROM post_queue WHERE job_id = ? OR (bundle_id = ? AND sha256 = ?)').get(job.id, job.bundleId, job.videoSha256)) return;
    this.#insert(job.bundleId, 'ai_generated', job, basename(job.videoFile), job.videoSha256, job.promptItemId, this.#d.prompts.promptContext(job.promptItemId));
    this.#d.log.info('ai_video_queued', { bundleId: job.bundleId, jobId: job.id });
    this.kick();
  }

  /** Analyzes waiting videos one at a time, in the background. */
  kick(): Promise<void> {
    if (!this.#running) {
      this.#running = this.#drain().finally(() => {
        this.#running = null;
      });
    }
    return this.#running;
  }

  async #drain(): Promise<void> {
    for (;;) {
      const next = this.#db.prepare("SELECT * FROM post_queue WHERE status = 'analyzing' ORDER BY created_at, rowid LIMIT 1").get() as unknown as Row | undefined;
      if (!next) return;
      await this.#analyze(next);
    }
  }

  async #analyze(r: Row): Promise<void> {
    const job = this.#d.jobs.get(r.job_id);
    const file = job?.videoFile ? this.#d.library.absolute(job.videoFile) : null;
    const recent = (
      this.#db
        .prepare("SELECT caption FROM post_queue WHERE bundle_id = ? AND id != ? AND caption != '' AND status != 'rejected' ORDER BY updated_at DESC LIMIT 20")
        .all(r.bundle_id, r.id) as Array<{ caption: string }>
    ).map((x) => x.caption);
    try {
      if (!file) throw new AnalysisError('analysis_failed', ['video_missing']);
      const a = await this.#d.analysis.run(r.bundle_id, 'video', (an) => an.describeVideo(file, { note: r.note, recentCaptions: recent, ...(r.source === 'ready_made' ? { fileName: r.original_name } : {}) }));
      const keep = (JSON.parse(r.flags_json) as QueueFlag[]).filter((f) => f === 'duplicate_in_other_account');
      const flags: QueueFlag[] = [...captionFlags(a, recent), ...keep];
      this.#db
        .prepare('UPDATE post_queue SET status = ?, caption = ?, hashtags_json = ?, summary = ?, flags_json = ?, analysis_error = NULL, caption_edited = 0, updated_at = ? WHERE id = ?')
        .run(flags.length > 0 ? 'needs_review' : 'ready', a.caption, JSON.stringify(a.hashtags), a.summary, JSON.stringify(flags), this.#iso(), r.id);
    } catch (err) {
      const code = err instanceof AnalysisError ? err.code : 'analysis_failed';
      this.#db.prepare("UPDATE post_queue SET status = 'analysis_failed', analysis_error = ?, updated_at = ? WHERE id = ?").run(code, this.#iso(), r.id);
      this.#d.log.warn('caption_analysis_failed', { bundleId: r.bundle_id, item: r.id, code });
    }
  }

  /** Analyze again (e.g. after adding an API key, or with a note about the video). */
  reanalyze(bundleId: string, id: string, note: unknown): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status === 'posted') throw new GrowthQueueError('queue_action_not_allowed');
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) throw new GrowthQueueError('invalid_caption', ['invalid_note']);
    this.#db.prepare("UPDATE post_queue SET status = 'analyzing', note = ?, analysis_error = NULL, updated_at = ? WHERE id = ?").run(typeof note === 'string' ? note.trim() : r.note, this.#iso(), id);
    void this.kick();
  }

  /** Retries every failed analysis of the account (after the key is set or the budget raised). */
  retryFailed(bundleId: string): number {
    this.#require(bundleId);
    const n = this.#db.prepare("UPDATE post_queue SET status = 'analyzing', analysis_error = NULL, updated_at = ? WHERE bundle_id = ? AND status = 'analysis_failed'").run(this.#iso(), bundleId).changes;
    void this.kick();
    return Number(n);
  }

  /** The owner's caption: reviewed, so the item is ready. */
  updateCaption(bundleId: string, id: string, caption: unknown, hashtags: unknown): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status === 'posted' || r.status === 'analyzing') throw new GrowthQueueError('queue_action_not_allowed');
    if (typeof caption !== 'string' || caption.trim().length < 3 || caption.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(caption)) throw new GrowthQueueError('invalid_caption');
    const tags = Array.isArray(hashtags) ? hashtags : [];
    const clean = tags
      .map((t) => String(t).toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
      .filter((t) => t.length >= 2 && t.length <= 40)
      .slice(0, 10)
      .map((t) => `#${t}`);
    const keep = (JSON.parse(r.flags_json) as QueueFlag[]).filter((f) => f === 'duplicate_in_other_account');
    this.#db
      .prepare("UPDATE post_queue SET caption = ?, hashtags_json = ?, caption_edited = 1, flags_json = ?, status = 'ready', updated_at = ? WHERE id = ?")
      .run(caption.trim(), JSON.stringify([...new Set(clean)]), JSON.stringify(keep), this.#iso(), id);
  }

  /** Accepts a flagged caption as it is. */
  approve(bundleId: string, id: string): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status !== 'needs_review' || !r.caption) throw new GrowthQueueError('queue_action_not_allowed');
    this.#db.prepare("UPDATE post_queue SET status = 'ready', updated_at = ? WHERE id = ?").run(this.#iso(), id);
  }

  reject(bundleId: string, id: string): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status === 'posted' || r.status === 'analyzing') throw new GrowthQueueError('queue_action_not_allowed');
    this.#db.prepare("UPDATE post_queue SET status = 'rejected', updated_at = ? WHERE id = ?").run(this.#iso(), id);
  }

  restore(bundleId: string, id: string): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status !== 'rejected') throw new GrowthQueueError('queue_action_not_allowed');
    const flags = JSON.parse(r.flags_json) as QueueFlag[];
    this.#db.prepare('UPDATE post_queue SET status = ?, updated_at = ? WHERE id = ?').run(!r.caption ? 'analysis_failed' : flags.length > 0 ? 'needs_review' : 'ready', this.#iso(), id);
  }

  /** The text to paste on TikTok's upload page. */
  postText(bundleId: string, id: string): { text: string; file: string } {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status !== 'ready' && r.status !== 'posted') throw new GrowthQueueError('queue_action_not_allowed', ['caption_not_ready']);
    const job = this.#d.jobs.get(r.job_id);
    if (!job?.videoFile) throw new GrowthQueueError('unknown_queue_item');
    const tags = JSON.parse(r.hashtags_json) as string[];
    return { text: [r.caption, tags.join(' ')].filter(Boolean).join('\n\n'), file: this.#d.library.absolute(job.videoFile) };
  }

  /** Recorded only when the owner says the post is live (optionally with its link). */
  markPosted(bundleId: string, id: string, postUrl: unknown): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status !== 'ready') throw new GrowthQueueError('queue_action_not_allowed');
    const url = typeof postUrl === 'string' && postUrl.trim() !== '' ? postUrl.trim() : null;
    if (url !== null && !POST_URL.test(url)) throw new GrowthQueueError('invalid_post_url');
    this.#db.prepare("UPDATE post_queue SET status = 'posted', post_url = ?, posted_at = ?, updated_at = ? WHERE id = ?").run(url, this.#iso(), this.#iso(), id);
    // Keep Ternak Akun today's "posted" count in step for AI-generated videos.
    if (r.prompt_item_id) {
      try {
        this.#d.prompts.markPosted(bundleId, r.prompt_item_id, url);
      } catch {
        /* already recorded there */
      }
    }
  }

  undoPosted(bundleId: string, id: string): void {
    this.#require(bundleId);
    const r = this.#row(bundleId, id);
    if (r.status !== 'posted') throw new GrowthQueueError('queue_action_not_allowed');
    this.#db.prepare("UPDATE post_queue SET status = 'ready', post_url = NULL, posted_at = NULL, updated_at = ? WHERE id = ?").run(this.#iso(), id);
    if (r.prompt_item_id) {
      try {
        this.#d.prompts.undoPosted(bundleId, r.prompt_item_id);
      } catch {
        /* nothing recorded there */
      }
    }
  }

  // ---- FYP references → original prompts ----

  /** Breaks down reference videos the owner supplied (reference files of this account). */
  async analyzeReferences(bundleId: string, assetIds: unknown, note: unknown): Promise<FypReference> {
    this.#require(bundleId);
    if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 5 || (note !== undefined && (typeof note !== 'string' || note.length > 1000))) {
      throw new GrowthQueueError('invalid_reference_request');
    }
    const assets = this.#d.prompts.assets(bundleId);
    const files = (assetIds as string[]).map((id) => {
      const a = assets.find((x) => x.id === id && x.kind === 'video');
      if (!a) throw new GrowthQueueError('unknown_reference');
      return this.#d.prompts.referencePath(bundleId, id);
    });
    const text = typeof note === 'string' ? note.trim() : '';
    const analysis = await this.#d.analysis.run(bundleId, 'reference', (an) => an.analyzeReferences(files, text));
    const id = randomUUID();
    this.#db.prepare('INSERT INTO fyp_references (id, bundle_id, asset_ids_json, note, analysis_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, bundleId, JSON.stringify(assetIds), text, JSON.stringify(analysis), this.#iso());
    return { id, assetIds: assetIds as string[], note: text, analysis, createdAt: this.#iso() };
  }

  /** Writes `count` original prompts in a reference's format; they join the production queue. */
  async makeVariations(bundleId: string, referenceId: string, count: unknown): Promise<PromptBatch> {
    this.#require(bundleId);
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 10) throw new GrowthQueueError('invalid_reference_request', ['invalid_count']);
    const row = this.#db.prepare('SELECT analysis_json FROM fyp_references WHERE id = ? AND bundle_id = ?').get(referenceId, bundleId) as { analysis_json: string } | undefined;
    if (!row) throw new GrowthQueueError('unknown_reference');
    const ref = JSON.parse(row.analysis_json) as ReferenceAnalysis;
    const avoid = this.#d.prompts.recentVariationHooks(bundleId);
    const variations = await this.#d.analysis.run(bundleId, 'variations', (an) => an.variations(ref, count as number, { durationSeconds: 8, aspectRatio: '9:16' }, avoid));
    return this.#d.prompts.addVariationBatch(bundleId, referenceId, variations);
  }

  references(bundleId: string): FypReference[] {
    return (
      this.#db.prepare('SELECT * FROM fyp_references WHERE bundle_id = ? ORDER BY created_at DESC LIMIT 10').all(bundleId) as Array<{
        id: string;
        asset_ids_json: string;
        note: string;
        analysis_json: string;
        created_at: string;
      }>
    ).map((r) => ({ id: r.id, assetIds: JSON.parse(r.asset_ids_json) as string[], note: r.note, analysis: JSON.parse(r.analysis_json) as ReferenceAnalysis, createdAt: r.created_at }));
  }

  // ---- View ----

  #item(r: Row): QueueItem {
    return {
      id: r.id,
      source: r.source,
      jobId: r.job_id,
      promptItemId: r.prompt_item_id,
      originalName: r.original_name,
      status: r.status,
      caption: r.caption,
      hashtags: JSON.parse(r.hashtags_json) as string[],
      summary: r.summary,
      note: r.note,
      flags: JSON.parse(r.flags_json) as QueueFlag[],
      analysisError: r.analysis_error,
      captionEdited: r.caption_edited === 1,
      postUrl: r.post_url,
      postedAt: r.posted_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  view(bundleId: string): { items: QueueItem[]; postedToday: number; dailyTarget: number; counts: Record<QueueStatus, number>; references: FypReference[] } {
    this.#require(bundleId);
    const rows = this.#db.prepare('SELECT * FROM post_queue WHERE bundle_id = ? ORDER BY created_at DESC, rowid DESC').all(bundleId) as unknown as Row[];
    const now = this.#d.now?.() ?? new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const counts = { analyzing: 0, needs_review: 0, ready: 0, posted: 0, rejected: 0, analysis_failed: 0 } as Record<QueueStatus, number>;
    for (const r of rows) counts[r.status]++;
    return {
      items: rows.map((r) => this.#item(r)),
      postedToday: rows.filter((r) => r.status === 'posted' && r.posted_at !== null && r.posted_at >= midnight).length,
      dailyTarget: this.#d.prompts.dailyTarget(bundleId),
      counts,
      references: this.references(bundleId),
    };
  }
}
