import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  EMPTY_STRATEGY,
  assertResearchUse,
  assessReferences,
  csvRowToReference,
  explainAssessment,
  normalizeHandle,
  parseReferenceCsv,
  validateReference,
  validateStrategy,
  type Assessment,
  type GrowthStrategy,
  type Logger,
  type ReferenceIssue,
  type ReferenceMetrics,
  type ReferenceVideoInput,
  type Relevance,
  type ResearchProvider,
  type ResearchQuery,
  type StrategyIssue,
} from '@ugc/core';
import type { BundleStore, MetadataDb } from './profiles.js';

/**
 * Growth Intelligence (Gate 5, R1/R2): per-account strategy, reference
 * creators, reference videos (manual entry, CSV import or an authorized
 * provider) and deterministic outlier scoring. Scores are computed on demand
 * and never stored. Owner research content (handles, URLs, notes) is never
 * logged: only counts.
 */

export class GrowthError extends Error {
  constructor(
    readonly code: 'not_growth_account' | 'invalid_strategy' | 'invalid_reference' | 'invalid_creator' | 'unknown_reference' | 'invalid_csv' | 'source_not_authorized',
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface ReferenceVideo {
  readonly id: string;
  readonly url: string;
  readonly platformVideoId: string;
  readonly creatorHandle: string;
  readonly publishedAt: string | null;
  readonly durationSeconds: number | null;
  readonly metrics: ReferenceMetrics;
  readonly relevance: Relevance;
  readonly pinned: boolean;
  readonly note: string;
  readonly source: string;
  readonly updatedAt: string;
}

export interface ReferenceCreator {
  readonly id: string;
  readonly handle: string;
  readonly note: string;
  readonly videoCount: number;
}

export type ScoredReference = ReferenceVideo & { readonly assessment: Assessment; readonly explanation: string };

export interface GrowthView {
  readonly strategy: GrowthStrategy;
  readonly strategySaved: boolean;
  readonly creators: readonly ReferenceCreator[];
  readonly references: readonly ScoredReference[];
  /** Shortlisted reference ids, best first (outliers by ratio, then pinned). */
  readonly shortlist: readonly string[];
  readonly computedAt: string;
}

export interface ImportRowResult {
  readonly row: number;
  readonly status: 'added' | 'updated' | 'rejected';
  readonly issues: readonly ReferenceIssue[];
}

export interface ImportResult {
  readonly added: number;
  readonly updated: number;
  readonly rejected: number;
  readonly ignoredColumns: number;
  readonly rows: readonly ImportRowResult[];
}

interface VideoRow {
  id: string;
  url: string;
  platform_video_id: string;
  creator_handle: string;
  published_at: string | null;
  duration_s: number | null;
  metrics_json: string;
  relevance: Relevance;
  pinned: number;
  note: string;
  source: string;
  updated_at: string;
}

const toVideo = (r: VideoRow): ReferenceVideo => ({
  id: r.id,
  url: r.url,
  platformVideoId: r.platform_video_id,
  creatorHandle: r.creator_handle,
  publishedAt: r.published_at,
  durationSeconds: r.duration_s,
  metrics: JSON.parse(r.metrics_json) as ReferenceMetrics,
  relevance: r.relevance,
  pinned: r.pinned === 1,
  note: r.note,
  source: r.source,
  updatedAt: r.updated_at,
});

export class GrowthService {
  readonly #db: DatabaseSync;
  readonly #bundles: BundleStore;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(meta: MetadataDb, bundles: BundleStore, log: Logger, now: () => Date = () => new Date()) {
    if (!meta.db) throw new Error('growth store needs a writable database');
    this.#db = meta.db;
    this.#bundles = bundles;
    this.#log = log;
    this.#now = now;
  }

  #requireGrowth(bundleId: string): void {
    if (this.#bundles.get(bundleId)?.mode !== 'account_growth') throw new GrowthError('not_growth_account');
  }

  strategy(bundleId: string): { strategy: GrowthStrategy; saved: boolean } {
    const row = this.#db.prepare('SELECT strategy_json FROM growth_strategies WHERE bundle_id = ?').get(bundleId) as { strategy_json: string } | undefined;
    return row ? { strategy: JSON.parse(row.strategy_json) as GrowthStrategy, saved: true } : { strategy: EMPTY_STRATEGY, saved: false };
  }

  saveStrategy(bundleId: string, raw: unknown): void {
    this.#requireGrowth(bundleId);
    const valid = validateStrategy(raw);
    if (!valid.ok) throw new GrowthError('invalid_strategy', valid.issues as StrategyIssue[]);
    this.#db
      .prepare(
        `INSERT INTO growth_strategies (bundle_id, strategy_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET strategy_json = excluded.strategy_json, updated_at = excluded.updated_at`,
      )
      .run(bundleId, JSON.stringify(valid.value), this.#now().toISOString());
    this.#log.info('growth_strategy_saved', { bundleId });
  }

  addCreator(bundleId: string, handleOrUrl: string, note: string): void {
    this.#requireGrowth(bundleId);
    const fromUrl = /^https:\/\/(www\.)?tiktok\.com\/@([^/?#]+)\/?$/i.exec(handleOrUrl.trim())?.[2];
    const handle = normalizeHandle(fromUrl ?? handleOrUrl);
    if (!handle || typeof note !== 'string' || note.length > 500) throw new GrowthError('invalid_creator');
    this.#db
      .prepare('INSERT INTO reference_creators (id, bundle_id, handle, note, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bundle_id, handle) DO UPDATE SET note = excluded.note')
      .run(randomUUID(), bundleId, handle, note.trim(), this.#now().toISOString());
  }

  removeCreator(bundleId: string, creatorId: string): void {
    this.#db.prepare('DELETE FROM reference_creators WHERE bundle_id = ? AND id = ?').run(bundleId, creatorId);
  }

  /**
   * Adds or updates (same TikTok video id) one reference; returns whether it
   * was new. With `keepOwnerInput` (imports and the add form), what the
   * incoming row leaves blank (relevance, note, date, duration, metrics) keeps
   * its stored value, so re-importing a CSV never erases the owner's ratings.
   */
  #upsert(bundleId: string, incoming: ReferenceVideoInput, source: string, pinned?: boolean, keepOwnerInput = false): 'added' | 'updated' {
    const now = this.#now().toISOString();
    const existing = this.#db.prepare('SELECT * FROM reference_videos WHERE bundle_id = ? AND platform_video_id = ?').get(bundleId, incoming.platformVideoId) as unknown as
      | VideoRow
      | undefined;
    let v = incoming;
    if (existing && keepOwnerInput) {
      const old = toVideo(existing);
      const m = incoming.metrics;
      v = {
        ...incoming,
        relevance: incoming.relevance === 'unrated' ? old.relevance : incoming.relevance,
        note: incoming.note || old.note,
        publishedAt: incoming.publishedAt ?? old.publishedAt,
        durationSeconds: incoming.durationSeconds ?? old.durationSeconds,
        metrics: m.views || m.likes || m.comments || m.shares ? m : old.metrics,
      };
    }
    if (existing) {
      this.#db
        .prepare(
          'UPDATE reference_videos SET url = ?, creator_handle = ?, published_at = ?, duration_s = ?, metrics_json = ?, relevance = ?, pinned = ?, note = ?, source = ?, updated_at = ? WHERE id = ?',
        )
        .run(v.url, v.creatorHandle, v.publishedAt, v.durationSeconds, JSON.stringify(v.metrics), v.relevance, (pinned ?? existing.pinned === 1) ? 1 : 0, v.note, source, now, existing.id);
      return 'updated';
    }
    this.#db
      .prepare(
        `INSERT INTO reference_videos (id, bundle_id, url, platform_video_id, creator_handle, published_at, duration_s, metrics_json, relevance, pinned, note, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), bundleId, v.url, v.platformVideoId, v.creatorHandle, v.publishedAt, v.durationSeconds, JSON.stringify(v.metrics), v.relevance, pinned ? 1 : 0, v.note, source, now, now);
    return 'added';
  }

  /** Manual entry (form). */
  addReference(bundleId: string, raw: Record<string, unknown>): 'added' | 'updated' {
    this.#requireGrowth(bundleId);
    const valid = validateReference(raw, this.#now());
    if (!valid.ok) throw new GrowthError('invalid_reference', valid.issues);
    return this.#upsert(bundleId, valid.value, 'manual', raw['pinned'] === true ? true : undefined, true);
  }

  /** Edits an existing reference (metrics, date, relevance, pin, note). The URL can't change. */
  updateReference(bundleId: string, referenceId: string, patch: Record<string, unknown>): void {
    this.#requireGrowth(bundleId);
    const row = this.#db.prepare('SELECT * FROM reference_videos WHERE bundle_id = ? AND id = ?').get(bundleId, referenceId) as unknown as VideoRow | undefined;
    if (!row) throw new GrowthError('unknown_reference');
    const current = toVideo(row);
    const raw = { ...patch, url: current.url, creator: current.creatorHandle };
    const valid = validateReference(raw, this.#now());
    if (!valid.ok) throw new GrowthError('invalid_reference', valid.issues);
    this.#upsert(bundleId, valid.value, current.source, typeof patch['pinned'] === 'boolean' ? patch['pinned'] : current.pinned);
  }

  removeReference(bundleId: string, referenceId: string): void {
    this.#db.prepare('DELETE FROM reference_videos WHERE bundle_id = ? AND id = ?').run(bundleId, referenceId);
  }

  #importRows(bundleId: string, rows: ReadonlyArray<Record<string, unknown>>, source: string, ignoredColumns: number): ImportResult {
    const results: ImportRowResult[] = [];
    this.#db.exec('BEGIN');
    try {
      rows.forEach((raw, i) => {
        const valid = validateReference(raw, this.#now());
        if (!valid.ok) results.push({ row: i + 2, status: 'rejected', issues: valid.issues });
        else results.push({ row: i + 2, status: this.#upsert(bundleId, valid.value, source, undefined, true), issues: [] });
      });
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    const count = (s: ImportRowResult['status']) => results.filter((r) => r.status === s).length;
    const result = { added: count('added'), updated: count('updated'), rejected: count('rejected'), ignoredColumns, rows: results };
    this.#log.info('growth_references_imported', { bundleId, source, added: result.added, updated: result.updated, rejected: result.rejected });
    return result;
  }

  /** CSV import (pasted text or a file read by the main process). Row numbers count the header as row 1. */
  importCsv(bundleId: string, text: string): ImportResult {
    this.#requireGrowth(bundleId);
    const parsed = parseReferenceCsv(text);
    if (!parsed.ok) throw new GrowthError('invalid_csv', [parsed.error]);
    return this.#importRows(bundleId, parsed.rows.map(csvRowToReference), 'csv', parsed.ignoredColumns);
  }

  /**
   * Unattended retrieval from a research source: only if its recorded
   * authorization permits automated retrieval. Rows go through the same
   * validation as manual entries.
   */
  async importFromProvider(bundleId: string, provider: ResearchProvider, query: ResearchQuery): Promise<ImportResult> {
    this.#requireGrowth(bundleId);
    try {
      assertResearchUse(provider.descriptor, 'automated_retrieval');
    } catch {
      this.#log.warn('research_source_refused', { bundleId, provider: provider.descriptor.id });
      throw new GrowthError('source_not_authorized');
    }
    const rows = await provider.search(query);
    return this.#importRows(bundleId, rows, provider.descriptor.id, 0);
  }

  references(bundleId: string): readonly ReferenceVideo[] {
    return (this.#db.prepare('SELECT * FROM reference_videos WHERE bundle_id = ? ORDER BY created_at, rowid').all(bundleId) as unknown as VideoRow[]).map(toVideo);
  }

  view(bundleId: string): GrowthView {
    this.#requireGrowth(bundleId);
    const { strategy, saved } = this.strategy(bundleId);
    const now = this.#now();
    const videos = this.references(bundleId);
    const assessments = assessReferences(videos, strategy.thresholds, now);
    const references = videos.map((v, i) => ({
      ...v,
      assessment: assessments[i]!,
      explanation: explainAssessment(assessments[i]!, v.metrics.views?.value ?? null, strategy.thresholds),
    }));
    const shortlist = references
      .filter((r) => r.assessment.shortlisted)
      .sort((a, b) => (b.assessment.verdict === 'outlier' ? 1 : 0) - (a.assessment.verdict === 'outlier' ? 1 : 0) || (b.assessment.ratio ?? 0) - (a.assessment.ratio ?? 0))
      .map((r) => r.id);
    const creatorRows = this.#db.prepare('SELECT id, handle, note FROM reference_creators WHERE bundle_id = ? ORDER BY added_at, rowid').all(bundleId) as Array<{
      id: string;
      handle: string;
      note: string;
    }>;
    const creators = creatorRows.map((c) => ({ ...c, videoCount: videos.filter((v) => v.creatorHandle === c.handle).length }));
    return { strategy, strategySaved: saved, creators, references, shortlist, computedAt: now.toISOString() };
  }
}
