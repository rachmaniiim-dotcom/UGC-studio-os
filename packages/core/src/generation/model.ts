/**
 * Platform-independent video generation (Gate 4). A provider (synthetic now;
 * Google Flow only once its permitted use and feasibility are established)
 * sits behind one interface. Jobs are single tasks: no queue, no bulk, no
 * schedule, no automatic retry.
 */

export type AspectRatio = '9:16' | '16:9' | '1:1';
export type QualityTier = 'fast' | 'quality';

export interface VideoSettings {
  readonly aspectRatio: AspectRatio;
  readonly durationSeconds: number;
  readonly quality: QualityTier;
}

/** An account's saved creative brief. Not secret, but never logged (it's the owner's content). */
export interface CreativeSettings {
  readonly prompt: string;
  readonly settings: VideoSettings;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' };
export const MAX_PROMPT_CHARS = 4000;
const ASPECTS: readonly AspectRatio[] = ['9:16', '16:9', '1:1'];
const QUALITIES: readonly QualityTier[] = ['fast', 'quality'];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type CreativeIssue = 'invalid_prompt' | 'invalid_aspect_ratio' | 'invalid_duration' | 'invalid_quality';

export function validateCreativeInput(raw: { prompt: unknown; settings: unknown }):
  | { ok: true; value: CreativeSettings }
  | { ok: false; issues: CreativeIssue[] } {
  const issues: CreativeIssue[] = [];
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS || CONTROL.test(prompt)) issues.push('invalid_prompt');
  const s = (typeof raw.settings === 'object' && raw.settings !== null ? raw.settings : {}) as Record<string, unknown>;
  const aspectRatio = ASPECTS.find((a) => a === s['aspectRatio']);
  if (!aspectRatio) issues.push('invalid_aspect_ratio');
  const duration = s['durationSeconds'];
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 2 || duration > 30) issues.push('invalid_duration');
  const quality = QUALITIES.find((q) => q === s['quality']);
  if (!quality) issues.push('invalid_quality');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { prompt, settings: { aspectRatio: aspectRatio!, durationSeconds: duration as number, quality: quality! } } };
}

/** Normalized provider outcomes. None of them carries provider text, page content or the prompt. */
export type GenerationErrorCode =
  /** A CAPTCHA, verification, "unusual activity" or similar challenge appeared. Never solved by the app. */
  | 'challenge_required'
  /** Not signed in / session rejected. */
  | 'auth_required'
  /** Out of credits or daily limit. */
  | 'quota_exhausted'
  /** The provider asked to slow down. */
  | 'rate_limited'
  /** The provider refused the prompt or output on policy grounds. */
  | 'policy_rejected'
  /** The provider's interface no longer matches what the integration expects. */
  | 'interface_changed'
  /** Timed out or a transient error; not retried automatically. */
  | 'transient'
  /** The returned file is not an acceptable MP4. */
  | 'output_invalid'
  | 'cancelled';

/** Outcomes that need the owner to act before anything else is tried. */
const NEEDS_USER: ReadonlySet<GenerationErrorCode> = new Set(['challenge_required', 'auth_required', 'quota_exhausted', 'rate_limited', 'interface_changed']);
export const needsUser = (code: GenerationErrorCode): boolean => NEEDS_USER.has(code);

export interface GenerationRequest {
  readonly bundleId: string;
  readonly prompt: string;
  readonly settings: VideoSettings;
}

export type ProviderStatus =
  | { readonly state: 'running'; readonly progress: number | null }
  | { readonly state: 'succeeded' }
  | { readonly state: 'failed'; readonly error: GenerationErrorCode };

/** Gate 0 §20 port. Implementations: SyntheticVideoProvider (tests); FlowBrowserProvider later, only if approved. */
export interface VideoGenerationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'synthetic' | 'browser' | 'api';
  submit(request: GenerationRequest): Promise<{ providerJobId: string } | { error: GenerationErrorCode }>;
  status(providerJobId: string): Promise<ProviderStatus>;
  /** Returns the finished video's bytes (the caller validates and stores them). */
  fetchOutput(providerJobId: string): Promise<{ bytes: Uint8Array } | { error: GenerationErrorCode }>;
  cancel(providerJobId: string): Promise<void>;
}

export type JobState = 'pending' | 'running' | 'completed' | 'waiting_for_user' | 'failed';

const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  pending: ['running', 'failed', 'waiting_for_user'],
  running: ['completed', 'waiting_for_user', 'failed'],
  completed: [],
  waiting_for_user: [],
  failed: [],
};

/** Jobs only move forward; finished jobs never change (a new attempt is a new job). */
export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** True if `bytes` look like an MP4/ISO-BMFF file (an `ftyp` box first). */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const size = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  const type = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  return type === 'ftyp' && size >= 8 && size <= bytes.length;
}
