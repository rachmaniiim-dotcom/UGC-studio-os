import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canTransition, type CreativeSettings, type GenerationErrorCode, type JobState, type VideoSettings } from '@ugc/core';
import type { MetadataDb } from './profiles.js';

/** A generation job as stored and shown. No prompt, provider text or page content. */
export interface GenerationJob {
  readonly id: string;
  readonly bundleId: string;
  readonly source: 'provider' | 'manual_download';
  readonly providerId: string;
  readonly state: JobState;
  readonly settings: VideoSettings | null;
  readonly progress: number | null;
  readonly errorCode: GenerationErrorCode | null;
  readonly needsUser: boolean;
  /** Path relative to userData, e.g. library/<bundleId>/<jobId>.mp4. */
  readonly videoFile: string | null;
  readonly videoBytes: number | null;
  readonly videoSha256: string | null;
  /** The Prompt Studio item this video was made from, if known (T1). */
  readonly promptItemId: string | null;
  /** The account whose Google Flow session produced it (a Flow pool account, or the account itself). */
  readonly flowBundleId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobEvent {
  readonly at: string;
  readonly from: JobState | null;
  readonly to: JobState;
  readonly code: string | null;
}

interface JobRow {
  id: string;
  bundle_id: string;
  source: 'provider' | 'manual_download';
  provider_id: string;
  state: JobState;
  settings_json: string | null;
  progress: number | null;
  error_code: GenerationErrorCode | null;
  needs_user: number;
  video_file: string | null;
  video_bytes: number | null;
  video_sha256: string | null;
  prompt_item_id: string | null;
  flow_bundle_id: string | null;
  created_at: string;
  updated_at: string;
}

const toJob = (r: JobRow): GenerationJob => ({
  id: r.id,
  bundleId: r.bundle_id,
  source: r.source,
  providerId: r.provider_id,
  state: r.state,
  settings: r.settings_json ? (JSON.parse(r.settings_json) as VideoSettings) : null,
  progress: r.progress,
  errorCode: r.error_code,
  needsUser: r.needs_user === 1,
  videoFile: r.video_file,
  videoBytes: r.video_bytes,
  videoSha256: r.video_sha256,
  promptItemId: r.prompt_item_id ?? null,
  flowBundleId: r.flow_bundle_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class IllegalTransition extends Error {}

export class GenerationStore {
  readonly #db: DatabaseSync | null;

  constructor(meta: MetadataDb) {
    this.#db = meta.db;
  }

  #require(): DatabaseSync {
    if (!this.#db) throw new Error('generation store is read-only');
    return this.#db;
  }

  getCreative(bundleId: string): CreativeSettings | null {
    if (!this.#db) return null;
    const row = this.#db.prepare('SELECT prompt, settings_json FROM creative_settings WHERE bundle_id = ?').get(bundleId) as
      | { prompt: string; settings_json: string }
      | undefined;
    return row ? { prompt: row.prompt, settings: JSON.parse(row.settings_json) as VideoSettings } : null;
  }

  saveCreative(bundleId: string, creative: CreativeSettings): void {
    this.#require()
      .prepare(
        `INSERT INTO creative_settings (bundle_id, prompt, settings_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET prompt = excluded.prompt, settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      )
      .run(bundleId, creative.prompt, JSON.stringify(creative.settings), new Date().toISOString());
  }

  create(input: {
    bundleId: string;
    source: GenerationJob['source'];
    providerId: string;
    settings: VideoSettings | null;
    promptItemId?: string | null;
    flowBundleId?: string | null;
  }): GenerationJob {
    const db = this.#require();
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO generation_jobs (id, bundle_id, source, provider_id, state, settings_json, needs_user, prompt_item_id, flow_bundle_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
    ).run(
      id,
      input.bundleId,
      input.source,
      input.providerId,
      'pending',
      input.settings ? JSON.stringify(input.settings) : null,
      input.promptItemId ?? null,
      input.flowBundleId ?? null,
      now,
      now,
    );
    this.#event(id, null, 'pending', null);
    return this.get(id)!;
  }

  get(id: string): GenerationJob | undefined {
    if (!this.#db) return undefined;
    const row = this.#db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  list(bundleId: string, limit = 20): readonly GenerationJob[] {
    if (!this.#db) return [];
    return (this.#db.prepare('SELECT * FROM generation_jobs WHERE bundle_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(bundleId, limit) as unknown as JobRow[]).map(toJob);
  }

  listAll(): readonly GenerationJob[] {
    if (!this.#db) return [];
    return (this.#db.prepare('SELECT * FROM generation_jobs ORDER BY created_at').all() as unknown as JobRow[]).map(toJob);
  }

  events(jobId: string): readonly JobEvent[] {
    if (!this.#db) return [];
    return (this.#db.prepare('SELECT at, from_state, to_state, code FROM generation_events WHERE job_id = ? ORDER BY id').all(jobId) as Array<{
      at: string;
      from_state: JobState | null;
      to_state: JobState;
      code: string | null;
    }>).map((e) => ({ at: e.at, from: e.from_state, to: e.to_state, code: e.code }));
  }

  /** Provider jobs created since local midnight (the daily cap counts these). */
  countToday(bundleId: string, now = new Date()): number {
    if (!this.#db) return 0;
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE bundle_id = ? AND source = 'provider' AND created_at >= ?").get(bundleId, midnight) as {
      n: number;
    }).n;
  }

  /** Moves a job forward (never backward) and records the transition. */
  transition(
    id: string,
    to: JobState,
    patch: { code?: string | null; errorCode?: GenerationErrorCode | null; needsUser?: boolean; video?: { file: string; bytes: number; sha256: string } } = {},
  ): GenerationJob {
    const db = this.#require();
    const job = this.get(id);
    if (!job) throw new Error('unknown job');
    if (!canTransition(job.state, to)) throw new IllegalTransition(`${job.state} -> ${to}`);
    db.prepare(
      'UPDATE generation_jobs SET state = ?, error_code = ?, needs_user = ?, video_file = ?, video_bytes = ?, video_sha256 = ?, progress = ?, updated_at = ? WHERE id = ?',
    ).run(
      to,
      patch.errorCode ?? job.errorCode,
      (patch.needsUser ?? job.needsUser) ? 1 : 0,
      patch.video?.file ?? job.videoFile,
      patch.video?.bytes ?? job.videoBytes,
      patch.video?.sha256 ?? job.videoSha256,
      to === 'completed' ? 1 : job.progress,
      new Date().toISOString(),
      id,
    );
    this.#event(id, job.state, to, patch.code ?? patch.errorCode ?? null);
    return this.get(id)!;
  }

  /** Links a finished video to the prompt it was made from (owner's choice for manual downloads). */
  linkPrompt(id: string, promptItemId: string): void {
    this.#require().prepare('UPDATE generation_jobs SET prompt_item_id = ?, updated_at = ? WHERE id = ?').run(promptItemId, new Date().toISOString(), id);
  }

  setProgress(id: string, progress: number | null): void {
    this.#require().prepare('UPDATE generation_jobs SET progress = ?, updated_at = ? WHERE id = ?').run(progress, new Date().toISOString(), id);
  }

  #event(jobId: string, from: JobState | null, to: JobState, code: string | null): void {
    this.#require().prepare('INSERT INTO generation_events (job_id, at, from_state, to_state, code) VALUES (?, ?, ?, ?, ?)').run(jobId, new Date().toISOString(), from, to, code);
  }
}
