import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, platformsForMode, TemplateProvider } from '@ugc/core';
import { findFfmpeg, makeSyntheticClip } from '@ugc/test-fixtures';
import { AffiliateService } from '../src/main/affiliate.js';
import { AffiliateStudioError, AffiliateStudioService } from '../src/main/affiliate-studio.js';
import { FfmpegRunner } from '../src/main/ffmpeg.js';
import { configuredFlowSession, FlowPoolService } from '../src/main/flow-pool.js';
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
  const flowSessionOf = configuredFlowSession(profiles);
  const pool = new FlowPoolService(meta, bundles, log, flowSessionOf);
  const prompts = new PromptStudioService({ meta, bundles, jobs, generation: null, provider: new TemplateProvider(), log, userData, sensitiveValues: () => [] });
  const ffmpeg = await FfmpegRunner.locate();
  const studio = new AffiliateStudioService({ meta, bundles, jobs, library, pool, log, assets: (b) => prompts.assets(b), referencePath: (b, id) => prompts.referencePath(b, id), ffmpeg: () => ffmpeg, flowSessionOf });
  const make = (name: string, mode: 'affiliate_ugc' | 'account_growth' | 'flow_pool') => {
    const b = bundles.create({ displayName: name, mode }, platformsForMode(mode).map((p) => ({ platformId: p.id, label: p.id, optional: p.optional })), profiles);
    const flow = profiles.forBundle(b.id).find((p) => p.platformId === 'google-flow')!;
    profiles.update(flow.id, { status: 'imported_unverified', statusReason: 'cookies_imported' });
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
  return { userData, bundles, jobs, pool, studio, products, prompts, aff, flowPool, productRow, ready, clip, download, lines, make };
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

describe('A3: listing fill, one-click videos and the clip queue', () => {
  it('a listing read from the page makes the product ready; one click plans and approves; clips go to Flow one at a time, in order', async () => {
    const env = await setup();
    const { studio, products, prompts, aff, flowPool, productRow, userData } = env;
    // What the listing reader found on the product page, with its photo saved as a reference image.
    const png = join(userData, 'listing.png');
    writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]));
    const photo = await prompts.addReference(aff.id, png, true);
    products.applyListing(
      aff.id,
      productRow,
      { title: 'Serum Glow Sintetis 30 ml', shopName: 'Toko Glow Sintetis', priceIdr: 89000, description: 'Manfaat: membantu mencerahkan kulit kusam. Isi 30 ml.', features: ['Membantu mencerahkan kulit kusam', 'Isi 30 ml'] },
      photo.id,
    );
    expect(products.view(aff.id).products[0]).toMatchObject({
      listing: 'confirmed',
      imageAssetId: photo.id,
      facts: { title: 'Serum Glow Sintetis 30 ml', shopName: 'Toko Glow Sintetis', priceIdr: 89000, features: ['Membantu mencerahkan kulit kusam', 'Isi 30 ml'], notes: 'Manfaat: membantu mencerahkan kulit kusam. Isi 30 ml.' },
    });
    // A second read without a photo keeps the saved one; empty fields keep what was there.
    products.applyListing(aff.id, productRow, { title: 'Serum Glow Sintetis 30 ml', shopName: '', priceIdr: null, description: '', features: [] }, null);
    expect(products.view(aff.id).products[0]).toMatchObject({ imageAssetId: photo.id, facts: { shopName: 'Toko Glow Sintetis', priceIdr: 89000, features: ['Membantu mencerahkan kulit kusam', 'Isi 30 ml'] } });

    // One click: 3 plans (the configured count), all approved; the product photo is their reference.
    studio.saveConfig(aff.id, { ...studio.config(aff.id), count: 3 });
    expect(await code(() => studio.nextClip(aff.id, productRow))).toBe('nothing_to_send');
    expect(studio.makeVideos(aff.id, productRow)).toMatchObject({ approved: 3, blocked: 0 });
    const videos = [...studio.view(aff.id, productRow).videos].sort((a, b) => a.position - b.position);
    expect(videos.map((v) => [v.status, v.continuity])).toEqual([
      ['approved', 'cut'],
      ['approved', 'cut'],
      ['approved', 'cut'],
    ]);
    expect(videos[0]!.clips[0]!.manualSteps[0]).toContain('"1-product" (the product photo)');
    expect(videos[0]!.clipA.sections.map((x) => x.text).join(' ')).toContain('uploaded product reference image');

    // The queue: Clip A then Clip B of video 1, then video 2 — never two clips in Flow at once.
    const first = studio.nextClip(aff.id, productRow);
    expect(first).toBe(videos[0]!.clips.find((c) => c.slot === 'A')!.id);
    studio.handOff(aff.id, first, flowPool.id);
    expect(await code(() => studio.nextClip(aff.id, productRow))).toBe('nothing_to_send');
    studio.clipFailed(aff.id, first, 'render_error');
    // A failed clip comes back first while it has attempts left.
    expect(studio.nextClip(aff.id, productRow)).toBe(first);
    studio.handOff(aff.id, first, flowPool.id);
    studio.clipFailed(aff.id, first, 'refused');
    studio.handOff(aff.id, studio.nextClip(aff.id, productRow), flowPool.id); // third and last attempt for Clip A
    studio.clipFailed(aff.id, first, 'no_output');
    expect(studio.nextClip(aff.id, productRow)).toBe(videos[0]!.clips.find((c) => c.slot === 'B')!.id);

    // Drafts can also be approved together; a blocked one stays a draft.
    studio.generate(aff.id, productRow);
    const drafts = studio.view(aff.id, productRow).videos.filter((v) => v.status === 'draft');
    expect(drafts).toHaveLength(3);
    expect(studio.approveAll(aff.id, productRow)).toEqual({ approved: 3, blocked: 0 });
  });
});

describe('Reference images for Flow (product photo + character sheet)', () => {
  it('each plan character needs one sheet; sending is refused without references; the copied prompt names the uploaded images; one clip per Flow window', async () => {
    const env = await setup();
    const { studio, products, prompts, aff, flowPool, productRow, userData } = env;
    const png = (name: string, seed: number) => {
      const f = join(userData, name);
      writeFileSync(f, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, seed)]));
      return f;
    };
    products.applyListing(aff.id, productRow, { title: 'Serum Glow Sintetis 30 ml', shopName: '', priceIdr: null, description: '', features: ['Isi 30 ml'] }, null);
    studio.saveConfig(aff.id, { ...studio.config(aff.id), count: 2 });
    studio.makeVideos(aff.id, productRow);
    const view = studio.view(aff.id, productRow);
    const used = new Set(view.videos.map((v) => v.axes['character']));
    expect(view.characters.map((c) => c.text).sort()).toEqual([...used].sort());
    expect(view.characters.every((c) => c.assetId === null && c.sheetPrompt.startsWith('Character reference sheet of ') && c.sheetPrompt.includes(c.text))).toBe(true);
    expect(view.productPhoto).toBeNull();

    const v1 = [...view.videos].sort((a, b) => a.position - b.position)[0]!;
    const clipA = v1.clips.find((c) => c.slot === 'A')!.id;
    expect(await code(() => studio.requireReferences(aff.id, clipA))).toBe('references_missing');
    try {
      studio.requireReferences(aff.id, clipA);
    } catch (e) {
      expect((e as { details: string[] }).details).toEqual(['product_photo', 'character_sheet']);
    }

    // Product photo (from the listing) and the character's sheet.
    const photo = await prompts.addReference(aff.id, png('listing.png', 1), true);
    products.applyListing(aff.id, productRow, { title: 'Serum Glow Sintetis 30 ml', shopName: '', priceIdr: null, description: '', features: ['Isi 30 ml'] }, photo.id);
    const character = studio.view(aff.id, productRow).characters.find((c) => c.text === v1.axes['character'])!;
    const sheet = await prompts.addReference(aff.id, png('sheet.png', 2), true);
    expect(await code(() => studio.setCharacterImage(aff.id, productRow, 'ffffffffffffffff', sheet.id))).toBe('unknown_character');
    studio.setCharacterImage(aff.id, productRow, character.key, sheet.id);
    const refs = studio.requireReferences(aff.id, clipA);
    expect(refs.product?.path).toBe(prompts.referencePath(aff.id, photo.id));
    expect(refs.character?.path).toBe(prompts.referencePath(aff.id, sheet.id));
    expect(studio.view(aff.id, productRow).characters.find((c) => c.key === character.key)).toMatchObject({ assetId: sheet.id });
    // The same character in another video reuses the sheet (keyed by the description).
    const sameCharacter = studio.view(aff.id, productRow).videos.filter((v) => v.axes['character'] === v1.axes['character']);
    for (const v of sameCharacter) expect(studio.clipReferences(aff.id, v.clips[1]!.id).character?.id).toBe(sheet.id);

    // The prompt copied for Flow names both images; the manual steps list them.
    const { text } = studio.handOff(aff.id, clipA, flowPool.id);
    expect(text).toContain('Reference images uploaded with this prompt: the product reference image');
    expect(text).toContain('the character reference sheet');
    expect(studio.view(aff.id, productRow).videos.find((v) => v.id === v1.id)!.clips[0]!.manualSteps.join(' ')).toContain('"2-character" (the character reference sheet)');
    // That Flow window is busy until this clip arrives or fails.
    const clipB = v1.clips.find((c) => c.slot === 'B')!.id;
    expect(await code(() => studio.handOff(aff.id, clipB, flowPool.id))).toBe('clip_action_not_allowed');
    studio.clipFailed(aff.id, clipA, 'render_error');
    expect(studio.handOff(aff.id, clipB, flowPool.id).flowBundleId).toBe(flowPool.id);
  });
});

describe.runIf(!FFMPEG)('Affiliate Creative Studio without FFmpeg', () => {
  it('is skipped: FFmpeg is not installed on this machine', () => {
    expect(FFMPEG).toBeNull();
  });
});
