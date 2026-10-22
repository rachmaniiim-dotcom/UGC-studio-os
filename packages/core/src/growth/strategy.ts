/**
 * Account Growth strategy (Gate 5, R1): who the account is for and the
 * research thresholds used to score reference videos. Owner content; never
 * logged.
 */

export interface ResearchThresholds {
  /** A video qualifies when its views are at least this multiple of the creator's median. */
  readonly outlierThreshold: number;
  /** Only videos published within this many days count (candidates and baseline). */
  readonly windowDays: number;
  /** Baseline sample size for a normal-confidence score. */
  readonly recommendedBaseline: number;
  /** Below this, the score is unverified (no baseline). */
  readonly minimumBaseline: number;
  /** Videos younger than this haven't settled: never promoted, excluded from baselines. */
  readonly settleDays: number;
  /** Minimum views for a candidate to qualify. */
  readonly minViews: number;
  /** Metrics observed longer ago than this are flagged stale. */
  readonly staleDays: number;
}

export interface GrowthStrategy {
  readonly niche: string;
  readonly subNiches: readonly string[];
  readonly audience: string;
  readonly region: string;
  readonly language: string;
  readonly desiredFollowers: string;
  readonly followReasons: readonly string[];
  readonly styleConstraints: string;
  readonly dailyConcepts: number;
  readonly dailyVideos: number;
  readonly thresholds: ResearchThresholds;
}

export const DEFAULT_THRESHOLDS: ResearchThresholds = {
  outlierThreshold: 3,
  windowDays: 30,
  recommendedBaseline: 8,
  minimumBaseline: 5,
  settleDays: 3,
  minViews: 10_000,
  staleDays: 7,
};

export const EMPTY_STRATEGY: GrowthStrategy = {
  niche: '',
  subNiches: [],
  audience: '',
  region: 'ID',
  language: 'id',
  desiredFollowers: '',
  followReasons: [],
  styleConstraints: '',
  dailyConcepts: 3,
  dailyVideos: 1,
  thresholds: DEFAULT_THRESHOLDS,
};

export type StrategyIssue =
  | 'invalid_niche'
  | 'invalid_text'
  | 'invalid_list'
  | 'invalid_daily_targets'
  | 'invalid_outlier_threshold'
  | 'invalid_window'
  | 'invalid_baseline'
  | 'invalid_settle_days'
  | 'invalid_min_views'
  | 'invalid_stale_days';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max && !CONTROL.test(v) ? v.trim() : null);
const list = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 120 && !CONTROL.test(x))
    ? v.map((x: string) => x.trim())
    : null;
const int = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);

export function validateStrategy(raw: unknown): { ok: true; value: GrowthStrategy } | { ok: false; issues: StrategyIssue[] } {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const t = (typeof r['thresholds'] === 'object' && r['thresholds'] !== null ? r['thresholds'] : {}) as Record<string, unknown>;
  const issues = new Set<StrategyIssue>();

  const niche = text(r['niche'], 120);
  if (!niche) issues.add('invalid_niche');
  const fields = { audience: text(r['audience'], 500), region: text(r['region'], 40), language: text(r['language'], 40), desiredFollowers: text(r['desiredFollowers'], 500), styleConstraints: text(r['styleConstraints'], 2000) };
  if (Object.values(fields).some((v) => v === null)) issues.add('invalid_text');
  const subNiches = list(r['subNiches']);
  const followReasons = list(r['followReasons']);
  if (!subNiches || !followReasons) issues.add('invalid_list');
  const dailyConcepts = int(r['dailyConcepts'], 0, 50);
  const dailyVideos = int(r['dailyVideos'], 0, 20);
  if (dailyConcepts === null || dailyVideos === null) issues.add('invalid_daily_targets');

  const threshold = t['outlierThreshold'];
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 1.5 || threshold > 100) issues.add('invalid_outlier_threshold');
  const windowDays = int(t['windowDays'], 7, 365);
  if (windowDays === null) issues.add('invalid_window');
  const recommended = int(t['recommendedBaseline'], 3, 100);
  const minimum = int(t['minimumBaseline'], 3, 100);
  if (recommended === null || minimum === null || minimum > recommended) issues.add('invalid_baseline');
  const settleDays = int(t['settleDays'], 0, 30);
  if (settleDays === null) issues.add('invalid_settle_days');
  const minViews = int(t['minViews'], 0, 1_000_000_000);
  if (minViews === null) issues.add('invalid_min_views');
  const staleDays = int(t['staleDays'], 1, 90);
  if (staleDays === null) issues.add('invalid_stale_days');

  if (issues.size > 0) return { ok: false, issues: [...issues] };
  return {
    ok: true,
    value: {
      niche: niche!,
      subNiches: subNiches!,
      audience: fields.audience!,
      region: fields.region!,
      language: fields.language!,
      desiredFollowers: fields.desiredFollowers!,
      followReasons: followReasons!,
      styleConstraints: fields.styleConstraints!,
      dailyConcepts: dailyConcepts!,
      dailyVideos: dailyVideos!,
      thresholds: {
        outlierThreshold: threshold as number,
        windowDays: windowDays!,
        recommendedBaseline: recommended!,
        minimumBaseline: minimum!,
        settleDays: settleDays!,
        minViews: minViews!,
        staleDays: staleDays!,
      },
    },
  };
}
