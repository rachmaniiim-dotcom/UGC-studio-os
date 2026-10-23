import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  parseModelJson,
  referenceInstructions,
  validateReferenceAnalysis,
  validateVariations,
  validateVideoAnalysis,
  variationInstructions,
  videoCaptionInstructions,
  type Logger,
  type ReferenceAnalysis,
  type Variation,
  type VideoAnalysis,
} from '@ugc/core';
import { writeAtomic } from './atomic.js';
import type { MetadataDb } from './profiles.js';

/**
 * Multimodal analysis for Ternak Akun (G1): captions from the actual video,
 * and the format of FYP reference videos the owner supplied. The real
 * provider is the Gemini API (paid, owner's key); a deterministic synthetic
 * analyzer serves tests and the synthetic build. Every paid call is counted
 * against an owner-set monthly budget. The API key is sealed with the OS
 * (DPAPI on Windows), never logged and never sent to the UI.
 */

export type AnalysisErrorCode = 'analysis_not_configured' | 'analysis_budget_reached' | 'analysis_failed' | 'analysis_unreadable_answer' | 'video_too_large' | 'invalid_analysis_settings' | 'secure_storage_unavailable';

export class AnalysisError extends Error {
  constructor(
    readonly code: AnalysisErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface MediaAnalyzer {
  readonly id: string;
  describeVideo(file: string, context: { note: string; recentCaptions: readonly string[]; fileName?: string }): Promise<VideoAnalysis>;
  analyzeReferences(files: readonly string[], note: string): Promise<ReferenceAnalysis>;
  variations(ref: ReferenceAnalysis, count: number, video: { durationSeconds: number; aspectRatio: string }, avoid: readonly string[]): Promise<Variation[]>;
}

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const API = 'https://generativelanguage.googleapis.com';

/** Gemini API: uploads each video with the Files API, asks for JSON, deletes the upload afterwards. */
export class GeminiAnalyzer implements MediaAnalyzer {
  readonly id = 'gemini';
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pollMs = 3000,
  ) {}

  async #upload(file: string): Promise<{ name: string; uri: string }> {
    const info = await stat(file);
    if (info.size > MAX_VIDEO_BYTES) throw new AnalysisError('video_too_large');
    const start = await this.fetchImpl(`${API}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(info.size),
        'X-Goog-Upload-Header-Content-Type': 'video/mp4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'video' } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!start.ok || !uploadUrl) throw new AnalysisError('analysis_failed', [`upload_start_${start.status}`]);
    const done = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Length': String(info.size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: await readFile(file),
    });
    const body = (await done.json().catch(() => null)) as { file?: { name?: string; uri?: string; state?: string } } | null;
    if (!done.ok || !body?.file?.name || !body.file.uri) throw new AnalysisError('analysis_failed', [`upload_${done.status}`]);
    let state = body.file.state;
    const deadline = Date.now() + 180_000;
    while (state !== 'ACTIVE') {
      if (state === 'FAILED' || Date.now() > deadline) throw new AnalysisError('analysis_failed', ['file_processing']);
      await new Promise((r) => setTimeout(r, this.pollMs));
      const poll = await this.fetchImpl(`${API}/v1beta/${body.file.name}`, { headers: { 'x-goog-api-key': this.apiKey } });
      state = ((await poll.json().catch(() => null)) as { state?: string } | null)?.state;
    }
    return { name: body.file.name, uri: body.file.uri };
  }

  async #delete(name: string): Promise<void> {
    await this.fetchImpl(`${API}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': this.apiKey } }).catch(() => undefined);
  }

  async #generate(parts: unknown[]): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${API}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { response_mime_type: 'application/json', temperature: 0.7 } }),
    });
    const body = (await res.json().catch(() => null)) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
    if (!res.ok) throw new AnalysisError('analysis_failed', [`generate_${res.status}`]);
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const json = parseModelJson(text);
    if (!json) throw new AnalysisError('analysis_unreadable_answer');
    return json;
  }

  async #withVideos<T>(files: readonly string[], run: (uploaded: Array<{ uri: string }>) => Promise<T>): Promise<T> {
    const uploaded: Array<{ name: string; uri: string }> = [];
    try {
      for (const f of files) uploaded.push(await this.#upload(f));
      return await run(uploaded);
    } finally {
      await Promise.all(uploaded.map((u) => this.#delete(u.name)));
    }
  }

  describeVideo(file: string, context: { note: string; recentCaptions: readonly string[]; fileName?: string }): Promise<VideoAnalysis> {
    return this.#withVideos([file], async ([v]) => {
      const out = validateVideoAnalysis(await this.#generate([{ file_data: { mime_type: 'video/mp4', file_uri: v!.uri } }, { text: videoCaptionInstructions(context) }]));
      if (!out) throw new AnalysisError('analysis_unreadable_answer');
      return out;
    });
  }

  analyzeReferences(files: readonly string[], note: string): Promise<ReferenceAnalysis> {
    return this.#withVideos(files, async (vs) => {
      const out = validateReferenceAnalysis(await this.#generate([...vs.map((v) => ({ file_data: { mime_type: 'video/mp4', file_uri: v.uri } })), { text: referenceInstructions(note) }]));
      if (!out) throw new AnalysisError('analysis_unreadable_answer');
      return out;
    });
  }

  async variations(ref: ReferenceAnalysis, count: number, video: { durationSeconds: number; aspectRatio: string }, avoid: readonly string[]): Promise<Variation[]> {
    const out = validateVariations(await this.#generate([{ text: variationInstructions(ref, count, video, avoid) }]), count);
    if (out.length === 0) throw new AnalysisError('analysis_unreadable_answer');
    return out;
  }
}

/**
 * Deterministic stand-in for tests and the synthetic build: no network, no
 * cost. Reads only the file name (and the note); a name containing "unclear"
 * is treated as a video the model can't make out.
 */
export class SyntheticAnalyzer implements MediaAnalyzer {
  readonly id = 'synthetic';
  async describeVideo(file: string, context: { note: string; recentCaptions: readonly string[]; fileName?: string }): Promise<VideoAnalysis> {
    const name = basename(context.fileName ?? file).replace(/\.[^.]+$/, '');
    if (/unclear/i.test(name) || /unclear/i.test(context.note)) return { understood: false, confidence: 0.1, summary: '', caption: '', hashtags: [] };
    const words = (context.note || name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const subject = words.split(' ').slice(0, 6).join(' ');
    return {
      understood: true,
      confidence: 0.9,
      summary: `Synthetic video: ${subject}.`,
      caption: `Ternyata begini caranya: ${subject}. Kamu pernah coba?`,
      hashtags: ['#' + (subject.split(' ')[0] ?? 'video').toLowerCase(), '#tipsharian', '#ide'],
    };
  }
  async analyzeReferences(files: readonly string[], note: string): Promise<ReferenceAnalysis> {
    return {
      hook: 'Close-up of an unexpected result in the first second, then a reaction',
      structure: ['Result first', 'Rewind to the start', 'Quick steps', 'Reaction and question to viewers'],
      pacing: `Cuts every 1–2 seconds across ${files.length} reference(s)${note ? `; owner note: ${note.slice(0, 60)}` : ''}`,
      attention: ['result shown first', 'fast cuts', 'question at the end'],
      format: 'Show the satisfying end result first, then how it was done in quick steps, ending with a question',
      audio: 'Upbeat background sound, short spoken lines',
    };
  }
  async variations(ref: ReferenceAnalysis, count: number): Promise<Variation[]> {
    const subjects = ['menata lemari kecil', 'membersihkan sepatu putih', 'memasak nasi goreng kilat', 'merapikan kabel meja', 'menyiram tanaman hias', 'melipat baju cepat'];
    return Array.from({ length: count }, (_, i) => {
      const s = subjects[i % subjects.length]!;
      return {
        hook: `Opens on the finished result of ${s}, sharp close-up, then a surprised face`,
        scene: `An Indonesian young adult at home ${s}, natural daylight`,
        action: `${ref.structure.join(', ')}; ${s} shown in three quick steps`,
        style: 'Handheld phone camera, fast cuts, bright natural colours',
        audio: 'Upbeat background sound; one short line in Bahasa Indonesia: "Gampang banget kan?"',
        caption: `Cara ${s} yang ternyata gampang banget. Mau coba?`,
      };
    });
  }
}

export interface AnalysisSettings {
  readonly provider: 'gemini';
  readonly model: string;
  /** Owner's estimate of what one analysis call costs (USD). */
  readonly costPerCallUsd: number;
  /** Calls stop once this month's estimated spend would pass it (USD). */
  readonly monthlyBudgetUsd: number;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = { provider: 'gemini', model: 'gemini-3.8-flash', costPerCallUsd: 0.01, monthlyBudgetUsd: 10 };

export interface Sealer {
  available(): boolean;
  seal(text: string): Buffer;
  open(bytes: Buffer): string;
}

export interface AnalysisStatus {
  readonly provider: string;
  readonly model: string;
  readonly keySet: boolean;
  /** True when calls can be made now (synthetic, or a real key is set). */
  readonly ready: boolean;
  readonly synthetic: boolean;
  readonly costPerCallUsd: number;
  readonly monthlyBudgetUsd: number;
  readonly spentThisMonthUsd: number;
  readonly callsThisMonth: number;
}

/** Settings, the sealed key, the monthly budget, and the analyzer to use. */
export class AnalysisService {
  readonly #db: DatabaseSync;
  readonly #keyFile: string;
  constructor(
    meta: MetadataDb,
    userData: string,
    private readonly sealer: Sealer,
    private readonly log: Logger,
    private readonly options: { synthetic: boolean; makeReal?: (key: string, model: string) => MediaAnalyzer; now?: () => Date },
  ) {
    if (!meta.db) throw new Error('analysis needs a writable database');
    this.#db = meta.db;
    this.#keyFile = join(userData, 'ai-secrets', 'gemini.sealed');
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  settings(): AnalysisSettings {
    const row = this.#db.prepare('SELECT model, cost_per_call_usd, monthly_budget_usd FROM analysis_settings WHERE id = 1').get() as
      | { model: string; cost_per_call_usd: number; monthly_budget_usd: number }
      | undefined;
    return row ? { provider: 'gemini', model: row.model, costPerCallUsd: row.cost_per_call_usd, monthlyBudgetUsd: row.monthly_budget_usd } : DEFAULT_ANALYSIS_SETTINGS;
  }

  /** Saves settings; a non-empty key replaces the sealed one (an empty key keeps it). */
  save(raw: unknown, apiKey: unknown): void {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const model = typeof o['model'] === 'string' ? o['model'].trim() : '';
    const cost = o['costPerCallUsd'];
    const budget = o['monthlyBudgetUsd'];
    const issues: string[] = [];
    if (!/^[a-z0-9][a-z0-9.\-]{1,60}$/.test(model)) issues.push('invalid_model');
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > 10) issues.push('invalid_cost');
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0 || budget > 10_000) issues.push('invalid_budget');
    if (apiKey !== null && apiKey !== undefined && apiKey !== '' && (typeof apiKey !== 'string' || !/^[A-Za-z0-9_\-]{20,200}$/.test(apiKey.trim()))) issues.push('invalid_api_key');
    if (issues.length > 0) throw new AnalysisError('invalid_analysis_settings', issues);
    if (typeof apiKey === 'string' && apiKey.trim() !== '') {
      if (!this.sealer.available()) throw new AnalysisError('secure_storage_unavailable');
      mkdirSync(join(this.#keyFile, '..'), { recursive: true, mode: 0o700 });
      writeAtomic(this.#keyFile, this.sealer.seal(apiKey.trim()));
      this.log.info('analysis_key_saved');
    }
    this.#db
      .prepare(
        `INSERT INTO analysis_settings (id, model, cost_per_call_usd, monthly_budget_usd, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET model = excluded.model, cost_per_call_usd = excluded.cost_per_call_usd, monthly_budget_usd = excluded.monthly_budget_usd, updated_at = excluded.updated_at`,
      )
      .run(model, cost as number, budget as number, this.#now().toISOString());
  }

  removeKey(): void {
    rmSync(this.#keyFile, { force: true });
    this.log.info('analysis_key_removed');
  }

  #monthStart(): string {
    const n = this.#now();
    return new Date(n.getFullYear(), n.getMonth(), 1).toISOString();
  }

  status(): AnalysisStatus {
    const s = this.settings();
    const usage = this.#db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spent, COUNT(*) AS calls FROM analysis_usage WHERE at >= ?').get(this.#monthStart()) as { spent: number; calls: number };
    const keySet = existsSync(this.#keyFile);
    return {
      provider: this.options.synthetic ? 'synthetic' : s.provider,
      model: this.options.synthetic ? 'synthetic' : s.model,
      keySet,
      ready: this.options.synthetic || keySet,
      synthetic: this.options.synthetic,
      costPerCallUsd: s.costPerCallUsd,
      monthlyBudgetUsd: s.monthlyBudgetUsd,
      spentThisMonthUsd: Math.round(usage.spent * 10000) / 10000,
      callsThisMonth: usage.calls,
    };
  }

  #analyzer(): MediaAnalyzer {
    if (this.options.synthetic) return new SyntheticAnalyzer();
    if (!existsSync(this.#keyFile)) throw new AnalysisError('analysis_not_configured');
    if (!this.sealer.available()) throw new AnalysisError('secure_storage_unavailable');
    const key = this.sealer.open(readFileSync(this.#keyFile));
    const s = this.settings();
    return this.options.makeReal ? this.options.makeReal(key, s.model) : new GeminiAnalyzer(key, s.model);
  }

  /** Runs one analysis call within the monthly budget and records its estimated cost. */
  async run<T>(bundleId: string, kind: 'video' | 'reference' | 'variations', call: (a: MediaAnalyzer) => Promise<T>): Promise<T> {
    const analyzer = this.#analyzer();
    const synthetic = analyzer.id === 'synthetic';
    const s = this.settings();
    const cost = synthetic ? 0 : s.costPerCallUsd;
    if (!synthetic && this.status().spentThisMonthUsd + cost > s.monthlyBudgetUsd) throw new AnalysisError('analysis_budget_reached');
    let ok = 0;
    try {
      const out = await call(analyzer);
      ok = 1;
      return out;
    } finally {
      this.#db.prepare('INSERT INTO analysis_usage (bundle_id, kind, at, cost_usd, ok) VALUES (?, ?, ?, ?, ?)').run(bundleId, kind, this.#now().toISOString(), cost, ok);
      this.log.info('analysis_call', { kind, provider: analyzer.id, ok: ok === 1 });
    }
  }
}
