import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASMR_TEMPLATE,
  createLogger,
  GRANDMA_TEMPLATE,
  TemplateProvider,
  type ConceptProvider,
  type ConceptRequest,
  type GenerationRequest,
  type VideoGenerationProvider,
} from '@ugc/core';
import { GenerationService } from '../src/main/generation.js';
import { GenerationStore } from '../src/main/generation-store.js';
import { VideoLibrary } from '../src/main/library.js';
import { BundleStore, MetadataDb, ProfileStore } from '../src/main/profiles.js';
import { PromptStudioService, StudioError } from '../src/main/prompt-studio.js';
import { SyntheticVideoProvider } from '../src/main/synthetic-provider.js';

const NOW = new Date('2026-10-22T09:00:00Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

/** Records every request; can be told to misbehave. */
class RecordingProvider implements ConceptProvider {
  readonly requests: ConceptRequest[] = [];
  constructor(
    readonly descriptor = { id: 'mock', displayName: 'Mock', kind: 'mock' as const, remote: true },
    private readonly mode: 'ok' | 'malformed' | 'refuse' = 'ok',
  ) {}
  async fill(request: ConceptRequest) {
    this.requests.push(request);
    if (this.mode === 'refuse') return { error: 'refused' as const };
    const ok = await new TemplateProvider().fill(request);
    return this.mode === 'malformed' ? { items: ok.items.map((i) => ({ ...i, slots: { ...i.slots, opening: 'copy https://example.test' } })) } : ok;
  }
}

class FailingVideoProvider implements VideoGenerationProvider {
  readonly id = 'failing';
  readonly displayName = 'Failing';
  readonly kind = 'synthetic' as const;
  async submit(_r: GenerationRequest) {
    return { error: 'quota_exhausted' as const };
  }
  async status() {
    return { state: 'failed' as const, error: 'quota_exhausted' as const };
  }
  async fetchOutput() {
    return { error: 'quota_exhausted' as const };
  }
  async cancel() {}
}

function setup(options: { provider?: ConceptProvider; video?: VideoGenerationProvider | null; mode?: 'account_growth' | 'affiliate_ugc' } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-studio-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const jobs = new GenerationStore(meta);
  const library = new VideoLibrary(userData);
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const bundle = bundles.create({ displayName: 'Synthetic Ternak 01', mode: options.mode ?? 'account_growth' }, [], new ProfileStore(meta));
  let studio: PromptStudioService | null = null;
  const generation = new GenerationService({
    bundles,
    jobs,
    library,
    log,
    provider: options.video === undefined ? new SyntheticVideoProvider() : options.video,
    unavailableReason: options.video === null ? 'not enabled' : null,
    dailyCap: 3,
    pollIntervalMs: 5,
    timeoutMs: 2000,
    ensureNetworkReady: async () => undefined,
    onJobEnded: (job) => studio!.jobEnded(job),
  });
  studio = new PromptStudioService({
    meta,
    bundles,
    jobs,
    generation,
    provider: options.provider ?? new TemplateProvider(),
    log,
    userData,
    sensitiveValues: () => bundles.list().flatMap((b) => [b.id, b.displayName]),
    now: () => NOW,
  });
  return { userData, bundles, jobs, library, generation, studio, bundle, lines };
}

const code = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof StudioError ? e.code : String((e as { code?: string }).code ?? e);
  }
  return undefined;
};

describe('prompt studio (SQLite, synthetic)', () => {
  it('generates 10 distinct draft prompts from a starter, with a batch snapshot; nothing creative is logged', async () => {
    const { studio, bundle, lines } = setup();
    const batch = await studio.generate(bundle.id, 'builtin-asmr');
    expect(batch).toMatchObject({ templateKey: 'builtin-asmr', templateVersion: 1, requested: 10, shortfall: null, providerId: 'template' });
    expect(batch.items).toHaveLength(10);
    expect(new Set(batch.items.map((i) => i.rendered)).size).toBe(10);
    expect(batch.items.every((i) => i.status === 'draft' && i.flags.length === 0)).toBe(true);
    const view = studio.view(bundle.id);
    expect(view.counts).toMatchObject({ draft: 10, approved: 0, queued: 0, generating: 0, video_ready: 0 });
    const logs = lines.join('\n');
    expect(logs).toContain('prompt_batch_generated');
    expect(logs).not.toMatch(/brushed-silver|soap|honey|Synthetic Ternak/);
  });

  it('refuses Affiliate accounts (factories stay separate)', async () => {
    const { studio, bundle } = setup({ mode: 'affiliate_ugc' });
    expect(await code(() => studio.view(bundle.id))).toBe('not_growth_account');
    expect(await code(() => studio.generate(bundle.id, 'builtin-asmr'))).toBe('not_growth_account');
  });

  it('a second batch avoids the first batch’s combinations', async () => {
    const { studio, bundle } = setup();
    const a = await studio.generate(bundle.id, 'builtin-asmr');
    const b = await studio.generate(bundle.id, 'builtin-asmr');
    const key = (x: { axes: Record<string, string> }) => JSON.stringify(x.axes);
    expect(b.items.some((i) => a.items.map(key).includes(key(i)))).toBe(false);
  });

  it('edits return a prompt to draft; removing the character blocks approval until fixed', async () => {
    const { studio, bundle } = setup();
    const [first] = (await studio.generate(bundle.id, 'builtin-grandma')).items;
    studio.act(bundle.id, first!.id, 'approve');
    const edited = first!.content.sections.map((s) => ({ key: s.key, text: s.key === 'scene' ? 'A grandmother talks.' : s.text }));
    studio.updateItem(bundle.id, first!.id, { sections: edited, caption: 'New caption #pesannenek' });
    let item = studio.view(bundle.id).batches[0]!.items[0]!;
    expect(item).toMatchObject({ status: 'draft', edited: true, flags: ['consistency_missing'], content: { caption: 'New caption #pesannenek' } });
    expect(await code(() => studio.act(bundle.id, first!.id, 'approve'))).toBe('prompt_blocked');
    expect(await code(() => studio.updateItem(bundle.id, first!.id, { sections: edited.slice(1), caption: 'x' }))).toBe('invalid_prompt_edit');
    await studio.regenerate(bundle.id, first!.id);
    item = studio.view(bundle.id).batches[0]!.items[0]!;
    expect(item).toMatchObject({ status: 'draft', edited: false, flags: [] });
    studio.act(bundle.id, first!.id, 'approve');
  });

  it('regenerating gives a variation different from the rest of the batch', async () => {
    const { studio, bundle } = setup();
    const batch = await studio.generate(bundle.id, 'builtin-dance');
    const target = batch.items[3]!;
    await studio.regenerate(bundle.id, target.id);
    const after = studio.view(bundle.id).batches[0]!.items;
    const changed = after.find((i) => i.id === target.id)!;
    expect(changed.rendered).not.toBe(target.rendered);
    expect(after.filter((i) => i.id !== target.id).some((i) => JSON.stringify(i.axes) === JSON.stringify(changed.axes))).toBe(false);
  });

  it('prompt approval and production are separate statuses; only a real video makes a prompt "video ready"', async () => {
    const { studio, bundle, jobs } = setup();
    const [a, b] = (await studio.generate(bundle.id, 'builtin-asmr')).items;
    expect(await code(() => studio.act(bundle.id, a!.id, 'queue'))).toBe('prompt_action_not_allowed');
    studio.act(bundle.id, a!.id, 'approve');
    expect(await code(() => studio.act(bundle.id, a!.id, 'start_manual'))).toBe('prompt_action_not_allowed');
    expect(await code(() => studio.generateVideo(bundle.id, a!.id))).toBe('prompt_action_not_allowed');
    studio.act(bundle.id, a!.id, 'queue');
    studio.act(bundle.id, a!.id, 'start_manual');
    expect(studio.view(bundle.id).counts).toMatchObject({ generating: 1, video_ready: 0 });

    // Manual Flow download: the download handler claims the waiting prompt; a failed download keeps it waiting.
    expect(studio.claimManualPrompt(bundle.id)).toBe(a!.id);
    const failed = jobs.create({ bundleId: bundle.id, source: 'manual_download', providerId: 'google-flow-manual', settings: null, promptItemId: a!.id });
    jobs.transition(failed.id, 'running');
    studio.jobEnded(jobs.transition(failed.id, 'failed', { errorCode: 'cancelled' }));
    expect(studio.view(bundle.id).batches[0]!.items[0]).toMatchObject({ status: 'generating', lastError: 'manual_download_failed' });
    const job = jobs.create({ bundleId: bundle.id, source: 'manual_download', providerId: 'google-flow-manual', settings: null, promptItemId: studio.claimManualPrompt(bundle.id) });
    jobs.transition(job.id, 'running');
    expect(studio.claimManualPrompt(bundle.id)).toBeNull(); // already being downloaded
    studio.jobEnded(jobs.transition(job.id, 'completed', { video: { file: `library/${bundle.id}/${job.id}.mp4`, bytes: 10, sha256: 'a'.repeat(64) } }));
    expect(studio.view(bundle.id).batches[0]!.items[0]).toMatchObject({ status: 'video_ready', video: { jobId: job.id } });

    // A download without a waiting prompt stays unlinked (manual downloads keep working) and can be linked by hand.
    const loose = jobs.create({ bundleId: bundle.id, source: 'manual_download', providerId: 'google-flow-manual', settings: null, promptItemId: studio.claimManualPrompt(bundle.id) });
    expect(loose.promptItemId).toBeNull();
    jobs.transition(loose.id, 'running');
    jobs.transition(loose.id, 'completed', { video: { file: `library/${bundle.id}/${loose.id}.mp4`, bytes: 10, sha256: 'b'.repeat(64) } });
    expect(studio.view(bundle.id).unlinkedVideos.map((v) => v.jobId)).toEqual([loose.id]);
    expect(await code(() => studio.linkVideo(bundle.id, b!.id, loose.id))).toBe('prompt_action_not_allowed'); // b is only a draft
    studio.act(bundle.id, b!.id, 'approve');
    studio.act(bundle.id, b!.id, 'queue');
    studio.linkVideo(bundle.id, b!.id, loose.id);
    expect(jobs.get(loose.id)!.promptItemId).toBe(b!.id);
    expect(await code(() => studio.linkVideo(bundle.id, b!.id, loose.id))).toBe('prompt_action_not_allowed');
    expect(studio.view(bundle.id).counts.video_ready).toBe(2);
  });

  it('a queued prompt generated with the (synthetic) provider ends video ready, linked both ways', async () => {
    const { studio, bundle, generation, jobs, userData } = setup();
    const [a] = (await studio.generate(bundle.id, 'builtin-asmr')).items;
    studio.act(bundle.id, a!.id, 'approve');
    studio.act(bundle.id, a!.id, 'queue');
    const job = studio.generateVideo(bundle.id, a!.id);
    expect(studio.view(bundle.id).batches[0]!.items[0]).toMatchObject({ status: 'generating', handoff: 'provider', jobId: job.id });
    expect(await code(() => studio.act(bundle.id, a!.id, 'back_to_queue'))).toBe('prompt_action_not_allowed');
    await generation.idle();
    const item = studio.view(bundle.id).batches[0]!.items[0]!;
    expect(item).toMatchObject({ status: 'video_ready', video: { jobId: job.id } });
    expect(jobs.get(job.id)!.promptItemId).toBe(a!.id);
    expect(existsSync(join(userData, ...item.video!.file.split('/')))).toBe(true);
  });

  it('a failed provider job returns the prompt to the queue with the reason', async () => {
    const { studio, bundle, generation } = setup({ video: new FailingVideoProvider() });
    const [a] = (await studio.generate(bundle.id, 'builtin-asmr')).items;
    studio.act(bundle.id, a!.id, 'approve');
    studio.act(bundle.id, a!.id, 'queue');
    studio.generateVideo(bundle.id, a!.id);
    await generation.idle();
    expect(studio.view(bundle.id).batches[0]!.items[0]).toMatchObject({ status: 'queued', handoff: null, lastError: 'quota_exhausted' });
  });

  it('without a video provider, queued prompts are produced by hand only', async () => {
    const { studio, bundle } = setup({ video: null });
    const [a] = (await studio.generate(bundle.id, 'builtin-asmr')).items;
    studio.act(bundle.id, a!.id, 'approve');
    studio.act(bundle.id, a!.id, 'queue');
    expect(studio.view(bundle.id).videoProvider).toMatchObject({ available: false });
    expect(await code(() => studio.generateVideo(bundle.id, a!.id))).toBe('no_provider');
    expect(studio.copyText(bundle.id, a!.id)).toContain('Scene: ');
  });

  it('custom master templates: duplicate, edit as new versions, starters read-only; batches keep their version', async () => {
    const { studio, bundle } = setup();
    const copy = studio.duplicateTemplate('builtin-grandma');
    expect(copy).toMatchObject({ version: 1, builtin: false, name: 'Grandma Messages (copy)', family: 'grandma' });
    expect(copy.key).toMatch(/^custom-/);
    expect(await code(() => studio.saveTemplate({ ...GRANDMA_TEMPLATE, name: 'x' }, 'builtin-grandma'))).toBe('builtin_read_only');
    expect(await code(() => studio.saveTemplate({ ...copy, sections: [{ key: 's', title: 'S', text: '{{nope}}' }] }, copy.key))).toBe('invalid_template');
    const v1Batch = await studio.generate(bundle.id, copy.key);
    const v2 = studio.saveTemplate({ ...copy, name: 'Nenek Ratna v2', sections: [...copy.sections, { key: 'extra', title: 'Extra', text: 'Keep her glasses on throughout. {{moment}}' }] }, copy.key);
    expect(v2).toMatchObject({ key: copy.key, version: 2, name: 'Nenek Ratna v2' });
    expect(studio.templates().find((t) => t.template.key === copy.key)).toMatchObject({ versions: 2, template: { version: 2 } });
    const v2Batch = await studio.generate(bundle.id, copy.key);
    expect(v2Batch.templateVersion).toBe(2);
    expect(v2Batch.items[0]!.rendered).toContain('Extra: Keep her glasses on throughout.');
    expect(studio.view(bundle.id).batches.find((b) => b.id === v1Batch.id)).toMatchObject({ templateVersion: 1 });
    expect(studio.templates().filter((t) => t.template.builtin)).toHaveLength(3);
  });

  it('per-account configuration: character text, pools and count are used; invalid settings are refused', async () => {
    const { studio, bundle } = setup();
    const base = studio.config(bundle.id, 'builtin-asmr').config;
    expect(await code(() => studio.saveConfig(bundle.id, 'builtin-asmr', { ...base, count: 0 }))).toBe('invalid_template_config');
    const hands = 'Synthetic hands: long fingers, a jade bracelet on the left wrist, short clear nails.';
    studio.saveConfig(bundle.id, 'builtin-asmr', { ...base, values: { ...base.values, hands }, count: 4, pools: { ...base.pools, mood: ['one quiet mood'] } });
    const batch = await studio.generate(bundle.id, 'builtin-asmr');
    expect(batch.items).toHaveLength(4);
    expect(batch.items.every((i) => i.rendered.includes(hands) && i.rendered.includes('Mood: one quiet mood.'))).toBe(true);
    // Too few combinations: fewer prompts, reported, never duplicates.
    studio.saveConfig(bundle.id, 'builtin-asmr', { ...base, count: 10, pools: { trigger: ['a', 'b'], camera: ['c'], mood: ['d'] } });
    const small = await studio.generate(bundle.id, 'builtin-asmr');
    expect(small).toMatchObject({ shortfall: 'variation_space_exhausted' });
    expect(small.items).toHaveLength(2);
  });

  it('reusable character/world presets', () => {
    const { studio, bundle } = setup();
    studio.savePreset('character', 'Nenek Ratna', 'An original grandmother, synthetic test text.');
    studio.savePreset('character', 'Nenek Ratna', 'Updated text.');
    expect(() => studio.savePreset('villain', 'x', 'y')).toThrow(StudioError);
    const [p] = studio.view(bundle.id).presets;
    expect(p).toMatchObject({ kind: 'character', name: 'Nenek Ratna', text: 'Updated text.' });
    studio.deletePreset(p!.id);
    expect(studio.presets()).toHaveLength(0);
  });

  it('reference files: rights required, content checked, kept locally, associated with prompts, manual action marked', async () => {
    const { studio, bundle, userData } = setup();
    const dir = mkdtempSync(join(tmpdir(), 'ugc-ref-'));
    const png = join(dir, 'nenek.png');
    const mp4 = join(dir, 'moves.mp4');
    const fake = join(dir, 'fake.png');
    writeFileSync(png, PNG);
    writeFileSync(mp4, MP4);
    writeFileSync(fake, 'not an image at all');
    expect(await code(() => studio.addReference(bundle.id, png, false))).toBe('rights_not_confirmed');
    expect(await code(() => studio.addReference(bundle.id, fake, true))).toBe('invalid_reference_file');
    expect(await code(() => studio.addReference(bundle.id, join(dir, 'x.gif'), true))).toBe('invalid_reference_file');
    const image = await studio.addReference(bundle.id, png, true);
    const video = await studio.addReference(bundle.id, mp4, true);
    expect(existsSync(join(userData, ...image.file.split('/')))).toBe(true);
    // Kinds must match the template.
    const dance = studio.config(bundle.id, 'builtin-dance').config;
    expect(await code(() => studio.saveConfig(bundle.id, 'builtin-dance', { ...dance, referenceAssetIds: [image.id] }))).toBe('invalid_template_config');
    studio.saveConfig(bundle.id, 'builtin-dance', { ...dance, count: 2, referenceAssetIds: [video.id] });
    const batch = await studio.generate(bundle.id, 'builtin-dance');
    expect(batch.items[0]!.references).toEqual([{ id: video.id, name: 'moves.mp4', kind: 'video', available: true }]);
    expect(batch.items[0]!.manualSteps[0]).toContain('no verified control');
    await studio.removeReference(bundle.id, video.id);
    expect(studio.view(bundle.id).batches[0]!.items[0]!.references[0]!.available).toBe(false);
  });

  it('remote providers: account details never leave; bad output stores nothing', async () => {
    const recording = new RecordingProvider();
    const { studio, bundle } = setup({ provider: recording });
    await studio.generate(bundle.id, 'builtin-asmr');
    const sent = JSON.stringify(recording.requests);
    expect(sent).not.toContain(bundle.id);
    expect(sent).not.toContain('Synthetic Ternak 01');
    // The owner accidentally puts the account name in the world text: refused before sending.
    const base = studio.config(bundle.id, 'builtin-asmr').config;
    studio.saveConfig(bundle.id, 'builtin-asmr', { ...base, values: { ...base.values, world: 'The studio of Synthetic Ternak 01.' } });
    const before = recording.requests.length;
    expect(await code(() => studio.generate(bundle.id, 'builtin-asmr'))).toBe('unsafe_payload');
    expect(recording.requests.length).toBe(before);

    for (const mode of ['malformed', 'refuse'] as const) {
      const env = setup({ provider: new RecordingProvider(undefined, mode) });
      expect(await code(() => env.studio.generate(env.bundle.id, 'builtin-asmr'))).toBe('concept_provider_failed');
      expect(env.studio.view(env.bundle.id).batches).toHaveLength(0);
    }
  });

  it('after a restart, prompts whose provider job ended are resolved', async () => {
    const { studio, bundle, generation } = setup();
    const [a] = (await studio.generate(bundle.id, 'builtin-asmr')).items;
    studio.act(bundle.id, a!.id, 'approve');
    studio.act(bundle.id, a!.id, 'queue');
    studio.generateVideo(bundle.id, a!.id);
    await generation.idle();
    studio.reconcile();
    expect(studio.view(bundle.id).batches[0]!.items[0]!.status).toBe('video_ready');
  });

  it('starter templates used as-is need no setup', () => {
    const { studio, bundle } = setup();
    const view = studio.view(bundle.id);
    expect(view.templates.map((t) => t.template.key)).toEqual(['builtin-asmr', 'builtin-grandma', 'builtin-dance']);
    expect(view.configs['builtin-asmr']).toMatchObject({ saved: false, config: { count: 10 } });
    expect(view.conceptProvider).toMatchObject({ kind: 'deterministic', remote: false });
    expect(ASMR_TEMPLATE.video.aspectRatio).toBe('9:16');
  });
});
