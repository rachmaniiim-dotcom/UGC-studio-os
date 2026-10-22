import type { ResearchThresholds } from '../growth/strategy.js';
import type { ReferenceMetrics, Relevance } from './reference.js';

/**
 * Deterministic outlier scoring (Gate 5, R2). A candidate's views are compared
 * with the MEDIAN views of the same creator's other settled videos inside the
 * research window. Nothing is estimated: a missing metric is a flag, a small
 * sample is an "unverified" score, and every conclusion has reason codes.
 */

export interface ScoredVideo {
  readonly id: string;
  readonly creatorHandle: string;
  readonly publishedAt: string | null;
  readonly metrics: ReferenceMetrics;
  readonly relevance: Relevance;
  readonly pinned: boolean;
}

export type QualityFlag =
  | 'missing_views'
  | 'missing_engagement'
  | 'missing_published_at'
  | 'rounded_metrics'
  | 'stale_metrics'
  | 'inconsistent_metrics'
  | 'too_recent'
  | 'outside_window'
  | 'baseline_includes_rounded';

export type BaselineLevel = 'recommended' | 'minimum' | 'insufficient';
export type Confidence = 'high' | 'medium' | 'low';

export type Verdict =
  /** Scored and above the threshold, with every gate passed. */
  | 'outlier'
  /** Scored, but below the threshold or a gate failed (too recent, low views, outside window, not relevant). */
  | 'not_outlier'
  /** No usable baseline (fewer than the minimum comparable videos): ratio not computed. Qualitative analysis still allowed. */
  | 'unverified'
  /** The candidate has no view count: nothing can be scored. */
  | 'missing_metrics';

export interface Baseline {
  readonly level: BaselineLevel;
  readonly sampleSize: number;
  readonly medianViews: number | null;
}

export interface Assessment {
  readonly videoId: string;
  readonly verdict: Verdict;
  readonly ratio: number | null;
  readonly ageDays: number | null;
  readonly baseline: Baseline;
  readonly engagementRate: number | null;
  readonly confidence: Confidence;
  readonly flags: readonly QualityFlag[];
  /** Why the verdict is what it is, as codes (rendered by explainAssessment). */
  readonly reasons: readonly string[];
  readonly shortlisted: boolean;
}

const DAY = 24 * 3600 * 1000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const ageDays = (publishedAt: string | null, now: Date): number | null =>
  publishedAt ? Math.floor((now.getTime() - new Date(publishedAt).getTime()) / DAY) : null;

/** Scores every video against its creator's baseline. Pure: same input, same output. */
export function assessReferences(videos: readonly ScoredVideo[], t: ResearchThresholds, now: Date = new Date()): Assessment[] {
  const inWindow = (v: ScoredVideo): boolean => {
    const age = ageDays(v.publishedAt, now);
    return age !== null && age <= t.windowDays;
  };
  return videos.map((v) => {
    const flags = new Set<QualityFlag>();
    const reasons: string[] = [];
    const age = ageDays(v.publishedAt, now);
    const m = v.metrics;

    // Baseline: same creator, other videos, published inside the window, settled, with views.
    const peers = videos.filter(
      (p) => p.id !== v.id && p.creatorHandle === v.creatorHandle && p.metrics.views !== null && inWindow(p) && (ageDays(p.publishedAt, now) ?? 0) >= t.settleDays,
    );
    const sampleSize = peers.length;
    const level: BaselineLevel = sampleSize >= t.recommendedBaseline ? 'recommended' : sampleSize >= t.minimumBaseline ? 'minimum' : 'insufficient';
    const medianViews = level === 'insufficient' ? null : median(peers.map((p) => p.metrics.views!.value));
    if (level !== 'insufficient' && peers.some((p) => p.metrics.views!.exactness === 'rounded')) flags.add('baseline_includes_rounded');

    if (!m.views) flags.add('missing_views');
    if (!m.likes || !m.comments || !m.shares) flags.add('missing_engagement');
    if (!v.publishedAt) flags.add('missing_published_at');
    if ([m.views, m.likes, m.comments, m.shares].some((x) => x?.exactness === 'rounded')) flags.add('rounded_metrics');
    if (m.observedAt && now.getTime() - new Date(m.observedAt).getTime() > t.staleDays * DAY) flags.add('stale_metrics');
    if (m.views && [m.likes, m.comments, m.shares].some((x) => x && x.value > m.views!.value)) flags.add('inconsistent_metrics');
    if (age !== null && age < t.settleDays) flags.add('too_recent');
    if (age !== null && age > t.windowDays) flags.add('outside_window');

    const engagementRate = m.views && m.views.value > 0 && m.likes && m.comments && m.shares ? (m.likes.value + m.comments.value + m.shares.value) / m.views.value : null;

    let verdict: Verdict;
    let ratio: number | null = null;
    if (!m.views) {
      verdict = 'missing_metrics';
      reasons.push('no_view_count');
    } else if (medianViews === null || medianViews === 0) {
      verdict = 'unverified';
      reasons.push(medianViews === 0 ? 'baseline_median_zero' : 'insufficient_baseline');
    } else {
      ratio = m.views.value / medianViews;
      const gates: string[] = [];
      if (ratio < t.outlierThreshold) gates.push('below_threshold');
      if (m.views.value < t.minViews) gates.push('below_min_views');
      if (flags.has('too_recent')) gates.push('too_recent');
      if (flags.has('outside_window')) gates.push('outside_window');
      if (flags.has('missing_published_at')) gates.push('publish_date_unknown');
      if (flags.has('inconsistent_metrics')) gates.push('inconsistent_metrics');
      if (v.relevance === 'not_relevant') gates.push('not_relevant');
      verdict = gates.length === 0 ? 'outlier' : 'not_outlier';
      reasons.push(...(gates.length === 0 ? ['above_threshold'] : gates));
    }

    // Confidence: only meaningful for a computed ratio; each data problem lowers it.
    let confidence: Confidence = 'low';
    if (ratio !== null) {
      const problems = ['rounded_metrics', 'baseline_includes_rounded', 'stale_metrics', 'missing_engagement'].filter((f) => flags.has(f as QualityFlag)).length;
      confidence = level === 'recommended' && problems === 0 ? 'high' : level === 'recommended' && problems === 1 ? 'medium' : 'low';
    }

    const shortlisted = v.relevance !== 'not_relevant' && (verdict === 'outlier' || v.pinned);
    return { videoId: v.id, verdict, ratio, ageDays: age, baseline: { level, sampleSize, medianViews }, engagementRate, confidence, flags: [...flags], reasons, shortlisted };
  });
}

const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

const REASON_TEXT: Record<string, string> = {
  below_threshold: 'below your outlier threshold',
  below_min_views: 'fewer views than your minimum',
  too_recent: 'too recent to judge (views still settling)',
  outside_window: 'published outside your research window',
  publish_date_unknown: 'publication date unknown',
  inconsistent_metrics: 'metrics are inconsistent (e.g. more likes than views)',
  not_relevant: 'marked not relevant to the niche',
};

const FLAG_TEXT: Record<QualityFlag, string> = {
  missing_views: 'no view count',
  missing_engagement: 'likes/comments/shares incomplete',
  missing_published_at: 'no publication date',
  rounded_metrics: 'display-rounded numbers',
  stale_metrics: 'metrics observed a while ago',
  inconsistent_metrics: 'inconsistent metrics',
  too_recent: 'too recent',
  outside_window: 'outside the research window',
  baseline_includes_rounded: 'baseline uses rounded numbers',
};

export const describeFlag = (f: QualityFlag): string => FLAG_TEXT[f];

/** One plain sentence explaining the verdict, built only from the assessment's numbers and codes. */
export function explainAssessment(a: Assessment, views: number | null, t: ResearchThresholds): string {
  const sample = `${a.baseline.sampleSize} comparable video${a.baseline.sampleSize === 1 ? '' : 's'}`;
  const age = a.ageDays === null ? 'publication date unknown' : `posted ${a.ageDays} day${a.ageDays === 1 ? '' : 's'} ago`;
  switch (a.verdict) {
    case 'missing_metrics':
      return 'No view count entered, so it can’t be scored. Add the views you see on TikTok.';
    case 'unverified':
      return a.reasons.includes('baseline_median_zero')
        ? `Unverified: this creator’s comparable videos have a median of 0 views, so no ratio can be computed.`
        : `Unverified: only ${sample} from this creator in the last ${t.windowDays} days (at least ${t.minimumBaseline} needed, ${t.recommendedBaseline} recommended). Add more of their videos to score it. You can still pin it for creative analysis.`;
    default: {
      const head = `${fmt(views!)} views vs this creator’s median of ${fmt(a.baseline.medianViews!)} across ${sample} in the last ${t.windowDays} days → ${a.ratio!.toFixed(1)}×`;
      const tail = a.verdict === 'outlier' ? `, above your ${t.outlierThreshold}× threshold; ${age}` : `; not an outlier: ${a.reasons.map((r) => REASON_TEXT[r] ?? r).join(', ')}; ${age}`;
      const sampleNote = a.baseline.level === 'minimum' ? ` Baseline is below the recommended ${t.recommendedBaseline} videos.` : '';
      return `${head}${tail}. Confidence: ${a.confidence}.${sampleNote}`;
    }
  }
}
