import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, platformsForMode, TemplateProvider, type ReferenceAnalysis, type VideoAnalysis } from '@ugc/core';
import { GenerationStore } from '../src/main/generation-store.js';
import { GrowthQueueService } from '../src/main/growth-queue.js';
import { VideoLibrary } from '../src/main/library.js';
import { AnalysisService, GeminiAnalyzer, SyntheticAnalyzer, type MediaAnalyzer } from '../src/main/media-analyzer.js';
import { BundleStore, MetadataDb, ProfileStore } from '../src/main/profiles.js';
import { PromptStudioService } from '../src/main/prompt-studio.js';

/** A small file that passes the library's MP4 signature check; `seed` makes its bytes (and hash) unique. */
const fakeMp4 = (file: string, seed: number): string => {
  const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
  writeFileSync(file, Buffer.concat([ftyp, Buffer.alloc(4096, seed)]));
  return file;
};

const sealer = { available: () => true, seal: (t: string) => Buffer.from(`sealed:${Buffer.from(t).toString('base64')}`), open: (b: Buffer) => Buffer.from(b.toString().slice(7), 'base64').toString() };

function setup(options: { synthetic?: boolean; analyzer?: MediaAnalyzer } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-gq-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const profiles = new ProfileStore(meta);
  const jobs = new GenerationStore(meta);
  const library = new VideoLibrary(userData);
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const prompts = new PromptStudioService({ meta, bundles, jobs, generation: null, provider: new TemplateProvider(), log, userData, sensitiveValues: () => [] });
  const analysis = new AnalysisService(meta, userData, sealer, log, { synthetic: options.synthetic ?? true, ...(options.analyzer ? { makeReal: () => options.analyzer! } : {}) });
  const queue = new GrowthQueueService({ meta, bundles, jobs, library, analysis, prompts, log });
  const make = (name: string, mode: 'account_growth' | 'affiliate_ugc' = 'account_growth') =>
    bundles.create({ displayName: name, mode }, platformsForMode(mode).map((p) => ({ platformId: p.id, label: p.id, optional: p.optional })), profiles);
  const files = mkdtempSync(join(tmpdir(), 'ugc-gq-files-'));
  return { userData, meta, jobs, library, prompts, analysis, queue, make, files, lines };
}

describe('Ternak Akun posting queue', () => {
  it('ready-made: imports MP4s (originals untouched), skips duplicates and non-videos, captions each from its video, flags the unclear one', async () => {
    const { queue, make, files, jobs, library } = setup();
    const a = make('Synthetic Ternak 01');
    const b = make('Synthetic Ternak 02');
    const one = fakeMp4(join(files, 'masak nasi goreng kilat.mp4'), 1);
    const two = fakeMp4(join(files, 'lipat baju cepat.mp4'), 2);
    const unclear = fakeMp4(join(files, 'unclear clip.mp4'), 3);
    writeFileSync(join(files, 'notes.txt'), 'x');
    fakeMp4(join(files, 'copy of masak.mp4'), 1); // same bytes as "one"
    const before = { size: statSync(one).size, bytes: readFileSync(one) };

    const r = await queue.importFiles(a.id, [one, two, unclear, join(files, 'notes.txt'), join(files, 'copy of masak.mp4'), join(files, 'missing.mp4')]);
    expect(r).toEqual({
      added: ['masak nasi goreng kilat.mp4', 'lipat baju cepat.mp4', 'unclear clip.mp4'],
      duplicates: ['copy of masak.mp4'],
      rejected: [
        { name: 'notes.txt', reason: 'not_mp4' },
        { name: 'missing.mp4', reason: 'unreadable' },
      ],
    });
    // The original stays where it was, unchanged; the library holds a copy.
    expect(readFileSync(one).equals(before.bytes)).toBe(true);
    await queue.kick();
    const v = queue.view(a.id);
    const by = (name: string) => v.items.find((i) => i.originalName === name)!;
    expect(by('masak nasi goreng kilat.mp4')).toMatchObject({ source: 'ready_made', status: 'ready', flags: [], caption: expect.stringContaining('masak nasi goreng kilat') });
    expect(by('masak nasi goreng kilat.mp4').hashtags[0]).toBe('#masak');
    expect(by('unclear clip.mp4')).toMatchObject({ status: 'needs_review', flags: ['unclear_video'], caption: '' });
    const job = jobs.get(by('lipat baju cepat.mp4').jobId)!;
    expect(existsSync(library.absolute(job.videoFile!))).toBe(true);
    expect(v.counts).toMatchObject({ ready: 2, needs_review: 1 });

    // The same file in another account: allowed, but flagged.
    await queue.importFiles(b.id, [one]);
    await queue.kick();
    expect(queue.view(b.id).items[0]).toMatchObject({ status: 'needs_review', flags: ['duplicate_in_other_account'] });

    // Review: the unclear one gets the owner's caption; posting is recorded only when the owner says so.
    const u = by('unclear clip.mp4');
    expect(() => queue.postText(a.id, u.id)).toThrow();
    queue.updateCaption(a.id, u.id, 'Detik-detik paling bikin kaget hari ini', ['#kaget', 'harian']);
    expect(queue.view(a.id).items.find((i) => i.id === u.id)).toMatchObject({ status: 'ready', captionEdited: true, hashtags: ['#kaget', '#harian'], flags: [] });
    expect(queue.postText(a.id, u.id).text).toBe('Detik-detik paling bikin kaget hari ini\n\n#kaget #harian');
    expect(() => queue.markPosted(a.id, u.id, 'https://vt.tiktok.com/x')).toThrow();
    queue.markPosted(a.id, u.id, 'https://www.tiktok.com/@synthetic.ternak/video/7300000000000000001');
    expect(queue.view(a.id)).toMatchObject({ postedToday: 1, dailyTarget: 10 });
    queue.undoPosted(a.id, u.id);
    expect(queue.view(a.id).postedToday).toBe(0);
    // Other modes are refused.
    const aff = make('Synthetic Affiliate', 'affiliate_ugc');
    await expect(queue.importFiles(aff.id, [two])).rejects.toMatchObject({ code: 'not_growth_account' });
  });

  it('a repeated caption is flagged; analysing again with a note uses it', async () => {
    const { queue, make, files } = setup();
    const a = make('Synthetic Ternak 01');
    await queue.importFiles(a.id, [fakeMp4(join(files, 'rapikan kabel.mp4'), 4), fakeMp4(join(files, 'rapikan kabel (2).mp4'), 5)]);
    await queue.kick();
    const items = queue.view(a.id).items;
    expect(items.filter((i) => i.flags.includes('repetitive_caption'))).toHaveLength(1);
    const flagged = items.find((i) => i.flags.includes('repetitive_caption'))!;
    queue.reanalyze(a.id, flagged.id, 'tutorial menata kabel di bawah meja kerja');
    await queue.kick();
    expect(queue.view(a.id).items.find((i) => i.id === flagged.id)).toMatchObject({ status: 'ready', note: 'tutorial menata kabel di bawah meja kerja', caption: expect.stringContaining('tutorial menata kabel') });
  });

  it('real provider: not configured → failed with a reason; the key is sealed; budget stops calls; retry after fixing', async () => {
    let calls = 0;
    const real: MediaAnalyzer = {
      id: 'mock-gemini',
      describeVideo: async () => {
        calls++;
        return { understood: true, confidence: 0.8, summary: 'Someone folds a shirt', caption: 'Cara lipat kemeja biar nggak kusut di koper', hashtags: ['#lipatbaju', '#traveling'] } satisfies VideoAnalysis;
      },
      analyzeReferences: async () => ({}) as ReferenceAnalysis,
      variations: async () => [],
    };
    const { queue, make, files, analysis, userData } = setup({ synthetic: false, analyzer: real });
    const a = make('Synthetic Ternak 01');
    await queue.importFiles(a.id, [fakeMp4(join(files, 'v1.mp4'), 6), fakeMp4(join(files, 'v2.mp4'), 7)]);
    await queue.kick();
    expect(queue.view(a.id).items.map((i) => [i.status, i.analysisError])).toEqual([
      ['analysis_failed', 'analysis_not_configured'],
      ['analysis_failed', 'analysis_not_configured'],
    ]);
    expect(analysis.status()).toMatchObject({ ready: false, keySet: false, synthetic: false });
    expect(() => analysis.save({ model: 'gemini-3.8-flash', costPerCallUsd: 0.05, monthlyBudgetUsd: 0.05 }, 'short')).toThrow();
    analysis.save({ model: 'gemini-3.8-flash', costPerCallUsd: 0.05, monthlyBudgetUsd: 0.05 }, 'AIzaSyntheticKey_0123456789abcdef');
    // Sealed on disk, never in plain text.
    const sealedFile = join(userData, 'ai-secrets', 'gemini.sealed');
    expect(readFileSync(sealedFile, 'utf8')).not.toContain('AIzaSyntheticKey');
    expect(analysis.status()).toMatchObject({ ready: true, keySet: true, model: 'gemini-3.8-flash' });
    expect(queue.retryFailed(a.id)).toBe(2);
    await queue.kick();
    // The budget covers one call: the second waits with a reason.
    expect(calls).toBe(1);
    expect(queue.view(a.id).items.map((i) => i.status).sort()).toEqual(['analysis_failed', 'ready']);
    expect(queue.view(a.id).items.find((i) => i.status === 'analysis_failed')!.analysisError).toBe('analysis_budget_reached');
    expect(analysis.status()).toMatchObject({ spentThisMonthUsd: 0.05, callsThisMonth: 1 });
    analysis.save({ model: 'gemini-3.8-flash', costPerCallUsd: 0.05, monthlyBudgetUsd: 1 }, '');
    expect(analysis.status().keySet).toBe(true); // an empty key keeps the saved one
    queue.retryFailed(a.id);
    await queue.kick();
    // The mock gives the same caption again, so the second video is flagged as repetitive rather than queued as-is.
    expect(queue.view(a.id).items.map((i) => [i.status, i.flags]).sort()).toEqual([
      ['needs_review', ['repetitive_caption']],
      ['ready', []],
    ]);
    analysis.removeKey();
    expect(analysis.status().keySet).toBe(false);
  });

  it('AI-generated: FYP references → format → original prompts in the Flow queue → the finished video joins the queue with a caption', async () => {
    const { queue, make, files, prompts, jobs, library } = setup();
    const a = make('Synthetic Ternak 01');
    const ref = await prompts.addReference(a.id, fakeMp4(join(files, 'fyp-ref.mp4'), 8), true);
    await expect(queue.analyzeReferences(a.id, [], '')).rejects.toMatchObject({ code: 'invalid_reference_request' });
    const reference = await queue.analyzeReferences(a.id, [ref.id], 'keep the reveal');
    expect(reference.analysis.structure.length).toBeGreaterThan(1);
    const batch = await queue.makeVariations(a.id, reference.id, 3);
    expect(batch.items.map((i) => i.status)).toEqual(['queued', 'queued', 'queued']);
    expect(batch.templateKey).toBe('builtin-fyp-variation');
    expect(new Set(batch.items.map((i) => i.rendered)).size).toBe(3);
    expect(batch.items[0]!.rendered).toContain('Hook (first 1–2 seconds):');
    // A second round avoids the earlier hooks.
    expect(prompts.recentVariationHooks(a.id)).toHaveLength(3);

    // Through the existing Flow workflow: "I'm generating it in Flow", then the download completes.
    const item = batch.items[0]!;
    prompts.act(a.id, item.id, 'start_manual');
    const job = jobs.create({ bundleId: a.id, source: 'manual_download', providerId: 'google-flow-manual', settings: null, promptItemId: item.id, flowBundleId: a.id });
    jobs.transition(job.id, 'running');
    const stored = library.save(a.id, job.id, readFileSync(fakeMp4(join(files, 'flow.mp4'), 9)));
    const done = jobs.transition(job.id, 'completed', { video: stored });
    prompts.jobEnded(done);
    queue.addFromJob(done);
    queue.addFromJob(done); // once only
    await queue.kick();
    const v = queue.view(a.id);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ source: 'ai_generated', status: 'ready', promptItemId: item.id });
    // Its caption came from the video plus the prompt it was made from.
    expect(v.items[0]!.note).toContain('Opens on the finished result');
    // Posting it also marks the prompt posted (Ternak Akun today stays in step).
    queue.markPosted(a.id, v.items[0]!.id, null);
    expect(prompts.view(a.id).batches.flatMap((b) => b.items).find((i) => i.id === item.id)?.post).not.toBeNull();
  });
});

describe('Gemini analyzer (mocked network)', () => {
  it('uploads with the Files API, waits for ACTIVE, asks for JSON with the file attached, deletes the upload, keeps the key in a header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ugc-gem-'));
    const file = fakeMp4(join(dir, 'v.mp4'), 10);
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const fake = (async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      calls.push({ url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? 'bytes' : null });
      const json = (o: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', ...h } });
      if (url.endsWith('/upload/v1beta/files')) return json({}, { 'x-goog-upload-url': 'https://upload.example/session-1' });
      if (url === 'https://upload.example/session-1') return json({ file: { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'PROCESSING' } });
      if (url.endsWith('/v1beta/files/abc') && (init.method ?? 'GET') === 'GET') return json({ state: 'ACTIVE' });
      if (url.endsWith('/v1beta/files/abc')) return json({});
      if (url.includes(':generateContent'))
        return json({ candidates: [{ content: { parts: [{ text: '```json\n{"understood": true, "confidence": 0.8, "summary": "A dog", "caption": "Anjing ini nunggu majikan tiap sore", "hashtags": ["anjing"]}\n```' }] } }] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const g = new GeminiAnalyzer('AIzaSyntheticKey_0123456789abcdef', 'gemini-3.8-flash', fake, 1);
    const out = await g.describeVideo(file, { note: '', recentCaptions: [] });
    expect(out).toEqual({ understood: true, confidence: 0.8, summary: 'A dog', caption: 'Anjing ini nunggu majikan tiap sore', hashtags: ['#anjing'] });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`)).toEqual([
      'POST /upload/v1beta/files',
      'POST /session-1',
      'GET /v1beta/files/abc',
      'POST /v1beta/models/gemini-3.8-flash:generateContent',
      'DELETE /v1beta/files/abc',
    ]);
    expect(calls[0]!.headers['x-goog-upload-command']).toBe('start');
    expect(calls[1]!.headers['x-goog-upload-command']).toBe('upload, finalize');
    const gen = calls[3]!.body as { contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig: Record<string, unknown> };
    expect(gen.contents[0]!.parts[0]).toEqual({ file_data: { mime_type: 'video/mp4', file_uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } });
    expect(gen.generationConfig['response_mime_type']).toBe('application/json');
    // The key travels in a header only, never in a URL.
    expect(calls.every((c) => !c.url.includes('AIza'))).toBe(true);
    expect(calls.filter((c) => !c.url.startsWith('https://upload.example')).every((c) => c.headers['x-goog-api-key'] === 'AIzaSyntheticKey_0123456789abcdef')).toBe(true);
  });

  it('the synthetic analyzer is deterministic and costs nothing', async () => {
    const s = new SyntheticAnalyzer();
    expect(await s.describeVideo('/x/menyiram tanaman.mp4', { note: '', recentCaptions: [] })).toEqual(await s.describeVideo('/x/menyiram tanaman.mp4', { note: '', recentCaptions: [] }));
  });
});
