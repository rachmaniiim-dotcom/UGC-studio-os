import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '@ugc/core';
import type { GenerationJob } from './generation-store.js';
import type { BundleStore, MetadataDb } from './profiles.js';

/**
 * Flow accounts and credits (F0, extended in A2). A "Flow account" is any
 * Google Flow session that renders videos: a Flow pool account (mode
 * flow_pool) or an account's own Flow session. Credits are tracked against
 * the Flow account that produced each file, never against the TikTok account
 * that receives it. Credits are the app's estimate (allowance minus what was
 * downloaded through the app since the reset); Google Flow's own counter is
 * authoritative, so the owner can correct the balance. An optional daily
 * credit limit per Flow account pauses hand-offs once reached.
 */

export const DEFAULT_POOL_SETTINGS = { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12, dailyCreditLimit: null } as const;

export type PoolErrorCode = 'not_pool_account' | 'invalid_pool_settings' | 'invalid_credit_balance' | 'no_pool_account_available' | 'flow_budget_exhausted';

export class PoolError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface PoolSettings {
  readonly monthlyCredits: number;
  /** Day of the month the allowance renews (1–28). */
  readonly resetDay: number;
  /** Credits one downloaded clip uses (e.g. 12 for an 8-second Omni Flash clip). */
  readonly creditsPerDownload: number;
  /** Optional cap on credits used per day by this Flow account; null = no daily cap. */
  readonly dailyCreditLimit: number | null;
}

export interface PoolAccount {
  readonly id: string;
  readonly displayName: string;
  /** True for a dedicated Flow pool account; false for an account's own Flow session. */
  readonly pool: boolean;
  readonly settings: PoolSettings;
  readonly periodStart: string;
  readonly used: number;
  readonly remaining: number;
  readonly usedToday: number;
  readonly downloadsThisPeriod: number;
  /** A dedicated proxy is set (it must still pass Test Proxy before the Flow window opens). */
  readonly proxyConfigured: boolean;
  readonly flowSessionId: string | null;
}

export type BudgetCheck = { ok: true } | { ok: false; reason: 'monthly_credits_exhausted' | 'daily_credit_limit_reached' | 'no_flow_session' };

export class FlowPoolService {
  readonly #db: DatabaseSync;
  readonly #bundles: BundleStore;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #flowSessionOf: (bundleId: string) => string | null;

  constructor(meta: MetadataDb, bundles: BundleStore, log: Logger, flowSessionOf: (bundleId: string) => string | null, now: () => Date = () => new Date()) {
    if (!meta.db) throw new Error('flow pool needs a writable database');
    this.#db = meta.db;
    this.#bundles = bundles;
    this.#log = log;
    this.#flowSessionOf = flowSessionOf;
    this.#now = now;
  }

  isPool(bundleId: string): boolean {
    return this.#bundles.get(bundleId)?.mode === 'flow_pool';
  }

  /** Any account with a Google Flow session is a Flow account (pool or own). */
  #require(bundleId: string): void {
    if (!this.#bundles.get(bundleId) || (!this.isPool(bundleId) && !this.#flowSessionOf(bundleId))) throw new PoolError('not_pool_account');
  }

  settings(bundleId: string): PoolSettings {
    const row = this.#db.prepare('SELECT monthly_credits, reset_day, credits_per_download, daily_credit_limit FROM flow_pool_settings WHERE bundle_id = ?').get(bundleId) as
      | { monthly_credits: number; reset_day: number; credits_per_download: number; daily_credit_limit: number | null }
      | undefined;
    return row
      ? { monthlyCredits: row.monthly_credits, resetDay: row.reset_day, creditsPerDownload: row.credits_per_download, dailyCreditLimit: row.daily_credit_limit }
      : DEFAULT_POOL_SETTINGS;
  }

  saveSettings(bundleId: string, raw: unknown): void {
    this.#require(bundleId);
    const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const int = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
    const issues: string[] = [];
    if (!int(s['monthlyCredits'], 1, 1_000_000)) issues.push('invalid_monthly_credits');
    if (!int(s['resetDay'], 1, 28)) issues.push('invalid_reset_day');
    if (!int(s['creditsPerDownload'], 1, 10_000)) issues.push('invalid_credits_per_download');
    const daily = s['dailyCreditLimit'] ?? null;
    if (daily !== null && !int(daily, 1, 1_000_000)) issues.push('invalid_daily_credit_limit');
    if (issues.length > 0) throw new PoolError('invalid_pool_settings', issues);
    this.#db
      .prepare(
        `INSERT INTO flow_pool_settings (bundle_id, monthly_credits, reset_day, credits_per_download, daily_credit_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET monthly_credits = excluded.monthly_credits, reset_day = excluded.reset_day,
           credits_per_download = excluded.credits_per_download, daily_credit_limit = excluded.daily_credit_limit, updated_at = excluded.updated_at`,
      )
      .run(bundleId, s['monthlyCredits'] as number, s['resetDay'] as number, s['creditsPerDownload'] as number, daily as number | null, this.#now().toISOString());
  }

  /** Start of the current credit period: the most recent reset day at local midnight. */
  periodStart(resetDay: number): Date {
    const now = this.#now();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), resetDay);
    return thisMonth.getTime() <= now.getTime() ? thisMonth : new Date(now.getFullYear(), now.getMonth() - 1, resetDay);
  }

  #usage(bundleId: string, since: Date): { used: number; downloads: number } {
    return this.#db
      .prepare("SELECT COALESCE(SUM(credits), 0) AS used, COALESCE(SUM(reason = 'download'), 0) AS downloads FROM flow_credit_events WHERE pool_bundle_id = ? AND at >= ?")
      .get(bundleId, since.toISOString()) as { used: number; downloads: number };
  }

  #usedToday(bundleId: string): number {
    const now = this.#now();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return (
      this.#db.prepare("SELECT COALESCE(SUM(credits), 0) AS n FROM flow_credit_events WHERE pool_bundle_id = ? AND reason = 'download' AND at >= ?").get(bundleId, midnight.toISOString()) as {
        n: number;
      }
    ).n;
  }

  account(bundleId: string): PoolAccount {
    this.#require(bundleId);
    const bundle = this.#bundles.get(bundleId)!;
    const settings = this.settings(bundleId);
    const start = this.periodStart(settings.resetDay);
    const { used, downloads } = this.#usage(bundleId, start);
    return {
      id: bundleId,
      displayName: bundle.displayName,
      pool: bundle.mode === 'flow_pool',
      settings,
      periodStart: start.toISOString(),
      used,
      remaining: settings.monthlyCredits - used,
      usedToday: this.#usedToday(bundleId),
      downloadsThisPeriod: downloads,
      proxyConfigured: bundle.proxy !== null,
      flowSessionId: this.#flowSessionOf(bundleId),
    };
  }

  /** Dedicated Flow pool accounts. */
  list(): PoolAccount[] {
    return this.#bundles
      .list()
      .filter((b) => b.mode === 'flow_pool')
      .map((b) => this.account(b.id));
  }

  /** Accounts' own Flow sessions that have used credits or have settings (shown next to the pool). */
  others(): PoolAccount[] {
    const ids = new Set(
      (
        this.#db.prepare('SELECT pool_bundle_id AS id FROM flow_credit_events UNION SELECT bundle_id AS id FROM flow_pool_settings').all() as Array<{ id: string }>
      ).map((r) => r.id),
    );
    return this.#bundles
      .list()
      .filter((b) => b.mode !== 'flow_pool' && ids.has(b.id) && this.#flowSessionOf(b.id))
      .map((b) => this.account(b.id));
  }

  /** The owner corrects the balance to what Google Flow shows; recorded as an adjustment. */
  setRemaining(bundleId: string, remaining: unknown): void {
    this.#require(bundleId);
    const current = this.account(bundleId);
    if (!Number.isInteger(remaining) || (remaining as number) < 0 || (remaining as number) > current.settings.monthlyCredits * 10) throw new PoolError('invalid_credit_balance');
    const delta = current.remaining - (remaining as number);
    if (delta === 0) return;
    this.#db.prepare("INSERT INTO flow_credit_events (pool_bundle_id, at, credits, reason) VALUES (?, ?, ?, 'adjust')").run(bundleId, this.#now().toISOString(), delta);
  }

  /** Whether this Flow account may take one more clip now (monthly balance and optional daily cap). */
  canSpend(bundleId: string): BudgetCheck {
    if (!this.#flowSessionOf(bundleId)) return { ok: false, reason: 'no_flow_session' };
    const a = this.account(bundleId);
    if (a.remaining < a.settings.creditsPerDownload) return { ok: false, reason: 'monthly_credits_exhausted' };
    if (a.settings.dailyCreditLimit !== null && a.usedToday + a.settings.creditsPerDownload > a.settings.dailyCreditLimit) return { ok: false, reason: 'daily_credit_limit_reached' };
    return { ok: true };
  }

  /** A file downloaded in a Flow account's window uses that account's credits (once per job). Returns the credits counted. */
  recordDownload(job: GenerationJob): number {
    if (job.state !== 'completed' || !job.videoFile || !job.flowBundleId || !this.#bundles.get(job.flowBundleId)) return 0;
    const credits = this.settings(job.flowBundleId).creditsPerDownload;
    const r = this.#db
      .prepare("INSERT INTO flow_credit_events (pool_bundle_id, at, credits, reason, job_id) VALUES (?, ?, ?, 'download', ?) ON CONFLICT(job_id) DO NOTHING")
      .run(job.flowBundleId, this.#now().toISOString(), credits, job.id);
    if (r.changes > 0) this.#log.info('flow_credits_used', { flow: job.flowBundleId, jobId: job.id, credits });
    return credits;
  }

  /** The pool account to use next: proxy set, within its monthly and daily budget, most credits first. */
  pick(): PoolAccount {
    const best = this.list()
      .filter((a) => a.proxyConfigured && a.flowSessionId && this.canSpend(a.id).ok)
      .sort((a, b) => b.remaining - a.remaining)[0];
    if (!best) throw new PoolError('no_pool_account_available');
    return best;
  }
}
