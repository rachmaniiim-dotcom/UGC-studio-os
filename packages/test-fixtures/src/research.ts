/**
 * Synthetic research data for Gate 5 (R1/R2). Every handle starts with
 * "synth." and every video id with 7000000000; nothing here describes a real
 * creator or a real video. Dates are relative to `now` so the scores are
 * stable whenever the tests run.
 */

const DAY = 24 * 3600 * 1000;
const date = (now: Date, daysAgo: number): string => new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);

/** A synthetic video id: 19 digits, unique per n. */
export const syntheticVideoId = (n: number): string => `70000000000${String(n).padStart(8, '0')}`;
export const syntheticVideoUrl = (handle: string, n: number): string => `https://www.tiktok.com/@${handle}/video/${syntheticVideoId(n)}`;

type Row = { n: number; creator: string; daysAgo: number | null; views: string; likes?: string; comments?: string; shares?: string; observedDaysAgo?: number; relevance?: string; note?: string; rawUrl?: string };

/** What each scenario row is expected to score as (with the default thresholds). */
export const SYNTHETIC_EXPECTATIONS = {
  /** synth.kitchen.lab: 9 settled peers (recommended baseline), exact numbers → 7.5× outlier, high confidence. */
  strongOutlier: { n: 10, verdict: 'outlier', confidence: 'high' },
  /** synth.clean.daily: 6 settled peers (minimum baseline), rounded views → outlier, low confidence. */
  roundedOutlier: { n: 26, verdict: 'outlier', confidence: 'low' },
  /** synth.kitchen.lab, posted 1 day ago: big ratio but views still settling. */
  tooRecent: { n: 11, verdict: 'not_outlier', reason: 'too_recent' },
  /** synth.kitchen.lab: an outlier the owner marked not relevant to the niche. */
  notRelevant: { n: 12, verdict: 'not_outlier', reason: 'not_relevant' },
  /** synth.kitchen.lab: ordinary video, around the median. */
  ordinary: { n: 1, verdict: 'not_outlier', reason: 'below_threshold' },
  /** synth.new.creator: only 2 videos → unverified (insufficient baseline). */
  unverified: { n: 40, verdict: 'unverified' },
  /** synth.new.creator: no view count → missing metrics. */
  missingViews: { n: 42, verdict: 'missing_metrics' },
  /** synth.clean.daily: more likes than views. */
  inconsistent: { n: 27, verdict: 'not_outlier', reason: 'inconsistent_metrics' },
} as const;

/** Rows the importer must reject (short link, unreadable number). */
export const SYNTHETIC_REJECTED_ROWS = 2;

function rows(): Row[] {
  const k = 'synth.kitchen.lab';
  const c = 'synth.clean.daily';
  const nw = 'synth.new.creator';
  const kitchenPeers = [18000, 21000, 19500, 22000, 20000, 17500, 23000, 20500, 19000];
  const cleanPeers = [11000, 12500, 12000, 13000, 11500, 12200];
  return [
    ...kitchenPeers.map((v, i) => ({ n: i + 1, creator: k, daysAgo: 5 + i * 2, views: String(v), likes: String(Math.round(v * 0.06)), comments: String(Math.round(v * 0.004)), shares: String(Math.round(v * 0.002)) })),
    { n: 10, creator: k, daysAgo: 6, views: '150000', likes: '13200', comments: '640', shares: '910', relevance: 'relevant', note: 'Synthetic: before/after reveal hook' },
    { n: 11, creator: k, daysAgo: 1, views: '210000', likes: '15000', comments: '700', shares: '800' },
    { n: 12, creator: k, daysAgo: 8, views: '160000', likes: '9000', comments: '300', shares: '200', relevance: 'not_relevant', note: 'Synthetic: off-niche trend' },
    ...cleanPeers.map((v, i) => ({ n: 20 + i, creator: c, daysAgo: 4 + i * 3, views: String(v), likes: String(Math.round(v * 0.05)), comments: String(Math.round(v * 0.003)), shares: String(Math.round(v * 0.001)) })),
    { n: 26, creator: c, daysAgo: 7, views: '52K', likes: '3,1K', comments: '120', shares: '75' },
    { n: 27, creator: c, daysAgo: 9, views: '9000', likes: '12000', comments: '40', shares: '10' },
    { n: 40, creator: nw, daysAgo: 6, views: '90000', likes: '4000', comments: '100', shares: '50' },
    { n: 41, creator: nw, daysAgo: 10, views: '15000' },
    { n: 42, creator: nw, daysAgo: 12, views: '', likes: '800' },
    { n: 90, creator: k, daysAgo: 3, views: '1000', rawUrl: 'https://vm.tiktok.com/ZSynth01/' },
    { n: 91, creator: c, daysAgo: 3, views: 'lots' },
  ];
}

const cell = (v: string): string => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The synthetic dataset as a CSV in the importer's template format. */
export function syntheticReferenceCsv(now: Date = new Date()): string {
  const header = ['url', 'creator', 'published_at', 'views', 'likes', 'comments', 'shares', 'observed_at', 'relevance', 'note'];
  const lines = rows().map((r) =>
    [
      r.rawUrl ?? syntheticVideoUrl(r.creator, r.n),
      r.creator,
      r.daysAgo === null ? '' : date(now, r.daysAgo),
      r.views,
      r.likes ?? '',
      r.comments ?? '',
      r.shares ?? '',
      date(now, r.observedDaysAgo ?? 0),
      r.relevance ?? '',
      r.note ?? '',
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

/** Number of rows in the synthetic CSV (excluding the header). */
export const SYNTHETIC_ROW_COUNT = rows().length;
