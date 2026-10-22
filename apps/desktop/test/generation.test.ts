import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type GenerationRequest, type VideoGenerationProvider } from '@ugc/core';
import { GenerationError, GenerationService } from '../src/main/generation.js';
import { GenerationStore } from '../src/main/generation-store.js';
import { VideoLibrary } from '../src/main/library.js';
import { BundleStore, MetadataDb, ProfileStore } from '../src/main/profiles.js';
import { SyntheticVideoProvider } from '../src/main/synthetic-provider.js';

const settings = { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' } as const;

function setup(options: { provider?: VideoGenerationProvider | null; dailyCap?: number; mode?: 'account_growth' | 'affiliate_ugc' } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-gen-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const jobs = new GenerationStore(meta);
  const library = new VideoLibrary(userData);
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const bundle = bundles.create({ displayName: 'Growth 01', mode: options.mode ?? 'account_growth' }, [], new ProfileStore(meta));
  const service = new GenerationService({
    bundles,
    jobs,
    library,
    log,
    provider: options.provider === undefined ? new SyntheticVideoProvider() : options.provider,
    unavailableReason: options.provider === null ? 'not enabled' : null,
    dailyCap: options.dailyCap ?? 3,
    pollIntervalMs: 5,
    timeoutMs: 2000,
    ensureNetworkReady: async () => undefined,
  });
  return { userData, bundles, jobs, library, service, bundle, lines };
}

async function runOnce(prompt: string) {
  const env = setup();
  env.jobs.saveCreative(env.bundle.id, { prompt, settings });
  const job = env.service.start(env.bundle.id);
  await env.service.idle();
  return { ...env, job: env.jobs.get(job.id)! };
}

describe('generation service (synthetic provider)', () => {
  it('runs one job to completion and stores a validated MP4 in the account library', async () => {
    const { job, jobs, userData, bundle, lines } = await runOnce('A tidy kitchen, morning light');
    expect(job).toMatchObject({ state: 'completed', errorCode: null, needsUser: false, progress: 1, source: 'provider', providerId: 'synthetic' });
    expect(job.videoFile).toBe(`library/${bundle.id}/${job.id}.mp4`);
    const bytes = readFileSync(join(userData, ...job.videoFile!.split('/')));
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(job.videoBytes).toBe(bytes.length);
    expect(job.videoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(jobs.events(job.id).map((e) => e.to)).toEqual(['pending', 'running', 'completed']);
    // The prompt is the owner's content: never logged.
    expect(lines.join('\n')).not.toContain('tidy kitchen');
  });

  it.each([
    ['challenge_required', 'waiting_for_user', true],
    ['auth_required', 'waiting_for_user', true],
    ['quota_exhausted', 'waiting_for_user', true],
    ['rate_limited', 'waiting_for_user', true],
    ['interface_changed', 'waiting_for_user', true],
    ['policy_rejected', 'failed', false],
  ])('%s at submission → %s', async (scenario, state, user) => {
    const { job } = await runOnce(`test [synthetic:${scenario}]`);
    expect(job).toMatchObject({ state, errorCode: scenario, needsUser: user, videoFile: null });
  });

  it('a failure midway and an invalid output are final, with nothing saved', async () => {
    const midway = await runOnce('x [synthetic:fail_midway]');
    expect(midway.job).toMatchObject({ state: 'failed', errorCode: 'transient', videoFile: null });
    const invalid = await runOnce('x [synthetic:invalid_output]');
    expect(invalid.job).toMatchObject({ state: 'failed', errorCode: 'output_invalid', videoFile: null });
    expect(existsSync(join(invalid.userData, 'library', invalid.bundle.id, `${invalid.job.id}.mp4`))).toBe(false);
  });

  it('a stuck job times out and is cancelled at the provider', async () => {
    const { job } = await runOnce('x [synthetic:slow]');
    expect(job).toMatchObject({ state: 'failed', errorCode: 'transient' });
  });

  it('never retries: the provider is asked exactly once per job', async () => {
    const inner = new SyntheticVideoProvider();
    let submits = 0;
    const counting: VideoGenerationProvider = {
      id: inner.id,
      displayName: inner.displayName,
      kind: inner.kind,
      submit: (r: GenerationRequest) => {
        submits++;
        return inner.submit(r);
      },
      status: (id) => inner.status(id),
      fetchOutput: (id) => inner.fetchOutput(id),
      cancel: (id) => inner.cancel(id),
    };
    const env = setup({ provider: counting });
    env.jobs.saveCreative(env.bundle.id, { prompt: 'x [synthetic:fail_midway]', settings });
    env.service.start(env.bundle.id);
    await env.service.idle();
    expect(submits).toBe(1);
  });

  it('enforces the boundaries: growth accounts only, saved settings, a provider, one job at a time, the daily cap', async () => {
    const affiliate = setup({ mode: 'affiliate_ugc' });
    expect(() => affiliate.service.start(affiliate.bundle.id)).toThrow(new GenerationError('not_growth_account'));

    const env = setup({ dailyCap: 2 });
    expect(() => env.service.start(env.bundle.id)).toThrow(new GenerationError('no_creative_settings'));
    env.jobs.saveCreative(env.bundle.id, { prompt: 'p', settings });
    env.service.start(env.bundle.id);
    expect(() => env.service.start(env.bundle.id)).toThrow(new GenerationError('job_in_progress'));
    await env.service.idle();
    env.service.start(env.bundle.id);
    await env.service.idle();
    expect(() => env.service.start(env.bundle.id)).toThrow(new GenerationError('daily_cap_reached'));

    const none = setup({ provider: null });
    none.jobs.saveCreative(none.bundle.id, { prompt: 'p', settings });
    expect(() => none.service.start(none.bundle.id)).toThrow(new GenerationError('no_provider'));
  });

  it('after a restart, interrupted jobs are closed as failed, never resumed', () => {
    const env = setup();
    const job = env.jobs.create({ bundleId: env.bundle.id, source: 'provider', providerId: 'synthetic', settings });
    env.jobs.transition(job.id, 'running');
    env.service.reconcile();
    expect(env.jobs.get(job.id)).toMatchObject({ state: 'failed', errorCode: 'transient' });
    expect(env.jobs.events(job.id).at(-1)).toMatchObject({ to: 'failed', code: 'interrupted_by_restart' });
  });
});

describe('video library', () => {
  it('rejects non-MP4 output and keeps files inside the library', () => {
    const lib = new VideoLibrary(mkdtempSync(join(tmpdir(), 'ugc-lib-')));
    const bundleId = '0f8b5a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(() => lib.save(bundleId, 'job', new TextEncoder().encode('<html>'))).toThrow('output_invalid');
    expect(() => lib.dirFor('../escape')).toThrow();
    expect(() => lib.absolute('../ugc.db')).toThrow();
  });
});
