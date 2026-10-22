import { needsUser, type GenerationErrorCode, type Logger, type VideoGenerationProvider, type VideoSettings } from '@ugc/core';
import type { GenerationJob, GenerationStore } from './generation-store.js';
import type { VideoLibrary } from './library.js';
import type { BundleStore } from './profiles.js';

/**
 * Runs one generation job for one Account Growth bundle: saved creative
 * settings → provider → progress → MP4 into the bundle's library → outcome.
 * No queue, no bulk, no schedule and no automatic retry: a failed or blocked
 * job is final, and anything that needs the owner (challenge, sign-in, quota,
 * rate limit, changed interface) ends in waiting_for_user.
 * Logs carry ids, states and codes only; never the prompt or provider text.
 */

export class GenerationError extends Error {
  constructor(readonly code: 'not_growth_account' | 'no_creative_settings' | 'no_provider' | 'job_in_progress' | 'daily_cap_reached') {
    super(code);
  }
}

export interface GenerationServiceDeps {
  readonly bundles: BundleStore;
  readonly jobs: GenerationStore;
  readonly library: VideoLibrary;
  readonly log: Logger;
  /** The provider this run may use, or null (real Flow automation is not approved yet). */
  readonly provider: VideoGenerationProvider | null;
  /** Why there is no provider, for the UI. */
  readonly unavailableReason: string | null;
  readonly dailyCap: number;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  /** Must not resolve until the bundle may reach the network (proxy passed). Browser/API providers only. */
  readonly ensureNetworkReady: (bundleId: string) => Promise<void>;
  /** Called once when a job reaches a final state (e.g. to update its source prompt). */
  readonly onJobEnded?: (job: GenerationJob) => void;
}

/** A job started from an approved, queued Prompt Studio item instead of the saved creative settings. */
export interface PromptSource {
  readonly promptItemId: string;
  readonly prompt: string;
  readonly settings: VideoSettings;
}

export class GenerationService {
  readonly #deps: GenerationServiceDeps;
  readonly #running = new Map<string, Promise<void>>();

  constructor(deps: GenerationServiceDeps) {
    this.#deps = deps;
  }

  get provider(): VideoGenerationProvider | null {
    return this.#deps.provider;
  }

  get unavailableReason(): string | null {
    return this.#deps.unavailableReason;
  }

  get dailyCap(): number {
    return this.#deps.dailyCap;
  }

  /** After a restart, jobs that were mid-flight are closed as failed (never resumed or retried). */
  reconcile(): void {
    for (const job of this.#deps.jobs.listAll()) {
      if (job.state === 'pending' || job.state === 'running') {
        this.#deps.jobs.transition(job.id, 'failed', { errorCode: 'transient', code: 'interrupted_by_restart' });
        this.#deps.log.warn('generation_job_interrupted', { jobId: job.id, bundleId: job.bundleId });
      }
    }
  }

  /** Starts one job and returns it at once; it runs in the background. */
  start(bundleId: string, source?: PromptSource): GenerationJob {
    const { bundles, jobs, provider, dailyCap } = this.#deps;
    const bundle = bundles.get(bundleId);
    if (!bundle || bundle.mode !== 'account_growth') throw new GenerationError('not_growth_account');
    const creative = source ? { prompt: source.prompt, settings: source.settings } : jobs.getCreative(bundleId);
    if (!creative) throw new GenerationError('no_creative_settings');
    if (!provider) throw new GenerationError('no_provider');
    if (jobs.list(bundleId, 50).some((j) => j.state === 'pending' || j.state === 'running')) throw new GenerationError('job_in_progress');
    if (jobs.countToday(bundleId) >= dailyCap) throw new GenerationError('daily_cap_reached');

    const job = jobs.create({ bundleId, source: 'provider', providerId: provider.id, settings: creative.settings, promptItemId: source?.promptItemId ?? null });
    this.#deps.log.info('generation_job_created', { jobId: job.id, bundleId, provider: provider.id });
    const run = this.#run(job, provider, creative.prompt).finally(() => this.#running.delete(job.id));
    this.#running.set(job.id, run);
    return job;
  }

  /** For tests and shutdown: resolves when every running job has finished. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }

  async #run(job: GenerationJob, provider: VideoGenerationProvider, prompt: string): Promise<void> {
    const { jobs, library, log, pollIntervalMs, timeoutMs } = this.#deps;
    const end = (to: 'completed' | 'waiting_for_user' | 'failed', patch: Parameters<GenerationStore['transition']>[2] = {}): void => {
      const done = jobs.transition(job.id, to, patch);
      log.info('generation_job_state', { jobId: job.id, bundleId: job.bundleId, state: done.state, error: done.errorCode, needsUser: done.needsUser });
      this.#ended(done);
    };
    const fail = (error: GenerationErrorCode): void =>
      needsUser(error) ? end('waiting_for_user', { errorCode: error, needsUser: true }) : end('failed', { errorCode: error });

    try {
      if (provider.kind !== 'synthetic') await this.#deps.ensureNetworkReady(job.bundleId);
      jobs.transition(job.id, 'running');
      const submitted = await provider.submit({ bundleId: job.bundleId, prompt, settings: job.settings! });
      if ('error' in submitted) return fail(submitted.error);

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Date.now() > deadline) {
          await provider.cancel(submitted.providerJobId).catch(() => undefined);
          return fail('transient');
        }
        const status = await provider.status(submitted.providerJobId);
        if (status.state === 'failed') return fail(status.error);
        if (status.state === 'succeeded') break;
        jobs.setProgress(job.id, status.progress);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      const output = await provider.fetchOutput(submitted.providerJobId);
      if ('error' in output) return fail(output.error);
      let video;
      try {
        video = library.save(job.bundleId, job.id, output.bytes);
      } catch {
        return fail('output_invalid');
      }
      end('completed', { video });
    } catch (err) {
      log.error('generation_job_error', { jobId: job.id, err });
      const current = jobs.get(job.id);
      if (current && (current.state === 'pending' || current.state === 'running')) {
        this.#ended(jobs.transition(job.id, 'failed', { errorCode: 'transient', code: 'internal_error' }));
      }
    }
  }

  #ended(job: GenerationJob): void {
    try {
      this.#deps.onJobEnded?.(job);
    } catch (err) {
      this.#deps.log.error('generation_job_hook_error', { jobId: job.id, err });
    }
  }
}
