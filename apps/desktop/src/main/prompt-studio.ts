import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rm, stat } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BLOCKING_FLAGS,
  buildConceptRequest,
  contentFlags,
  defaultConfig,
  EDITABLE_STATUSES,
  looksLikeMp4,
  manualSteps,
  nearDuplicates,
  payloadIsSafe,
  planVariations,
  PROMPT_ACTIONS,
  renderContent,
  renderText,
  STARTER_TEMPLATES,
  validateConceptResponse,
  validateConfig,
  validateTemplate,
  type ConceptProvider,
  type ConceptProviderDescriptor,
  type Logger,
  type PromptAction,
  type PromptContent,
  type PromptFlag,
  type PromptStatus,
  type PromptTemplate,
  type ReferenceKind,
  type TemplateConfig,
} from '@ugc/core';
import type { GenerationService } from './generation.js';
import type { GenerationJob, GenerationStore } from './generation-store.js';
import { PROFILE_ID, type BundleStore, type MetadataDb } from './profiles.js';

/**
 * Prompt Studio (T1, Ternak Akun): templates → per-account configuration →
 * batches of distinct, complete Google Flow prompts → review, edit, approve →
 * production queue. Prompt approval and video production are separate
 * statuses; a video is only "ready" when a real file is linked. Prompts,
 * captions and character text are the owner's content: stored locally,
 * never logged (logs carry ids, counts and codes).
 */

export type StudioErrorCode =
  | 'not_growth_account'
  | 'unknown_template'
  | 'invalid_template'
  | 'builtin_read_only'
  | 'invalid_template_config'
  | 'unknown_prompt'
  | 'invalid_prompt_edit'
  | 'prompt_action_not_allowed'
  | 'prompt_blocked'
  | 'concept_provider_failed'
  | 'unsafe_payload'
  | 'unknown_reference_asset'
  | 'invalid_reference_file'
  | 'rights_not_confirmed'
  | 'invalid_preset'
  | 'unknown_video'
  | 'no_provider';

export class StudioError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export const MAX_REFERENCE_BYTES = 200 * 1024 * 1024;
const REFERENCE_TYPES: Record<string, ReferenceKind> = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.mov': 'video' };
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface TemplateSummary {
  readonly template: PromptTemplate;
  readonly versions: number;
}

export interface ReferenceAsset {
  readonly id: string;
  readonly name: string;
  readonly kind: ReferenceKind;
  readonly bytes: number;
  readonly file: string;
  readonly createdAt: string;
}

export interface CreativePreset {
  readonly id: string;
  readonly kind: 'character' | 'world' | 'style';
  readonly name: string;
  readonly text: string;
}

export interface PromptItem {
  readonly id: string;
  readonly batchId: string;
  readonly position: number;
  readonly status: PromptStatus;
  readonly axes: Readonly<Record<string, string>>;
  readonly content: PromptContent;
  readonly rendered: string;
  readonly edited: boolean;
  readonly flags: readonly PromptFlag[];
  /** Positions (1-based) of near-duplicate prompts in the same batch. */
  readonly duplicates: readonly number[];
  readonly manualSteps: readonly string[];
  readonly references: ReadonlyArray<{ id: string; name: string; kind: ReferenceKind; available: boolean }>;
  readonly handoff: 'provider' | 'manual' | null;
  readonly jobId: string | null;
  readonly lastError: string | null;
  readonly video: { jobId: string; file: string } | null;
  readonly updatedAt: string;
}

export interface PromptBatch {
  readonly id: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly templateName: string;
  readonly providerId: string;
  readonly requested: number;
  readonly shortfall: string | null;
  readonly createdAt: string;
  readonly items: readonly PromptItem[];
}

export interface StudioView {
  readonly templates: readonly TemplateSummary[];
  readonly configs: Readonly<Record<string, { config: TemplateConfig; saved: boolean }>>;
  readonly batches: readonly PromptBatch[];
  readonly counts: Readonly<Record<PromptStatus, number>>;
  readonly references: readonly ReferenceAsset[];
  readonly presets: readonly CreativePreset[];
  readonly conceptProvider: ConceptProviderDescriptor;
  readonly videoProvider: { available: boolean; label: string | null; reason: string | null };
  readonly unlinkedVideos: ReadonlyArray<{ jobId: string; source: string; createdAt: string; bytes: number | null }>;
}

interface ItemRow {
  id: string;
  batch_id: string;
  bundle_id: string;
  position: number;
  axes_json: string;
  slots_json: string;
  content_json: string;
  rendered: string;
  status: PromptStatus;
  edited: number;
  flags_json: string;
  duplicates_json: string;
  handoff: 'provider' | 'manual' | null;
  job_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface BatchRow {
  id: string;
  bundle_id: string;
  template_key: string;
  template_version: number;
  template_json: string;
  config_json: string;
  assets_json: string;
  provider_id: string;
  seed: string;
  requested: number;
  shortfall: string | null;
  created_at: string;
}

type AssetSnapshot = { id: string; name: string; kind: ReferenceKind };

export interface PromptStudioDeps {
  readonly meta: MetadataDb;
  readonly bundles: BundleStore;
  readonly jobs: GenerationStore;
  readonly generation: GenerationService | null;
  readonly provider: ConceptProvider;
  readonly log: Logger;
  readonly userData: string;
  /** Values that must never leave this computer in a provider request (account names, proxy hosts, ids…). */
  readonly sensitiveValues: () => string[];
  readonly now?: () => Date;
}

export class PromptStudioService {
  readonly #db: DatabaseSync;
  readonly #deps: PromptStudioDeps;
  readonly #now: () => Date;

  constructor(deps: PromptStudioDeps) {
    if (!deps.meta.db) throw new Error('prompt studio needs a writable database');
    this.#db = deps.meta.db;
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #requireGrowth(bundleId: string): void {
    if (this.#deps.bundles.get(bundleId)?.mode !== 'account_growth') throw new StudioError('not_growth_account');
  }

  // ---- Templates ----

  #customLatest(key: string): { template: PromptTemplate; versions: number } | null {
    const rows = this.#db.prepare('SELECT definition_json FROM prompt_templates WHERE key = ? ORDER BY version DESC').all(key) as Array<{ definition_json: string }>;
    return rows.length === 0 ? null : { template: JSON.parse(rows[0]!.definition_json) as PromptTemplate, versions: rows.length };
  }

  templates(): TemplateSummary[] {
    const keys = (this.#db.prepare('SELECT DISTINCT key FROM prompt_templates ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key);
    const custom = keys.map((k) => this.#customLatest(k)!).sort((a, b) => a.template.name.localeCompare(b.template.name));
    return [...STARTER_TEMPLATES.map((t) => ({ template: t, versions: 1 })), ...custom];
  }

  template(key: string): PromptTemplate {
    const starter = STARTER_TEMPLATES.find((t) => t.key === key);
    if (starter) return starter;
    const custom = this.#customLatest(key);
    if (!custom) throw new StudioError('unknown_template');
    return custom.template;
  }

  /** Saves an owner template: a new template, or a new version of an existing custom one. Starters are read-only. */
  saveTemplate(raw: unknown, baseKey: string | null): PromptTemplate {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    let key: string;
    let version: number;
    if (baseKey) {
      if (STARTER_TEMPLATES.some((t) => t.key === baseKey)) throw new StudioError('builtin_read_only');
      const existing = this.#customLatest(baseKey);
      if (!existing) throw new StudioError('unknown_template');
      key = baseKey;
      version = existing.template.version + 1;
    } else {
      key = `custom-${randomUUID().slice(0, 8)}`;
      version = 1;
    }
    const valid = validateTemplate({ ...body, key, version, builtin: false, family: body['family'] ?? 'custom' });
    if (!valid.ok) throw new StudioError('invalid_template', valid.issues);
    this.#db.prepare('INSERT INTO prompt_templates (key, version, definition_json, created_at) VALUES (?, ?, ?, ?)').run(key, version, JSON.stringify(valid.value), this.#iso());
    this.#deps.log.info('prompt_template_saved', { key, version });
    return valid.value;
  }

  duplicateTemplate(key: string): PromptTemplate {
    const t = this.template(key);
    return this.saveTemplate({ ...t, name: `${t.name} (copy)`.slice(0, 80) }, null);
  }

  // ---- Per-account configuration ----

  config(bundleId: string, key: string): { config: TemplateConfig; saved: boolean } {
    const t = this.template(key);
    const row = this.#db.prepare('SELECT config_json FROM template_configs WHERE bundle_id = ? AND template_key = ?').get(bundleId, key) as { config_json: string } | undefined;
    if (!row) return { config: defaultConfig(t), saved: false };
    // A config saved for an earlier template version is re-validated against the current one.
    const valid = validateConfig(t, JSON.parse(row.config_json));
    return valid.ok ? { config: valid.value, saved: true } : { config: defaultConfig(t), saved: false };
  }

  saveConfig(bundleId: string, key: string, raw: unknown): void {
    this.#requireGrowth(bundleId);
    const t = this.template(key);
    const valid = validateConfig(t, raw);
    if (!valid.ok) throw new StudioError('invalid_template_config', valid.issues);
    const assets = this.#assets(bundleId);
    for (const id of valid.value.referenceAssetIds) {
      const asset = assets.find((a) => a.id === id);
      if (!asset) throw new StudioError('invalid_template_config', ['invalid_reference_assets']);
      if (!t.references.kinds.includes(asset.kind)) throw new StudioError('invalid_template_config', ['reference_kind_not_allowed']);
    }
    this.#db
      .prepare(
        `INSERT INTO template_configs (bundle_id, template_key, config_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(bundle_id, template_key) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      )
      .run(bundleId, key, JSON.stringify(valid.value), this.#iso());
  }

  // ---- Generation of prompt batches ----

  async #fill(t: PromptTemplate, config: TemplateConfig, items: Array<{ position: number; axes: Record<string, string> }>, seed: string): Promise<Array<Record<string, string>>> {
    const { provider } = this.#deps;
    const request = buildConceptRequest(t, config, items, seed);
    if (provider.descriptor.remote && !payloadIsSafe(request, this.#deps.sensitiveValues())) {
      this.#deps.log.warn('concept_payload_refused', { provider: provider.descriptor.id });
      throw new StudioError('unsafe_payload');
    }
    let response: unknown;
    try {
      response = await provider.fill(request);
    } catch {
      throw new StudioError('concept_provider_failed', ['unavailable']);
    }
    if (typeof response === 'object' && response !== null && 'error' in response) throw new StudioError('concept_provider_failed', [String((response as { error: string }).error)]);
    if (!validateConceptResponse(request, response)) throw new StudioError('concept_provider_failed', ['invalid_output']);
    return items.map((i) => ({ ...response.items.find((r) => r.position === i.position)!.slots }));
  }

  /** Generates one batch of distinct prompts for the account from its saved (or default) configuration. */
  async generate(bundleId: string, key: string): Promise<PromptBatch> {
    this.#requireGrowth(bundleId);
    const t = this.template(key);
    const { config } = this.config(bundleId, key);
    const batchId = randomUUID();
    // The seed travels to the provider, so it carries no account id.
    const seed = batchId;
    // Prefer combinations this account hasn't used recently for this template; fall back if the pools are small.
    const recent = (
      this.#db
        .prepare(
          `SELECT i.axes_json FROM prompt_items i JOIN prompt_batches b ON b.id = i.batch_id
           WHERE i.bundle_id = ? AND b.template_key = ? AND i.status != 'rejected' ORDER BY i.created_at DESC LIMIT 60`,
        )
        .all(bundleId, key) as Array<{ axes_json: string }>
    ).map((r) => JSON.parse(r.axes_json) as Record<string, string>);
    let plan = planVariations(config.pools, config.count, seed, recent);
    if (plan.shortfall) plan = planVariations(config.pools, config.count, seed);
    const planned = plan.items.map((axes, i) => ({ position: i + 1, axes: { ...axes } }));
    const slots = planned.length > 0 ? await this.#fill(t, config, planned, seed) : [];
    const assets = this.#assetSnapshot(bundleId, config);
    const now = this.#iso();
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare(
          `INSERT INTO prompt_batches (id, bundle_id, template_key, template_version, template_json, config_json, assets_json, provider_id, seed, requested, shortfall, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(batchId, bundleId, t.key, t.version, JSON.stringify(t), JSON.stringify(config), JSON.stringify(assets), this.#deps.provider.descriptor.id, seed, config.count, plan.shortfall, now);
      planned.forEach((p, i) => {
        const content = renderContent(t, config, p.axes, slots[i]!);
        this.#db
          .prepare(
            `INSERT INTO prompt_items (id, batch_id, bundle_id, position, axes_json, slots_json, content_json, rendered, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          )
          .run(randomUUID(), batchId, bundleId, p.position, JSON.stringify(p.axes), JSON.stringify(slots[i]), JSON.stringify(content), renderText(content), now, now);
      });
      this.#refreshFlags(batchId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#deps.log.info('prompt_batch_generated', { bundleId, batchId, template: t.key, version: t.version, requested: config.count, created: planned.length, provider: this.#deps.provider.descriptor.id });
    return this.#batchView(this.#batchRow(batchId)!);
  }

  /** Replaces one prompt with a new variation that differs from the rest of its batch. */
  async regenerate(bundleId: string, itemId: string): Promise<void> {
    this.#requireGrowth(bundleId);
    const item = this.#item(bundleId, itemId);
    if (!EDITABLE_STATUSES.includes(item.status)) throw new StudioError('prompt_action_not_allowed');
    const batch = this.#batchRow(item.batch_id)!;
    const t = JSON.parse(batch.template_json) as PromptTemplate;
    const config = JSON.parse(batch.config_json) as TemplateConfig;
    const others = (this.#db.prepare('SELECT axes_json FROM prompt_items WHERE batch_id = ?').all(batch.id) as Array<{ axes_json: string }>).map(
      (r) => JSON.parse(r.axes_json) as Record<string, string>,
    );
    const seed = `${batch.seed}:${itemId}:${item.updated_at}`;
    let plan = planVariations(config.pools, 1, seed, others);
    if (plan.items.length === 0) plan = planVariations(config.pools, 1, seed, [JSON.parse(item.axes_json) as Record<string, string>]);
    const axes = { ...(plan.items[0] ?? (JSON.parse(item.axes_json) as Record<string, string>)) };
    const [slots] = await this.#fill(t, config, [{ position: item.position, axes }], seed);
    const content = renderContent(t, config, axes, slots!);
    this.#db
      .prepare("UPDATE prompt_items SET axes_json = ?, slots_json = ?, content_json = ?, rendered = ?, status = 'draft', edited = 0, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(axes), JSON.stringify(slots), JSON.stringify(content), renderText(content), this.#iso(), itemId);
    this.#refreshFlags(batch.id);
    this.#deps.log.info('prompt_regenerated', { bundleId, itemId });
  }

  /** Owner edits of a prompt's sections and caption. Any edit returns it to draft for review. */
  updateItem(bundleId: string, itemId: string, raw: unknown): void {
    this.#requireGrowth(bundleId);
    const item = this.#item(bundleId, itemId);
    if (!EDITABLE_STATUSES.includes(item.status)) throw new StudioError('prompt_action_not_allowed');
    const current = JSON.parse(item.content_json) as PromptContent;
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const sections = body['sections'];
    const caption = body['caption'];
    if (
      !Array.isArray(sections) ||
      sections.length !== current.sections.length ||
      !sections.every((s, i) => typeof s === 'object' && s !== null && s.key === current.sections[i]!.key && typeof s.text === 'string' && s.text.trim() !== '' && s.text.length <= 4000 && !CONTROL.test(s.text)) ||
      typeof caption !== 'string' ||
      caption.length > 2200 ||
      CONTROL.test(caption)
    ) {
      throw new StudioError('invalid_prompt_edit');
    }
    const content: PromptContent = {
      sections: current.sections.map((s, i) => ({ key: s.key, title: s.title, text: (sections[i] as { text: string }).text.trim() })),
      caption: caption.trim(),
    };
    this.#db
      .prepare("UPDATE prompt_items SET content_json = ?, rendered = ?, status = 'draft', edited = 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(content), renderText(content), this.#iso(), itemId);
    this.#refreshFlags(item.batch_id);
  }

  /** Status changes the owner makes (approve, reject, queue, take to Flow by hand…). */
  act(bundleId: string, itemId: string, action: PromptAction): void {
    this.#requireGrowth(bundleId);
    const rule = PROMPT_ACTIONS[action];
    if (!rule) throw new StudioError('prompt_action_not_allowed');
    const item = this.#item(bundleId, itemId);
    if (!rule.from.includes(item.status)) throw new StudioError('prompt_action_not_allowed');
    const flags = JSON.parse(item.flags_json) as PromptFlag[];
    if (action === 'approve') {
      const blocking = flags.filter((f) => (BLOCKING_FLAGS as readonly string[]).includes(f));
      if (blocking.length > 0) throw new StudioError('prompt_blocked', blocking);
    }
    if (action === 'back_to_queue' && item.handoff === 'provider' && item.job_id) {
      const job = this.#deps.jobs.get(item.job_id);
      if (job && (job.state === 'pending' || job.state === 'running')) throw new StudioError('prompt_action_not_allowed');
    }
    const handoff = action === 'start_manual' ? 'manual' : rule.to === 'generating' ? item.handoff : null;
    this.#db
      .prepare('UPDATE prompt_items SET status = ?, handoff = ?, job_id = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(rule.to, handoff, rule.to === 'generating' ? item.job_id : null, null, this.#iso(), itemId);
    if (action === 'reject' || action === 'reopen') this.#refreshFlags(item.batch_id);
    this.#deps.log.info('prompt_status_changed', { bundleId, itemId, action });
  }

  /** The text to paste into Google Flow (by hand). */
  copyText(bundleId: string, itemId: string): string {
    const item = this.#item(bundleId, itemId);
    if (item.status === 'rejected') throw new StudioError('prompt_action_not_allowed');
    return item.rendered;
  }

  /** Starts a video job from a queued prompt with the configured provider (synthetic in tests; none in real use yet). */
  generateVideo(bundleId: string, itemId: string): GenerationJob {
    this.#requireGrowth(bundleId);
    const item = this.#item(bundleId, itemId);
    if (item.status !== 'queued') throw new StudioError('prompt_action_not_allowed');
    if (!this.#deps.generation) throw new StudioError('no_provider');
    const config = JSON.parse(this.#batchRow(item.batch_id)!.config_json) as TemplateConfig;
    const job = this.#deps.generation.start(bundleId, { promptItemId: itemId, prompt: item.rendered, settings: config.video });
    this.#db.prepare("UPDATE prompt_items SET status = 'generating', handoff = 'provider', job_id = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(job.id, this.#iso(), itemId);
    return job;
  }

  /** Links a video already in the library (e.g. a manual Flow download) to a queued or generating prompt. */
  linkVideo(bundleId: string, itemId: string, jobId: string): void {
    this.#requireGrowth(bundleId);
    const item = this.#item(bundleId, itemId);
    if (item.status !== 'queued' && item.status !== 'generating') throw new StudioError('prompt_action_not_allowed');
    if (item.status === 'generating' && item.handoff === 'provider') throw new StudioError('prompt_action_not_allowed');
    const job = this.#deps.jobs.get(jobId);
    if (!job || job.bundleId !== bundleId || job.state !== 'completed' || !job.videoFile || job.promptItemId) throw new StudioError('unknown_video');
    this.#deps.jobs.linkPrompt(jobId, itemId);
    this.#db.prepare("UPDATE prompt_items SET status = 'video_ready', job_id = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(jobId, this.#iso(), itemId);
  }

  /** For the Flow download handler: the oldest prompt the owner took to Flow by hand and is still waiting for its video. */
  claimManualPrompt(bundleId: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT id FROM prompt_items i WHERE bundle_id = ? AND status = 'generating' AND handoff = 'manual'
         AND NOT EXISTS (SELECT 1 FROM generation_jobs j WHERE j.prompt_item_id = i.id AND j.state IN ('pending', 'running'))
         ORDER BY updated_at, rowid LIMIT 1`,
      )
      .get(bundleId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** A job linked to a prompt ended: a real video makes it "video ready"; a failed provider job returns it to the queue. */
  jobEnded(job: GenerationJob): void {
    if (!job.promptItemId) return;
    const item = this.#db.prepare('SELECT * FROM prompt_items WHERE id = ? AND bundle_id = ?').get(job.promptItemId, job.bundleId) as unknown as ItemRow | undefined;
    if (!item || item.status !== 'generating') return;
    if (item.handoff === 'provider' && item.job_id !== job.id) return;
    if (job.state === 'completed' && job.videoFile) {
      this.#db.prepare("UPDATE prompt_items SET status = 'video_ready', job_id = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(job.id, this.#iso(), item.id);
    } else if (item.handoff === 'manual') {
      this.#db.prepare('UPDATE prompt_items SET last_error = ?, updated_at = ? WHERE id = ?').run('manual_download_failed', this.#iso(), item.id);
    } else {
      this.#db
        .prepare("UPDATE prompt_items SET status = 'queued', handoff = NULL, job_id = NULL, last_error = ?, updated_at = ? WHERE id = ?")
        .run(job.errorCode ?? 'failed', this.#iso(), item.id);
    }
  }

  /** After a restart: provider prompts whose job already ended are resolved. */
  reconcile(): void {
    const rows = this.#db.prepare("SELECT id, job_id FROM prompt_items WHERE status = 'generating' AND handoff = 'provider'").all() as Array<{ id: string; job_id: string | null }>;
    for (const r of rows) {
      const job = r.job_id ? this.#deps.jobs.get(r.job_id) : undefined;
      if (!job) {
        this.#db.prepare("UPDATE prompt_items SET status = 'queued', handoff = NULL, job_id = NULL, last_error = 'interrupted' WHERE id = ?").run(r.id);
      } else if (job.state !== 'pending' && job.state !== 'running') {
        this.jobEnded(job);
      }
    }
  }

  // ---- Reference files (local only; never sent to a concept provider) ----

  #assets(bundleId: string): ReferenceAsset[] {
    return (
      this.#db.prepare('SELECT id, name, kind, bytes, file, created_at FROM reference_assets WHERE bundle_id = ? ORDER BY created_at, rowid').all(bundleId) as Array<{
        id: string;
        name: string;
        kind: ReferenceKind;
        bytes: number;
        file: string;
        created_at: string;
      }>
    ).map((r) => ({ id: r.id, name: r.name, kind: r.kind, bytes: r.bytes, file: r.file, createdAt: r.created_at }));
  }

  #assetSnapshot(bundleId: string, config: TemplateConfig): AssetSnapshot[] {
    const assets = this.#assets(bundleId);
    return config.referenceAssetIds.flatMap((id) => {
      const a = assets.find((x) => x.id === id);
      return a ? [{ id: a.id, name: a.name, kind: a.kind }] : [];
    });
  }

  /** Copies a file the owner picked (and confirmed they have rights to) into the account's reference folder. */
  async addReference(bundleId: string, sourcePath: string, rightsConfirmed: boolean): Promise<ReferenceAsset> {
    this.#requireGrowth(bundleId);
    if (rightsConfirmed !== true) throw new StudioError('rights_not_confirmed');
    const ext = extname(sourcePath).toLowerCase();
    const kind = REFERENCE_TYPES[ext];
    if (!kind) throw new StudioError('invalid_reference_file', ['unsupported_type']);
    const info = await stat(sourcePath).catch(() => null);
    if (!info || !info.isFile()) throw new StudioError('invalid_reference_file', ['unreadable']);
    if (info.size > MAX_REFERENCE_BYTES) throw new StudioError('invalid_reference_file', ['reference_too_large']);
    if (info.size < 12) throw new StudioError('invalid_reference_file', ['unreadable']);
    const head = Buffer.alloc(16);
    const fh = await open(sourcePath, 'r');
    try {
      await fh.read(head, 0, 16, 0);
    } finally {
      await fh.close();
    }
    const signatureOk =
      kind === 'video'
        ? looksLikeMp4(new Uint8Array([0, 0, 0, 8, ...head.subarray(4, 8), 0, 0, 0, 0]))
        : (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
          head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
          (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP');
    if (!signatureOk) throw new StudioError('invalid_reference_file', ['content_mismatch']);
    const id = randomUUID();
    const dir = join(this.#deps.userData, 'references', bundleId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${id}${ext}`);
    await copyFile(sourcePath, target);
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(target)
        .on('data', (c) => hash.update(c))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
    const name = basename(sourcePath).replace(CONTROL, '').slice(0, 120);
    const file = `references/${bundleId}/${id}${ext}`;
    const now = this.#iso();
    this.#db
      .prepare('INSERT INTO reference_assets (id, bundle_id, file, name, kind, bytes, sha256, rights_confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, bundleId, file, name, kind, info.size, sha256, now, now);
    this.#deps.log.info('reference_asset_added', { bundleId, assetId: id, kind, bytes: info.size });
    return { id, name, kind, bytes: info.size, file, createdAt: now };
  }

  async removeReference(bundleId: string, assetId: string): Promise<void> {
    const asset = this.#assets(bundleId).find((a) => a.id === assetId);
    if (!asset) throw new StudioError('unknown_reference_asset');
    await rm(this.referencePath(bundleId, assetId), { force: true });
    this.#db.prepare('DELETE FROM reference_assets WHERE id = ? AND bundle_id = ?').run(assetId, bundleId);
  }

  referencePath(bundleId: string, assetId: string): string {
    const asset = this.#assets(bundleId).find((a) => a.id === assetId);
    if (!asset || !PROFILE_ID.test(bundleId)) throw new StudioError('unknown_reference_asset');
    const abs = join(this.#deps.userData, ...asset.file.split('/'));
    if (!abs.startsWith(join(this.#deps.userData, 'references') + sep)) throw new StudioError('unknown_reference_asset');
    return abs;
  }

  // ---- Reusable character / world / style presets ----

  presets(): CreativePreset[] {
    return this.#db.prepare('SELECT id, kind, name, text FROM creative_presets ORDER BY kind, name').all() as unknown as CreativePreset[];
  }

  savePreset(kind: unknown, name: unknown, text: unknown): void {
    if (
      (kind !== 'character' && kind !== 'world' && kind !== 'style') ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      name.length > 80 ||
      CONTROL.test(name) ||
      typeof text !== 'string' ||
      text.trim() === '' ||
      text.length > 2000 ||
      CONTROL.test(text)
    ) {
      throw new StudioError('invalid_preset');
    }
    this.#db
      .prepare('INSERT INTO creative_presets (id, kind, name, text, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, name) DO UPDATE SET text = excluded.text')
      .run(randomUUID(), kind, name.trim(), text.trim(), this.#iso());
  }

  deletePreset(id: string): void {
    this.#db.prepare('DELETE FROM creative_presets WHERE id = ?').run(id);
  }

  // ---- Views ----

  #item(bundleId: string, itemId: string): ItemRow {
    const row = this.#db.prepare('SELECT * FROM prompt_items WHERE id = ? AND bundle_id = ?').get(itemId, bundleId) as unknown as ItemRow | undefined;
    if (!row) throw new StudioError('unknown_prompt');
    return row;
  }

  #batchRow(id: string): BatchRow | undefined {
    return this.#db.prepare('SELECT * FROM prompt_batches WHERE id = ?').get(id) as unknown as BatchRow | undefined;
  }

  /** Recomputes every prompt's flags in a batch (near-duplicates depend on the others). Rejected prompts are ignored. */
  #refreshFlags(batchId: string): void {
    const batch = this.#batchRow(batchId)!;
    const t = JSON.parse(batch.template_json) as PromptTemplate;
    const config = JSON.parse(batch.config_json) as TemplateConfig;
    const items = this.#db.prepare('SELECT * FROM prompt_items WHERE batch_id = ? ORDER BY position').all(batchId) as unknown as ItemRow[];
    const active = items.filter((i) => i.status !== 'rejected');
    const dups = nearDuplicates(active.map((i) => i.rendered));
    for (const item of items) {
      const k = active.indexOf(item);
      const duplicates = k >= 0 ? dups[k]!.map((j) => active[j]!.position) : [];
      const flags: PromptFlag[] = [...contentFlags(t, config, JSON.parse(item.content_json) as PromptContent)];
      if (duplicates.length > 0) flags.push('near_duplicate');
      this.#db.prepare('UPDATE prompt_items SET flags_json = ?, duplicates_json = ? WHERE id = ?').run(JSON.stringify(flags), JSON.stringify(duplicates), item.id);
    }
  }

  #batchView(b: BatchRow): PromptBatch {
    const t = JSON.parse(b.template_json) as PromptTemplate;
    const snapshot = JSON.parse(b.assets_json) as AssetSnapshot[];
    const live = new Set(this.#assets(b.bundle_id).map((a) => a.id));
    const references = snapshot.map((a) => ({ ...a, available: live.has(a.id) }));
    const steps = manualSteps(t, snapshot);
    const items = (this.#db.prepare('SELECT * FROM prompt_items WHERE batch_id = ? ORDER BY position').all(b.id) as unknown as ItemRow[]).map((r): PromptItem => {
      const job = r.job_id ? this.#deps.jobs.get(r.job_id) : undefined;
      return {
        id: r.id,
        batchId: r.batch_id,
        position: r.position,
        status: r.status,
        axes: JSON.parse(r.axes_json) as Record<string, string>,
        content: JSON.parse(r.content_json) as PromptContent,
        rendered: r.rendered,
        edited: r.edited === 1,
        flags: JSON.parse(r.flags_json) as PromptFlag[],
        duplicates: JSON.parse(r.duplicates_json) as number[],
        manualSteps: steps,
        references,
        handoff: r.handoff,
        jobId: r.job_id,
        lastError: r.last_error,
        video: r.status === 'video_ready' && job?.videoFile ? { jobId: job.id, file: job.videoFile } : null,
        updatedAt: r.updated_at,
      };
    });
    return {
      id: b.id,
      templateKey: b.template_key,
      templateVersion: b.template_version,
      templateName: t.name,
      providerId: b.provider_id,
      requested: b.requested,
      shortfall: b.shortfall,
      createdAt: b.created_at,
      items,
    };
  }

  view(bundleId: string): StudioView {
    this.#requireGrowth(bundleId);
    const templates = this.templates();
    const configs = Object.fromEntries(templates.map((s) => [s.template.key, this.config(bundleId, s.template.key)]));
    const batches = (this.#db.prepare('SELECT * FROM prompt_batches WHERE bundle_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10').all(bundleId) as unknown as BatchRow[]).map((b) =>
      this.#batchView(b),
    );
    const counts = { draft: 0, approved: 0, rejected: 0, queued: 0, generating: 0, video_ready: 0 } as Record<PromptStatus, number>;
    for (const r of this.#db.prepare('SELECT status, COUNT(*) AS n FROM prompt_items WHERE bundle_id = ? GROUP BY status').all(bundleId) as Array<{ status: PromptStatus; n: number }>) {
      counts[r.status] = r.n;
    }
    const gen = this.#deps.generation;
    const unlinkedVideos = this.#deps.jobs
      .list(bundleId, 50)
      .filter((j) => j.state === 'completed' && j.videoFile && !j.promptItemId)
      .map((j) => ({ jobId: j.id, source: j.source, createdAt: j.createdAt, bytes: j.videoBytes }));
    return {
      templates,
      configs,
      batches,
      counts,
      references: this.#assets(bundleId),
      presets: this.presets(),
      conceptProvider: this.#deps.provider.descriptor,
      videoProvider: { available: !!gen?.provider, label: gen?.provider?.displayName ?? null, reason: gen?.provider ? null : (gen?.unavailableReason ?? 'not enabled') },
      unlinkedVideos,
    };
  }
}
