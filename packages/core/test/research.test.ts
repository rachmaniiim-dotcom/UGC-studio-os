import { describe, expect, it } from 'vitest';
import {
  assessReferences,
  csvRowToReference,
  DEFAULT_THRESHOLDS,
  EMPTY_STRATEGY,
  explainAssessment,
  median,
  normalizeHandle,
  parseMetric,
  parseReferenceCsv,
  parseTikTokVideoUrl,
  validateReference,
  validateStrategy,
  type ReferenceMetrics,
  type ScoredVideo,
} from '../src/index.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const ago = (d: number): string => new Date(NOW.getTime() - d * DAY).toISOString();
const exact = (value: number) => ({ value, exactness: 'exact' as const });
const metrics = (views: number | null, extra: Partial<ReferenceMetrics> = {}): ReferenceMetrics => ({
  views: views === null ? null : exact(views),
  likes: exact(100),
  comments: exact(10),
  shares: exact(5),
  observedAt: NOW.toISOString(),
  ...extra,
});
let seq = 0;
const video = (creator: string, daysAgo: number | null, m: ReferenceMetrics, extra: Partial<ScoredVideo> = {}): ScoredVideo => ({
  id: `v${++seq}`,
  creatorHandle: creator,
  publishedAt: daysAgo === null ? null : ago(daysAgo),
  metrics: m,
  relevance: 'unrated',
  pinned: false,
  ...extra,
});
const peers = (creator: string, views: number[]) => views.map((v, i) => video(creator, 5 + i, metrics(v)));

describe('growth strategy', () => {
  it('accepts a complete strategy with the default thresholds', () => {
    const r = validateStrategy({ ...EMPTY_STRATEGY, niche: 'home appliances', subNiches: ['kitchen'], dailyConcepts: 10, dailyVideos: 3 });
    expect(r.ok).toBe(true);
    expect(DEFAULT_THRESHOLDS).toMatchObject({ outlierThreshold: 3, windowDays: 30, recommendedBaseline: 8 });
  });

  it('reports every invalid field and threshold', () => {
    const r = validateStrategy({
      ...EMPTY_STRATEGY,
      niche: '',
      dailyConcepts: 1.5,
      thresholds: { ...DEFAULT_THRESHOLDS, outlierThreshold: 1, windowDays: 3, minimumBaseline: 9, settleDays: -1, minViews: 0.5, staleDays: 0 },
    });
    expect(r).toEqual({
      ok: false,
      issues: expect.arrayContaining(['invalid_niche', 'invalid_daily_targets', 'invalid_outlier_threshold', 'invalid_window', 'invalid_baseline', 'invalid_settle_days', 'invalid_min_views', 'invalid_stale_days']),
    });
    expect(validateStrategy(null).ok).toBe(false);
  });
});

describe('reference parsing (offline, never fetched)', () => {
  it('accepts only full TikTok video links and canonicalizes them', () => {
    expect(parseTikTokVideoUrl('https://m.tiktok.com/@Synth.User/video/7000000000000000001?is_from_webapp=1')).toEqual({
      url: 'https://www.tiktok.com/@synth.user/video/7000000000000000001',
      handle: 'synth.user',
      videoId: '7000000000000000001',
    });
    expect(parseTikTokVideoUrl('https://vm.tiktok.com/ZSabc123/')).toEqual({ error: 'short_link_unsupported' });
    expect(parseTikTokVideoUrl('https://www.tiktok.com/t/ZSabc123/')).toEqual({ error: 'short_link_unsupported' });
    for (const bad of ['http://www.tiktok.com/@a.b/video/7000000000000000001', 'https://tiktok.com.evil.test/@ab/video/7000000000000000001', 'https://www.tiktok.com/@ab/photo/1', 'nope']) {
      expect(parseTikTokVideoUrl(bad)).toEqual({ error: 'invalid_url' });
    }
    expect(normalizeHandle('@Synth.User')).toBe('synth.user');
    expect(normalizeHandle('bad handle')).toBeNull();
  });

  it('parses exact and display-rounded metrics without guessing', () => {
    expect(parseMetric('12345')).toEqual({ value: 12345, exactness: 'exact' });
    expect(parseMetric('12,345')).toEqual({ value: 12345, exactness: 'exact' });
    expect(parseMetric('12.345')).toEqual({ value: 12345, exactness: 'exact' });
    expect(parseMetric('1.2M')).toEqual({ value: 1_200_000, exactness: 'rounded' });
    expect(parseMetric('3,4 jt')).toEqual({ value: 3_400_000, exactness: 'rounded' });
    expect(parseMetric('1,2 rb')).toEqual({ value: 1200, exactness: 'rounded' });
    expect(parseMetric('52K')).toEqual({ value: 52000, exactness: 'rounded' });
    for (const empty of ['', '-', 'n/a', null, undefined]) expect(parseMetric(empty)).toBeNull();
    for (const bad of ['lots', '-5', '1.5', 1.5, -1, {}]) expect(parseMetric(bad)).toBe('invalid');
  });

  it('validates a reference and stamps observation time only when metrics are given', () => {
    const r = validateReference({ url: 'https://www.tiktok.com/@synth.a/video/7000000000000000001', publishedAt: '2026-10-10', views: '1.2M', relevance: 'relevant' }, NOW);
    expect(r).toMatchObject({ ok: true, value: { creatorHandle: 'synth.a', publishedAt: '2026-10-10T00:00:00.000Z', metrics: { views: { exactness: 'rounded' }, observedAt: NOW.toISOString(), likes: null } } });
    const none = validateReference({ url: 'https://www.tiktok.com/@synth.a/video/7000000000000000001' }, NOW);
    expect(none).toMatchObject({ ok: true, value: { metrics: { observedAt: null } } });
    expect(
      validateReference({ url: 'https://www.tiktok.com/@synth.a/video/7000000000000000001', creator: '@synth.b', publishedAt: '2027-01-01', views: 'x', durationSeconds: 0, relevance: 'maybe' }, NOW),
    ).toEqual({ ok: false, issues: ['creator_mismatch', 'published_in_future', 'invalid_video_duration', 'invalid_views', 'invalid_relevance'] });
  });

  it('parses CSV with quotes, semicolons, a BOM and unknown columns', () => {
    const csv = '﻿URL;Views;Note;Extra\r\nhttps://www.tiktok.com/@synth.a/video/7000000000000000001;"12.345";"say ""hi""; ok";x\r\n\r\n';
    expect(parseReferenceCsv(csv)).toEqual({ ok: true, ignoredColumns: 1, rows: [{ url: 'https://www.tiktok.com/@synth.a/video/7000000000000000001', views: '12.345', note: 'say "hi"; ok' }] });
    expect(csvRowToReference({ url: 'u', relevance: 'Relevant', duration_s: '30' })).toMatchObject({ url: 'u', relevance: 'relevant', durationSeconds: '30' });
    expect(parseReferenceCsv('  ')).toEqual({ ok: false, error: 'empty' });
    expect(parseReferenceCsv('views\n1')).toEqual({ ok: false, error: 'missing_url_column' });
    expect(parseReferenceCsv('url\n"open')).toEqual({ ok: false, error: 'malformed' });
    expect(parseReferenceCsv('url\n' + 'x\n'.repeat(2001))).toEqual({ ok: false, error: 'too_many_rows' });
  });
});

describe('deterministic outlier scoring', () => {
  const t = DEFAULT_THRESHOLDS;
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('scores against the creator median with a recommended baseline → outlier, high confidence', () => {
    const base = peers('synth.a', [20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000]);
    const candidate = video('synth.a', 6, metrics(100000));
    const other = video('synth.b', 6, metrics(5_000_000)); // other creators never enter the baseline
    const [a] = assessReferences([candidate, ...base, other], t, NOW);
    expect(a).toMatchObject({ verdict: 'outlier', ratio: 5, confidence: 'high', baseline: { level: 'recommended', sampleSize: 8, medianViews: 20000 }, flags: [], shortlisted: true });
    expect(a!.engagementRate).toBeCloseTo(115 / 100000);
    expect(explainAssessment(a!, 100000, t)).toBe('100k views vs this creator’s median of 20k across 8 comparable videos in the last 30 days → 5.0×, above your 3× threshold; posted 6 days ago. Confidence: high.');
  });

  it('is deterministic: same input, same output', () => {
    const vids = [video('synth.a', 6, metrics(90000)), ...peers('synth.a', [10000, 11000, 12000, 13000, 14000])];
    expect(assessReferences(vids, t, NOW)).toEqual(assessReferences(vids, t, NOW));
  });

  it('a minimum baseline still scores, with lower confidence and a note', () => {
    const [a] = assessReferences([video('synth.a', 6, metrics(60000)), ...peers('synth.a', [10000, 10000, 10000, 10000, 10000])], t, NOW);
    expect(a).toMatchObject({ verdict: 'outlier', ratio: 6, confidence: 'low', baseline: { level: 'minimum', sampleSize: 5 } });
    expect(explainAssessment(a!, 60000, t)).toContain('Baseline is below the recommended 8 videos.');
  });

  it('an insufficient baseline is unverified, never a guessed ratio; pinning keeps it for analysis', () => {
    const [a] = assessReferences([video('synth.a', 6, metrics(60000), { pinned: true }), ...peers('synth.a', [10000, 10000])], t, NOW);
    expect(a).toMatchObject({ verdict: 'unverified', ratio: null, confidence: 'low', baseline: { level: 'insufficient', sampleSize: 2, medianViews: null }, shortlisted: true });
    expect(explainAssessment(a!, 60000, t)).toContain('only 2 comparable videos');
  });

  it('baseline excludes videos without views, outside the window, or not settled', () => {
    const base = [
      ...peers('synth.a', [10000, 10000, 10000, 10000]),
      video('synth.a', 6, metrics(null)),
      video('synth.a', 45, metrics(10000)),
      video('synth.a', 1, metrics(10000)),
    ];
    const [a] = assessReferences([video('synth.a', 6, metrics(60000)), ...base], t, NOW);
    expect(a).toMatchObject({ verdict: 'unverified', baseline: { sampleSize: 4 } });
  });

  it('missing views → missing_metrics; incomplete engagement → no engagement rate', () => {
    const [a, b] = assessReferences(
      [video('synth.a', 6, metrics(null)), video('synth.a', 6, metrics(30000, { shares: null })), ...peers('synth.a', [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000])],
      t,
      NOW,
    );
    expect(a).toMatchObject({ verdict: 'missing_metrics', ratio: null, flags: expect.arrayContaining(['missing_views']) });
    expect(explainAssessment(a!, null, t)).toContain('No view count');
    expect(b).toMatchObject({ verdict: 'outlier', engagementRate: null, confidence: 'medium', flags: ['missing_engagement'] });
  });

  it.each([
    ['too_recent', video('synth.a', 1, metrics(90000))],
    ['outside_window', video('synth.a', 40, metrics(90000))],
    ['publish_date_unknown', video('synth.a', null, metrics(90000))],
    ['inconsistent_metrics', video('synth.a', 6, metrics(90000, { likes: exact(120000) }))],
    ['not_relevant', video('synth.a', 6, metrics(90000), { relevance: 'not_relevant', pinned: true })],
    ['below_min_views', video('synth.a', 6, metrics(5000))],
    ['below_threshold', video('synth.a', 6, metrics(25000))],
  ])('a failed gate (%s) makes it not an outlier and not shortlisted', (reason, candidate) => {
    const base = peers('synth.a', reason === 'below_min_views' ? [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] : [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000]);
    const [a] = assessReferences([candidate, ...base], t, NOW);
    expect(a!.verdict).toBe('not_outlier');
    expect(a!.reasons).toContain(reason);
    expect(a!.shortlisted).toBe(false);
  });

  it('rounded and stale metrics lower confidence', () => {
    const rounded = { value: 90000, exactness: 'rounded' as const };
    const base = () => peers('synth.a', [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000]);
    const [a] = assessReferences([video('synth.a', 6, metrics(null, { views: rounded })), ...base()], t, NOW);
    const [b] = assessReferences(
      [video('synth.a', 7, metrics(null, { views: rounded, observedAt: ago(20) })), video('synth.a', 9, metrics(null, { views: { value: 10000, exactness: 'rounded' } })), ...base()],
      t,
      NOW,
    );
    expect(a).toMatchObject({ verdict: 'outlier', confidence: 'medium', flags: ['rounded_metrics'] });
    expect(b).toMatchObject({ verdict: 'outlier', confidence: 'low', flags: expect.arrayContaining(['rounded_metrics', 'stale_metrics', 'baseline_includes_rounded']) });
  });

  it('editable thresholds change the verdict', () => {
    const vids = [video('synth.a', 6, metrics(40000)), ...peers('synth.a', [10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000])];
    expect(assessReferences(vids, t, NOW)[0]!.verdict).toBe('outlier');
    expect(assessReferences(vids, { ...t, outlierThreshold: 5 }, NOW)[0]!.verdict).toBe('not_outlier');
    expect(assessReferences(vids, { ...t, minimumBaseline: 9, recommendedBaseline: 10 }, NOW)[0]!.verdict).toBe('unverified');
  });
});
