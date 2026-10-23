import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger, platformsForMode, TemplateProvider } from '@ugc/core';
import { configuredFlowSession, FlowPoolService, PoolError } from '../src/main/flow-pool.js';
import { GenerationStore } from '../src/main/generation-store.js';
import { BundleStore, MetadataDb, MIGRATIONS, ProfileStore, type ProxyState } from '../src/main/profiles.js';
import { PromptStudioService } from '../src/main/prompt-studio.js';

const PROXY: ProxyState = {
  protocol: 'http',
  host: '127.0.0.1',
  port: 18080,
  hasCredentials: false,
  status: 'untested',
  observedIp: null,
  endpoint: null,
  testedAt: null,
  lastPassedAt: null,
} as ProxyState;

function setup(now: () => Date = () => new Date('2026-10-23T10:00:00')) {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-pool-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const profiles = new ProfileStore(meta);
  const jobs = new GenerationStore(meta);
  const log = createLogger(() => undefined);
  const pool = new FlowPoolService(meta, bundles, log, configuredFlowSession(profiles), now);
  const flowSession = (bundleId: string) => profiles.forBundle(bundleId).find((p) => p.platformId === 'google-flow')!;
  /** A new account; its Google Flow session is configured (as after a cookie import) unless `flow` is false. */
  const make = (name: string, mode: 'flow_pool' | 'account_growth' | 'affiliate_ugc', proxy = true, flow = true) => {
    const specs = platformsForMode(mode).map((p) => ({ platformId: p.id, label: p.id, optional: p.optional }));
    const b = bundles.create({ displayName: name, mode }, specs, profiles);
    if (flow) profiles.update(flowSession(b.id).id, { status: 'imported_unverified', statusReason: 'cookies_imported' });
    return proxy ? bundles.update(b.id, { proxy: PROXY }) : b;
  };
  return { userData, meta, bundles, profiles, jobs, pool, make, log, flowSession };
}

const completedDownload = (jobs: GenerationStore, target: string, flowBundleId: string, promptItemId: string | null = null) => {
  const job = jobs.create({ bundleId: target, source: 'manual_download', providerId: 'google-flow-manual', settings: null, promptItemId, flowBundleId });
  jobs.transition(job.id, 'running');
  return jobs.transition(job.id, 'completed', { video: { file: `library/${target}/${job.id}.mp4`, bytes: 10, sha256: 'a'.repeat(64) } });
};

describe('migration 7 (account kind rebuild) on an existing database', () => {
  it('keeps accounts, sessions and their references, and re-enables foreign keys', () => {
    const userData = mkdtempSync(join(tmpdir(), 'ugc-mig-'));
    const db = new DatabaseSync(join(userData, 'ugc.db'));
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    MIGRATIONS.slice(0, 6).forEach((m, i) => {
      db.exec(typeof m === 'string' ? m : m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, 'then');
    });
    const id = '11111111-1111-4111-8111-111111111111';
    db.prepare("INSERT INTO account_bundles VALUES (?, 'Old Affiliate', 'affiliate_ugc', ?, 'then', 'then')").run(id, JSON.stringify(PROXY));
    db.prepare("INSERT INTO platform_sessions (id, bundle_id, platform_id, label, partition, optional, state_json, created_at, updated_at) VALUES (?, ?, 'tiktok', 'TikTok', ?, 0, '{}', 'then', 'then')").run(
      '22222222-2222-4222-8222-222222222222',
      id,
      'persist:ps_22222222-2222-4222-8222-222222222222',
    );
    db.prepare("INSERT INTO affiliate_products (id, bundle_id, platform_product_id, source, facts_json, created_at, updated_at) VALUES ('p1', ?, '1729384756102938471', 'link', '{}', 'then', 'then')").run(id);
    db.close();

    const meta = MetadataDb.open(userData);
    const bundle = new BundleStore(meta).get(id)!;
    expect(bundle).toMatchObject({ displayName: 'Old Affiliate', mode: 'affiliate_ugc', proxy: { host: '127.0.0.1', port: 18080 } });
    expect(meta.db!.prepare('SELECT COUNT(*) AS n FROM platform_sessions WHERE bundle_id = ?').get(id)).toEqual({ n: 1 });
    expect(meta.db!.prepare('SELECT COUNT(*) AS n FROM affiliate_products WHERE bundle_id = ?').get(id)).toEqual({ n: 1 });
    expect(meta.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(meta.db!.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // The rebuilt table still enforces references and accepts the new kind.
    expect(() => meta.db!.prepare("INSERT INTO affiliate_products (id, bundle_id, platform_product_id, source, facts_json, created_at, updated_at) VALUES ('p2', 'missing', '1', 'link', '{}', 'n', 'n')").run()).toThrow();
    const pool = new BundleStore(meta).create({ displayName: 'Pool 01', mode: 'flow_pool' }, [], new ProfileStore(meta));
    expect(pool.mode).toBe('flow_pool');
  });
});

describe('Flow session pool (synthetic)', () => {
  it('pool accounts get only a Google Flow session', () => {
    expect(platformsForMode('flow_pool').map((p) => p.id)).toEqual(['google-flow']);
    expect(platformsForMode('affiliate_ugc').map((p) => p.id)).toEqual(['tiktok', 'google-flow', 'kalodata', 'shopee']);
    const { make, profiles } = setup();
    const p = make('Synthetic Flow Pool 01', 'flow_pool');
    expect(profiles.forBundle(p.id).map((s) => s.platformId)).toEqual(['google-flow']);
  });

  it('settings, credit period, downloads (once per job), owner corrections', () => {
    const { pool, make, jobs, bundles, profiles } = setup();
    const p = make('Synthetic Flow Pool 01', 'flow_pool');
    const growth = make('Synthetic Ternak 01', 'account_growth');
    expect(pool.account(p.id)).toMatchObject({ settings: { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12 }, remaining: 1050, used: 0, proxyConfigured: true });
    expect(() => pool.saveSettings(p.id, { monthlyCredits: 0, resetDay: 31, creditsPerDownload: 1.5 })).toThrow(PoolError);
    pool.saveSettings(p.id, { monthlyCredits: 1050, resetDay: 15, creditsPerDownload: 12 });
    expect(pool.account(p.id).periodStart).toBe(new Date('2026-10-15T00:00:00').toISOString());

    const job = completedDownload(jobs, growth.id, p.id);
    pool.recordDownload(job);
    pool.recordDownload(job); // idempotent
    pool.recordDownload(completedDownload(jobs, growth.id, growth.id)); // the account's own Flow session: counted on that account, not the pool
    expect(pool.account(p.id)).toMatchObject({ used: 12, remaining: 1038, downloadsThisPeriod: 1 });

    pool.setRemaining(p.id, 1000);
    expect(pool.account(p.id).remaining).toBe(1000);
    pool.setRemaining(p.id, 1020); // corrections can go up as well
    expect(pool.account(p.id).remaining).toBe(1020);
    expect(() => pool.setRemaining(p.id, -1)).toThrow(PoolError);
    // An account's own Flow session is a Flow account too (A2): its credits and limits are tracked the same way.
    pool.saveSettings(growth.id, { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12, dailyCreditLimit: 24 });
    expect(pool.account(growth.id)).toMatchObject({ pool: false, usedToday: 12, remaining: 1038, settings: { dailyCreditLimit: 24 } });
    expect(pool.canSpend(growth.id)).toEqual({ ok: true });
    pool.recordDownload(completedDownload(jobs, growth.id, growth.id));
    expect(pool.canSpend(growth.id)).toEqual({ ok: false, reason: 'daily_credit_limit_reached' });
    expect(pool.others().map((a) => a.id)).toEqual([growth.id]);
    expect(() => pool.saveSettings(growth.id, { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12, dailyCreditLimit: 0 })).toThrow(PoolError);
    const noFlow = bundles.create({ displayName: 'No sessions', mode: 'affiliate_ugc' }, [], profiles);
    expect(() => pool.saveSettings(noFlow.id, { monthlyCredits: 1, resetDay: 1, creditsPerDownload: 1 })).toThrow(PoolError);
  });

  it('a newly configured Flow session with no credit history or settings is an eligible Flow identity (regression)', () => {
    const { pool, make, jobs, profiles, flowSession } = setup();
    // No pool account and no credit events at all, as on a fresh profile.
    const aff = make('Synthetic Affiliate 01', 'affiliate_ugc');
    const noSession = make('Synthetic Affiliate 02', 'affiliate_ugc', true, false);
    const growth = make('Synthetic Ternak 01', 'account_growth');
    expect(pool.list()).toEqual([]);
    expect(pool.others().map((a) => a.id)).toEqual([aff.id, growth.id]);
    expect(pool.account(aff.id)).toMatchObject({ pool: false, settingsSaved: false, settings: { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12, dailyCreditLimit: null }, used: 0, remaining: 1050 });
    expect(pool.canSpend(aff.id)).toEqual({ ok: true });
    // Initial settings are created from editable values.
    pool.saveSettings(aff.id, { monthlyCredits: 1000, resetDay: 5, creditsPerDownload: 10, dailyCreditLimit: 120 });
    expect(pool.account(aff.id)).toMatchObject({ settingsSaved: true, settings: { monthlyCredits: 1000, resetDay: 5, creditsPerDownload: 10, dailyCreditLimit: 120 } });
    // A clip rendered by the Ternak account's Flow session for the affiliate account is charged to the Flow identity, not to the TikTok destination.
    pool.recordDownload(completedDownload(jobs, aff.id, growth.id));
    expect(pool.account(growth.id).used).toBe(12);
    expect(pool.account(aff.id).used).toBe(0);
    // A session never set up, reported logged out, or refused is not a Flow identity and can't be spent from.
    expect(pool.canSpend(noSession.id)).toEqual({ ok: false, reason: 'no_flow_session' });
    expect(() => pool.account(noSession.id)).toThrow(PoolError);
    profiles.update(flowSession(growth.id).id, { status: 'expired', statusReason: 'owner_reported_logged_out' });
    expect(pool.others().map((a) => a.id)).toEqual([aff.id]);
    expect(pool.canSpend(growth.id)).toEqual({ ok: false, reason: 'no_flow_session' });
    profiles.update(flowSession(growth.id).id, { status: 'confirmed_by_user', statusReason: 'owner_confirmed' });
    expect(pool.others().map((a) => a.id)).toEqual([aff.id, growth.id]);
  });

  it('pool accounts stay selectable; one without a configured Flow session is listed but never picked', () => {
    const { pool, make } = setup();
    const ready = make('Pool ready', 'flow_pool');
    const unset = make('Pool not set up', 'flow_pool', true, false);
    expect(pool.list().map((a) => [a.id, a.flowSessionId !== null])).toEqual([
      [ready.id, true],
      [unset.id, false],
    ]);
    pool.setRemaining(ready.id, 100);
    expect(pool.pick().id).toBe(ready.id);
    pool.setRemaining(ready.id, 0);
    expect(() => pool.pick()).toThrow(expect.objectContaining({ code: 'no_pool_account_available' }));
  });

  it('the period restarts on the reset day', () => {
    let now = new Date('2026-10-20T10:00:00');
    const { pool, make, jobs } = setup(() => now);
    const p = make('Synthetic Flow Pool 01', 'flow_pool');
    pool.saveSettings(p.id, { monthlyCredits: 1050, resetDay: 21, creditsPerDownload: 12 });
    pool.recordDownload(completedDownload(jobs, p.id, p.id));
    expect(pool.account(p.id).remaining).toBe(1038);
    now = new Date('2026-10-21T00:00:01');
    expect(pool.account(p.id).remaining).toBe(1050);
  });

  it('picks the ready pool account with the most credits', () => {
    const { pool, make, jobs } = setup();
    const a = make('Pool A', 'flow_pool');
    const b = make('Pool B', 'flow_pool');
    make('Pool C (no proxy)', 'flow_pool', false);
    pool.recordDownload(completedDownload(jobs, a.id, a.id));
    expect(pool.pick().id).toBe(b.id);
    pool.setRemaining(b.id, 5); // fewer than one video
    expect(pool.pick().id).toBe(a.id);
    pool.setRemaining(a.id, 11);
    expect(() => pool.pick()).toThrow(expect.objectContaining({ code: 'no_pool_account_available' }));
  });

  it("a prompt taken to a pool account is claimed by that account's Flow window and returns to its own account", async () => {
    const { meta, bundles, jobs, make, log, userData } = setup();
    const studio = new PromptStudioService({ meta, bundles, jobs, generation: null, provider: new TemplateProvider(), log, userData, sensitiveValues: () => [] });
    const growth = make('Synthetic Ternak 01', 'account_growth');
    const p = make('Synthetic Flow Pool 01', 'flow_pool');
    const [one, two] = (await studio.generate(growth.id, 'builtin-asmr')).items;
    for (const i of [one!, two!]) {
      studio.act(growth.id, i.id, 'approve');
      studio.act(growth.id, i.id, 'queue');
    }
    expect(studio.takeToPool(growth.id, one!.id, p.id)).toContain('Scene: ');
    studio.act(growth.id, two!.id, 'start_manual'); // the account's own Flow window
    expect(studio.view(growth.id).batches[0]!.items[0]).toMatchObject({ status: 'generating', handoff: 'manual', flowBundleId: p.id });
    expect(studio.claimManualPrompt(p.id)).toMatchObject({ itemId: one!.id, targetBundleId: growth.id });
    expect(studio.claimManualPrompt(growth.id)).toMatchObject({ itemId: two!.id, targetBundleId: growth.id });
    const job = completedDownload(jobs, growth.id, p.id, one!.id);
    studio.jobEnded(job);
    expect(studio.view(growth.id).batches[0]!.items[0]).toMatchObject({ status: 'video_ready', video: { jobId: job.id } });
    studio.act(growth.id, two!.id, 'back_to_queue');
    expect(studio.view(growth.id).batches[0]!.items[1]).toMatchObject({ status: 'queued', flowBundleId: null });
  });
});
