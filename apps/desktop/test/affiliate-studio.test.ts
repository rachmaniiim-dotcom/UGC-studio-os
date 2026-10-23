import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, platformsForMode, TemplateProvider } from '@ugc/core';
import { findFfmpeg, makeSyntheticClip } from '@ugc/test-fixtures';
import { AffiliateService } from '../src/main/affiliate.js';
import { AffiliateStudioError, AffiliateStudioService } from '../src/main/affiliate-studio.js';
import { FfmpegRunner } from '../src/main/ffmpeg.js';
import { FlowPoolService } from '../src/main/flow-pool.js';
import { GenerationStore } from '../src/main/generation-store.js';
import { VideoLibrary } from '../src/main/library.js';
import { BundleStore, MetadataDb, ProfileStore, type ProxyState } from '../src/main/profiles.js';
import { PromptStudioService } from '../src/main/prompt-studio.js';

// A2 with real FFmpeg on synthetic clips (FFmpeg's own test patterns). No credits, no Flow, no TikTok.
const FFMPEG = findFfmpeg();
const PRODUCT = '1729384756102938471';
const PROXY = { protocol: 'http', host: '127.0.0.1', port: 18080, hasCredentials: false, status: 'untested', observedIp: null, endpoint: null, testedAt: null, lastPassedAt: null } as ProxyState;

async function setup() {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-a2-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const profiles = new ProfileStore(meta);
  const jobs = new GenerationStore(meta);
  const library = new VideoLibrary(userData);
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const flowSessionOf = (id: string) => profiles.forBundle(id).find((p) => p.platformId === 'google-flow')?.id ?? null;
  const pool = new FlowPoolService(meta, bundles, log, flowSessionOf);
  const prompts = new PromptStudioService({ meta, bundles, jobs, generation: null, provider: new TemplateProvider(), log, userData, sensitiveValues: () => [] });
  const ffmpeg = await FfmpegRunner.locate();
  const studio = new AffiliateStudioService({ meta, bundles, jobs, library, pool, log, assets: (b) => prompts.assets(b), ffmpeg: () => ffmpeg, flowSessionOf });
  const make = (name: string, mode: 'affiliate_ugc' | 'account_growth' | 'flow_pool') => {
    const b = bundles.create({ displayName: name, mode }, platformsForMode(mode).map((p) => ({ platformId: p.id, label: p.id, optional: p.optional })), profiles);
    return bundles.update(b.id, { proxy: PROXY });
  };
  const aff = make('Synthetic Affiliate 01', 'affiliate_ugc');
  const flowPool = make('Synthetic Flow Pool 01', 'flow_pool');
  const products = new AffiliateService(meta, bundles, log);
  products.addFromText(aff.id, PRODUCT);
  const productRow = products.view(aff.id).products[0]!.id;
  const ready = () => {
    products.setListing(aff.id, productRow, 'confirmed');
    products.updateFacts(aff.id, productRow, { title: 'Kipas Angin Mini Sintetis', shopName: 'Toko Sintetis', priceIdr: '89000', features: ['3 kecepatan angin', 'baterai isi ulang USB-C'] });
  };
  const clips = mkdtempSync(join(tmpdir(), 'ugc-a2-clips-'));
  const clip = (name: string, opts: Parameters<typeof makeSyntheticClip>[1] = {}) => {
    const f = join(clips, name);
    makeSyntheticClip(f, opts);
    return f;
  };
  /** What the Flow download handler does when a clip's file arrives in a Flow window. */
  const download = async (clipId: string, flowBundleId: string, file: string) => {
    const job = jobs.create({ bundleId: aff.id, source: 'manual_download', providerId: 'google-flow-manual', settings: null, affiliateClipId: clipId, flowBundleId });
    jobs.transition(job.id, 'running');
    const stored = library.save(aff.id, job.id, readFileSync(file));
    const done = jobs.transition(job.id, 'completed', { video: stored });
    await studio.jobEnded(done, pool.recordDownload(done));
  };
  return { userData, bundles, jobs, pool, studio, products, aff, flowPool, productRow, ready, clip, download, lines, make };
}

const code = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return undefined;
};

describe.skipIf(!FFMPEG)('Affiliate Creative Studio with local FFmpeg (synthetic clips)', { timeout: 120_000 }, () => {
  // Real H.264 encoding of synthetic clips takes a few seconds per stitch.
  it('vertical slice: product → plan → Clip A from a pool Flow window, Clip B imported → stitched 16 s MP4 → review → library', async () => {
    const env = await setup();
    const { studio, aff, flowPool, productRow } = env;
    expect(await code(() => studio.generate(aff.id, productRow))).toBe('product_not_ready');
    env.ready();
    studio.saveConfig(aff.id, { ...studio.config(aff.id), count: 2, continuity: 'mixed' });
    studio.generate(aff.id, productRow);
    let view = studio.view(aff.id, productRow);
    expect(view.videos).toHaveLength(2);
    const video = view.videos.find((v) => v.position === 1)!;
    expect(video).toMatchObject({ status: 'draft', continuity: 'seamless', productId: PRODUCT, flags: [] });
    const [clipA, clipB] = video.clips;

    // Nothing can be spent before the plan is approved.
    expect(await code(() => studio.handOff(aff.id, clipA!.id, null))).toBe('clip_action_not_allowed');
    studio.planAction(aff.id, video.id, 'approve');

    // Clip A to the Flow pool (picked by credits); the download in that window is claimed for Clip A.
    const handed = studio.handOff(aff.id, clipA!.id, null);
    expect(handed.flowBundleId).toBe(flowPool.id);
    expect(handed.text).toContain('Kipas Angin Mini Sintetis');
    expect(studio.claimForFlow(flowPool.id)).toMatchObject({ clipId: clipA!.id, targetBundleId: aff.id });
    await env.download(clipA!.id, flowPool.id, env.clip('a.mp4', { width: 720, height: 1280, fps: 24 }));
    view = studio.view(aff.id, productRow);
    expect(view.videos.find((v) => v.id === video.id)!.clips[0]).toMatchObject({ status: 'received', credits: 12, flowBundleId: flowPool.id, flowName: 'Synthetic Flow Pool 01', attempts: 1 });
    expect(env.pool.account(flowPool.id)).toMatchObject({ used: 12, remaining: 1038 });

    // Clip B imported (silent clip): both in → joined automatically.
    await studio.importClip(aff.id, clipB!.id, env.clip('b.mp4', { audio: false, pattern: 'smptebars' }));
    await studio.idle();
    let v = studio.view(aff.id, productRow).videos.find((x) => x.id === video.id)!;
    expect(v.status).toBe('review');
    expect(v.final).toMatchObject({ width: 1080, height: 1920 });
    expect(v.final!.durationSeconds).toBeGreaterThan(15.5);
    expect(v.final!.durationSeconds).toBeLessThan(16.6);
    expect(existsSync(join(env.userData, ...v.final!.file.split('/')))).toBe(true);
    const lastFrame = await studio.exportLastFrame(aff.id, clipA!.id);
    expect(existsSync(lastFrame)).toBe(true);

    // Review: reject for continuity and redo Clip B in the account's own Flow session.
    studio.review(aff.id, video.id, { approve: false, reason: 'continuity', redo: 'B' });
    v = studio.view(aff.id, productRow).videos.find((x) => x.id === video.id)!;
    expect(v).toMatchObject({ status: 'producing', reviewNote: 'continuity' });
    expect(v.clips[1]).toMatchObject({ status: 'unusable', lastReason: 'unusable:continuity' });
    expect(studio.handOff(aff.id, clipB!.id, aff.id).flowBundleId).toBe(aff.id);
    await studio.importClip(aff.id, clipB!.id, env.clip('b2.mp4', { tone: 660 }));
    await studio.idle();
    v = studio.view(aff.id, productRow).videos.find((x) => x.id === video.id)!;
    expect(v.status).toBe('review');
    expect(v.final!.file).toMatch(/-v2\.mp4$/);
    studio.review(aff.id, video.id, { approve: true });

    // Library: associations kept end to end; counters separate.
    const lib = studio.library(aff.id).videos;
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({
      productId: PRODUCT,
      productTitle: 'Kipas Angin Mini Sintetis',
      showcase: 'not_requested',
      status: 'final_approved',
      clips: [
        { slot: 'A', status: 'approved', flowName: 'Synthetic Flow Pool 01', credits: 12 },
        { slot: 'B', status: 'approved', flowName: 'Synthetic Affiliate 01', attempts: 2, credits: 12 },
      ],
    });
    expect(studio.view(aff.id, productRow).today).toEqual({ attempts: 3, generationFailed: 0, unusable: 1, clipsApproved: 2, finalsApproved: 1, startedToday: 1 });
    expect(env.pool.account(aff.id)).toMatchObject({ pool: false, used: 12 });
    expect(env.lines.join('\n')).not.toMatch(/Kipas|Toko Sintetis|keranjang/);
  });

  it('failed renders, unusable files, attempt and daily limits, Flow budgets, approval blocks', async () => {
    const env = await setup();
    const { studio, aff, flowPool, productRow } = env;
    env.ready();
    studio.saveConfig(aff.id, { ...studio.config(aff.id), count: 2 });
    studio.generate(aff.id, productRow);
    const [one, two] = studio.view(aff.id, productRow).videos.slice().sort((a, b) => a.position - b.position);
    // An edit that adds an unverified claim blocks approval.
    studio.updatePlan(aff.id, two!.id, {
      clipA: two!.clipA.sections.map((s) => ({ key: s.key, text: s.key === 'dialogue' ? 'Diskon 70% hari ini!' : s.text })),
      clipB: two!.clipB.sections.map((s) => ({ key: s.key, text: s.text })),
      caption: two!.caption,
    });
    expect(await code(() => studio.planAction(aff.id, two!.id, 'approve'))).toBe('plan_blocked');

    studio.planAction(aff.id, one!.id, 'approve');
    const clipA = one!.clips[0]!.id;
    studio.handOff(aff.id, clipA, flowPool.id);
    studio.clipFailed(aff.id, clipA, 'render_error');
    // A file arrives but isn't a real video (credits spent, output unusable).
    studio.handOff(aff.id, clipA, flowPool.id);
    const fake = join(env.userData, 'fake.mp4');
    writeFileSync(fake, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4000, 7)]));
    await env.download(clipA, flowPool.id, fake);
    let c = studio.view(aff.id, productRow).videos.find((v) => v.id === one!.id)!.clips[0]!;
    expect(c).toMatchObject({ status: 'unusable', attempts: 2, credits: 12 });
    expect(c.lastReason).toMatch(/^unusable:invalid_clip/);
    expect(studio.view(aff.id, productRow).today).toMatchObject({ attempts: 2, generationFailed: 1, unusable: 1 });

    // Attempt limit (editable, default 3).
    studio.setLimits(aff.id, { maxClipAttempts: 2, videosPerProductPerDay: 10 });
    expect(await code(() => studio.handOff(aff.id, clipA, flowPool.id))).toBe('attempt_limit_reached');
    studio.setLimits(aff.id, { maxClipAttempts: 3, videosPerProductPerDay: 10 });

    // Flow budget on the Flow account itself (daily credit limit reached after 12 credits).
    env.pool.saveSettings(flowPool.id, { monthlyCredits: 1050, resetDay: 1, creditsPerDownload: 12, dailyCreditLimit: 12 });
    expect(await code(() => studio.handOff(aff.id, clipA, flowPool.id))).toBe('flow_budget_exhausted');
    expect(await code(() => studio.handOff(aff.id, clipA, null))).toBe('no_pool_account_available');
    c = studio.view(aff.id, productRow).videos.find((v) => v.id === one!.id)!.clips[0]!;
    expect(c.attempts).toBe(2); // refused hand-offs don't count

    // Videos started per product per day.
    studio.setLimits(aff.id, { maxClipAttempts: 3, videosPerProductPerDay: 1 });
    studio.updatePlan(aff.id, two!.id, { clipA: two!.clipA.sections.map((s) => ({ key: s.key, text: s.text })), clipB: two!.clipB.sections.map((s) => ({ key: s.key, text: s.text })), caption: two!.caption });
    studio.planAction(aff.id, two!.id, 'approve');
    expect(await code(() => studio.handOff(aff.id, two!.clips[0]!.id, aff.id))).toBe('product_daily_limit_reached');

    // Factories stay separate.
    const growth = env.make('Synthetic Ternak 01', 'account_growth');
    expect(await code(() => studio.view(growth.id, productRow))).toBe('not_affiliate_account');
    expect(AffiliateStudioError).toBeDefined();
  }, 120_000);
});

describe.runIf(!FFMPEG)('Affiliate Creative Studio without FFmpeg', () => {
  it('is skipped: FFmpeg is not installed on this machine', () => {
    expect(FFMPEG).toBeNull();
  });
});
