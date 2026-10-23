import type { SessionStatus } from '../session/status.js';

/**
 * Account Bundle: one operational TikTok account with its own dedicated proxy
 * and one isolated session per platform (Gate 3). Platform-neutral, so the
 * future Linux worker shares the same model.
 */

/**
 * affiliate_ugc and account_growth are the two factories. flow_pool is a
 * Flow-only Google account that supplies generation credits to either
 * factory (F0): its own proxy and one Google Flow session, no TikTok.
 */
export type ProductionMode = 'affiliate_ugc' | 'account_growth' | 'flow_pool';
export const PRODUCTION_MODES: readonly ProductionMode[] = ['affiliate_ugc', 'account_growth', 'flow_pool'];

/** Platforms each bundle gets a session for. `optional` sessions don't count against readiness. */
export const BUNDLE_PLATFORMS = [
  { id: 'tiktok', optional: false },
  { id: 'google-flow', optional: false },
  { id: 'kalodata', optional: true },
  { id: 'shopee', optional: true },
] as const;
export type BundlePlatformId = (typeof BUNDLE_PLATFORMS)[number]['id'];

/** The sessions a bundle of this mode gets: a Flow pool account has only Google Flow. */
export const platformsForMode = (mode: ProductionMode): ReadonlyArray<{ readonly id: BundlePlatformId; readonly optional: boolean }> =>
  mode === 'flow_pool' ? BUNDLE_PLATFORMS.filter((p) => p.id === 'google-flow') : BUNDLE_PLATFORMS;

/**
 * - draft: the proxy is missing or has never passed Test Proxy; no external website can be opened.
 * - proxy_check_needed: the proxy passed before but must pass again (after a restart).
 * - operational: the proxy passed in this run; browsing allowed.
 * - attention: the proxy failed, or a configured session expired, was rejected or can't be restored.
 */
export type BundleStatus = 'draft' | 'proxy_check_needed' | 'operational' | 'attention';

export type AccountIssue = 'invalid_display_name' | 'invalid_mode';

const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateAccountInput(raw: { displayName: unknown; mode: unknown }):
  | { ok: true; value: { displayName: string; mode: ProductionMode } }
  | { ok: false; issues: AccountIssue[] } {
  const issues: AccountIssue[] = [];
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  if (displayName.length === 0 || displayName.length > 64 || CONTROL.test(displayName)) issues.push('invalid_display_name');
  const mode = PRODUCTION_MODES.find((m) => m === raw.mode);
  if (!mode) issues.push('invalid_mode');
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { displayName, mode: mode! } };
}

const PROBLEM_STATUSES: ReadonlySet<SessionStatus> = new Set(['expired', 'rejected', 'locked_unavailable']);

export function bundleStatus(
  proxy: { status: 'untested' | 'ok' | 'failed'; lastPassedAt: string | null } | null,
  sessions: ReadonlyArray<{ status: SessionStatus }>,
): BundleStatus {
  if (!proxy) return 'draft';
  if (proxy.status === 'failed') return 'attention';
  if (proxy.status === 'ok') return sessions.some((s) => PROBLEM_STATUSES.has(s.status)) ? 'attention' : 'operational';
  return proxy.lastPassedAt ? 'proxy_check_needed' : 'draft';
}
