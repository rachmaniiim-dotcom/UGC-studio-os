import { randomBytes, randomUUID } from 'node:crypto';
import type { GenerationErrorCode, GenerationRequest, ProviderStatus, VideoGenerationProvider } from '@ugc/core';

/**
 * Synthetic video provider for automated tests (synthetic runs only). It never
 * touches the network. A test picks an outcome by putting a marker in the
 * prompt, e.g. "[synthetic:challenge_required]":
 *   success (default) · challenge_required · auth_required · quota_exhausted ·
 *   rate_limited · policy_rejected · interface_changed · fail_midway (transient) ·
 *   invalid_output · slow (stays running until cancelled or timed out)
 */

const SUBMIT_ERRORS = new Set<GenerationErrorCode>(['challenge_required', 'auth_required', 'quota_exhausted', 'rate_limited', 'policy_rejected', 'interface_changed']);

interface Job {
  scenario: string;
  polls: number;
  cancelled: boolean;
}

/** A tiny file that passes the MP4 check: an ftyp box followed by filler. */
export function syntheticMp4(payloadBytes = 64 * 1024): Uint8Array {
  const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
  return Buffer.concat([ftyp, randomBytes(payloadBytes)]);
}

export class SyntheticVideoProvider implements VideoGenerationProvider {
  readonly id = 'synthetic';
  readonly displayName = 'Synthetic test provider';
  readonly kind = 'synthetic' as const;
  readonly #jobs = new Map<string, Job>();

  async submit(request: GenerationRequest): Promise<{ providerJobId: string } | { error: GenerationErrorCode }> {
    const scenario = /\[synthetic:([a-z_]+)\]/.exec(request.prompt)?.[1] ?? 'success';
    if (SUBMIT_ERRORS.has(scenario as GenerationErrorCode)) return { error: scenario as GenerationErrorCode };
    const id = randomUUID();
    this.#jobs.set(id, { scenario, polls: 0, cancelled: false });
    return { providerJobId: id };
  }

  async status(providerJobId: string): Promise<ProviderStatus> {
    const job = this.#jobs.get(providerJobId);
    if (!job || job.cancelled) return { state: 'failed', error: 'cancelled' };
    job.polls += 1;
    if (job.scenario === 'slow') return { state: 'running', progress: null };
    if (job.scenario === 'fail_midway' && job.polls >= 2) return { state: 'failed', error: 'transient' };
    return job.polls >= 4 ? { state: 'succeeded' } : { state: 'running', progress: job.polls / 4 };
  }

  async fetchOutput(providerJobId: string): Promise<{ bytes: Uint8Array } | { error: GenerationErrorCode }> {
    const job = this.#jobs.get(providerJobId);
    if (!job) return { error: 'transient' };
    return { bytes: job.scenario === 'invalid_output' ? Buffer.from('<html>not a video</html>') : syntheticMp4() };
  }

  async cancel(providerJobId: string): Promise<void> {
    const job = this.#jobs.get(providerJobId);
    if (job) job.cancelled = true;
  }
}
