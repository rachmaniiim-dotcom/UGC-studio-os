import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '@ugc/core';
import type { GenerationJob } from './generation-store.js';
import type { BundleStore, MetadataDb } from './profiles.js';

/**
 * Flow session pool (F0): Flow-only Google accounts (mode flow_pool), each
 * with its own proxy and Google Flow session, supplying generation credits to
 * either factory. Credits are the app's estimate (monthly allowance minus
 * what was used since the monthly reset); Google Flow's own counter is
 * authoritative, so the owner can correct the balance at any time.
 */

export const DEFAULT_POOL_SETTINGS = { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12 } as const;

export type PoolErrorCode = 'not_pool_account' | 'invalid_pool_settings' | 'invalid_credit_balance' | 'no_pool_account_available';

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
  /** Credits one downloaded video uses (e.g. 12 for an 8-second Omni Flash clip). */
  readonly creditsPerDownload: number;
}

export interface PoolAccount {
  readonly id: string;
  readonly displayName: string;
  readonly settings: PoolSettings;
  readonly periodStart: string;
  readonly used: number;
  readonly remaining: number;
  readonly downloadsThisPeriod: number;
  /** A dedicated proxy is set (it must still pass Test Proxy before the Flow window opens). */
  readonly proxyConfigured: boolean;
  readonly flowSessionId: string | null;
}

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

  #require(bundleId: string): void {
    if (!this.isPool(bundleId)) throw new PoolError('not_pool_account');
  }

  settings(bundleId: string): PoolSettings {
    const row = this.#db.prepare('SELECT monthly_credits, reset_day, credits_per_download FROM flow_pool_settings WHERE bundle_id = ?').get(bundleId) as
      | { monthly_credits: number; reset_day: number; credits_per_download: number }
      | undefined;
    return row ? { monthlyCredits: row.monthly_credits, resetDay: row.reset_day, creditsPerDownload: row.credits_per_download } : DEFAULT_POOL_SETTINGS;
  }

  saveSettings(bundleId: string, raw: unknown): void {
    this.#require(bundleId);
    const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const int = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
    const issues: string[] = [];
    if (!int(s['monthlyCredits'], 1, 1_000_000)) issues.push('invalid_monthly_credits');
    if (!int(s['resetDay'], 1, 28)) issues.push('invalid_reset_day');
    if (!int(s['creditsPerDownload'], 1, 10_000)) issues.push('invalid_credits_per_download');
    if (issues.length > 0) throw new PoolError('invalid_pool_settings', issues);
    this.#db
      .prepare(
        `INSERT INTO flow_pool_settings (bundle_id, monthly_credits, reset_day, credits_per_download, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET monthly_credits = excluded.monthly_credits, reset_day = excluded.reset_day,
           credits_per_download = excluded.credits_per_download, updated_at = excluded.updated_at`,
      )
      .run(bundleId, s['monthlyCredits'] as number, s['resetDay'] as number, s['creditsPerDownload'] as number, this.#now().toISOString());
  }

  /** Start of the current credit period: the most recent reset day at local midnight. */
  periodStart(resetDay: number): Date {
    const now = this.#now();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), resetDay);
    return thisMonth.getTime() <= now.getTime() ? thisMonth : new Date(now.getFullYear(), now.getMonth() - 1, resetDay);
  }

  #usage(bundleId: string, since: Date): { used: number; downloads: number } {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(credits), 0) AS used, COALESCE(SUM(reason = 'download'), 0) AS downloads FROM flow_credit_events WHERE pool_bundle_id = ? AND at >= ?")
      .get(bundleId, since.toISOString()) as { used: number; downloads: number };
    return row;
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
      settings,
      periodStart: start.toISOString(),
      used,
      remaining: settings.monthlyCredits - used,
      downloadsThisPeriod: downloads,
      proxyConfigured: bundle.proxy !== null,
      flowSessionId: this.#flowSessionOf(bundleId),
    };
  }

  list(): PoolAccount[] {
    return this.#bundles
      .list()
      .filter((b) => b.mode === 'flow_pool')
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

  /** A video downloaded in a pool account's Flow window uses that account's credits (once per job). */
  recordDownload(job: GenerationJob): void {
    if (job.state !== 'completed' || !job.videoFile || !job.flowBundleId || !this.isPool(job.flowBundleId)) return;
    const credits = this.settings(job.flowBundleId).creditsPerDownload;
    this.#db
      .prepare("INSERT INTO flow_credit_events (pool_bundle_id, at, credits, reason, job_id) VALUES (?, ?, ?, 'download', ?) ON CONFLICT(job_id) DO NOTHING")
      .run(job.flowBundleId, this.#now().toISOString(), credits, job.id);
    this.#log.info('flow_pool_credits_used', { pool: job.flowBundleId, jobId: job.id, credits });
  }

  /** The pool account to use next: proxy set, enough credits left for one video, most credits first. */
  pick(): PoolAccount {
    const best = this.list()
      .filter((a) => a.proxyConfigured && a.flowSessionId && a.remaining >= a.settings.creditsPerDownload)
      .sort((a, b) => b.remaining - a.remaining)[0];
    if (!best) throw new PoolError('no_pool_account_available');
    return best;
  }
}
