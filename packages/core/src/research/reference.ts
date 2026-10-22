/**
 * Reference videos the owner enters or imports (Gate 5, R2). Parsing is
 * offline and strict: URLs are never fetched or resolved (that would be
 * automated access), metrics are never estimated, and every rejection is a
 * code, never the input itself.
 */

export type Exactness = 'exact' | 'rounded';
export type Relevance = 'unrated' | 'relevant' | 'not_relevant';

export interface MetricValue {
  readonly value: number;
  readonly exactness: Exactness;
}

export interface ReferenceMetrics {
  readonly views: MetricValue | null;
  readonly likes: MetricValue | null;
  readonly comments: MetricValue | null;
  readonly shares: MetricValue | null;
  /** When the owner (or a provider) observed these numbers. */
  readonly observedAt: string | null;
}

export interface ReferenceVideoInput {
  readonly url: string;
  readonly platformVideoId: string;
  readonly creatorHandle: string;
  readonly publishedAt: string | null;
  readonly durationSeconds: number | null;
  readonly metrics: ReferenceMetrics;
  readonly relevance: Relevance;
  readonly note: string;
}

export type ReferenceIssue =
  | 'invalid_url'
  | 'short_link_unsupported'
  | 'invalid_creator'
  | 'creator_mismatch'
  | 'invalid_published_at'
  | 'published_in_future'
  | 'invalid_video_duration'
  | 'invalid_views'
  | 'invalid_likes'
  | 'invalid_comments'
  | 'invalid_shares'
  | 'invalid_observed_at'
  | 'invalid_relevance'
  | 'invalid_note';

const HANDLE = /^[a-z0-9._]{2,24}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Normalizes a creator handle ("@Some.User" → "some.user"), or null. */
export function normalizeHandle(raw: string): string | null {
  const h = raw.trim().replace(/^@/, '').toLowerCase();
  return HANDLE.test(h) ? h : null;
}

/**
 * Parses a full TikTok video URL (https://www.tiktok.com/@handle/video/<id>).
 * Short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…) are rejected:
 * resolving them needs a network request to TikTok.
 */
export function parseTikTokVideoUrl(raw: string): { url: string; handle: string; videoId: string } | { error: 'invalid_url' | 'short_link_unsupported' } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'invalid_url' };
  }
  const host = u.hostname.toLowerCase();
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || (/(^|\.)tiktok\.com$/.test(host) && u.pathname.startsWith('/t/'))) {
    return { error: 'short_link_unsupported' };
  }
  if (u.protocol !== 'https:' || !(host === 'tiktok.com' || host === 'www.tiktok.com' || host === 'm.tiktok.com')) return { error: 'invalid_url' };
  const m = /^\/@([^/]+)\/video\/(\d{8,25})\/?$/.exec(u.pathname);
  if (!m) return { error: 'invalid_url' };
  const handle = normalizeHandle(decodeURIComponent(m[1]!));
  if (!handle) return { error: 'invalid_url' };
  // Canonical form: no query string or fragment (they can carry tracking or session data).
  return { url: `https://www.tiktok.com/@${handle}/video/${m[2]}`, handle, videoId: m[2]! };
}

/**
 * Parses a metric as entered: "12345", "12,345", "12.345" (Indonesian
 * thousands), or display-rounded "1.2K" / "3,4M" / "1B" / "1,2 rb" / "3,4 jt".
 * Rounded values are kept as such (exactness 'rounded'), never treated as exact.
 */
export function parseMetric(raw: unknown): MetricValue | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? { value: raw, exactness: 'exact' } : 'invalid';
  if (typeof raw !== 'string') return 'invalid';
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (s === '' || s === '-' || s === 'n/a' || s === 'na') return null;
  const suffix = /^(\d+(?:[.,]\d+)?)(k|m|b|rb|jt|m(?:ily|iliar))$/.exec(s);
  if (suffix) {
    const n = Number(suffix[1]!.replace(',', '.'));
    const unit = suffix[2]!;
    const mult = unit === 'k' || unit === 'rb' ? 1e3 : unit === 'm' || unit === 'jt' ? 1e6 : 1e9;
    const value = Math.round(n * mult);
    return Number.isSafeInteger(value) ? { value, exactness: 'rounded' } : 'invalid';
  }
  if (/^\d{1,3}([.,]\d{3})+$/.test(s) || /^\d+$/.test(s)) {
    const value = Number(s.replace(/[.,]/g, ''));
    return Number.isSafeInteger(value) ? { value, exactness: 'exact' } : 'invalid';
  }
  return 'invalid';
}

function parseDate(raw: unknown): string | null | 'invalid' {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'string') return 'invalid';
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return 'invalid';
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? 'invalid' : d.toISOString();
}

/** Validates one reference (form or CSV row). Returns the normalized input or every issue. */
export function validateReference(
  raw: Record<string, unknown>,
  now: Date = new Date(),
): { ok: true; value: ReferenceVideoInput } | { ok: false; issues: ReferenceIssue[] } {
  const issues: ReferenceIssue[] = [];
  const parsed = typeof raw['url'] === 'string' ? parseTikTokVideoUrl(raw['url']) : { error: 'invalid_url' as const };
  if ('error' in parsed) issues.push(parsed.error);

  const creatorRaw = raw['creator'];
  let handle = 'error' in parsed ? null : parsed.handle;
  if (typeof creatorRaw === 'string' && creatorRaw.trim() !== '') {
    const given = normalizeHandle(creatorRaw);
    if (!given) issues.push('invalid_creator');
    else if (handle && given !== handle) issues.push('creator_mismatch');
    else handle = given;
  }

  const publishedAt = parseDate(raw['publishedAt']);
  if (publishedAt === 'invalid') issues.push('invalid_published_at');
  else if (publishedAt && new Date(publishedAt).getTime() > now.getTime() + 24 * 3600 * 1000) issues.push('published_in_future');

  let durationSeconds: number | null = null;
  const d = raw['durationSeconds'];
  if (d !== undefined && d !== null && d !== '') {
    const n = typeof d === 'number' ? d : Number(String(d).trim());
    if (!Number.isInteger(n) || n < 1 || n > 3600) issues.push('invalid_video_duration');
    else durationSeconds = n;
  }

  const metric = (key: 'views' | 'likes' | 'comments' | 'shares'): MetricValue | null => {
    const m = parseMetric(raw[key]);
    if (m === 'invalid') {
      issues.push(`invalid_${key}` as ReferenceIssue);
      return null;
    }
    return m;
  };
  const views = metric('views');
  const likes = metric('likes');
  const comments = metric('comments');
  const shares = metric('shares');
  const observedAt = parseDate(raw['observedAt']);
  if (observedAt === 'invalid') issues.push('invalid_observed_at');

  const relevance = raw['relevance'] === undefined || raw['relevance'] === '' ? 'unrated' : raw['relevance'];
  if (relevance !== 'unrated' && relevance !== 'relevant' && relevance !== 'not_relevant') issues.push('invalid_relevance');
  const note = raw['note'] === undefined ? '' : raw['note'];
  if (typeof note !== 'string' || note.length > 1000 || CONTROL.test(note)) issues.push('invalid_note');

  if (issues.length > 0 || 'error' in parsed) return { ok: false, issues };
  const anyMetric = views || likes || comments || shares;
  return {
    ok: true,
    value: {
      url: parsed.url,
      platformVideoId: parsed.videoId,
      creatorHandle: handle!,
      publishedAt: publishedAt as string | null,
      durationSeconds,
      // If metrics were given without an observation date, they were observed now.
      metrics: { views, likes, comments, shares, observedAt: (observedAt as string | null) ?? (anyMetric ? now.toISOString() : null) },
      relevance: relevance as Relevance,
      note: (note as string).trim(),
    },
  };
}

/** CSV columns the importer understands (header names, case-insensitive). */
export const CSV_COLUMNS = ['url', 'creator', 'published_at', 'views', 'likes', 'comments', 'shares', 'observed_at', 'duration_s', 'relevance', 'note'] as const;

/**
 * Parses CSV (RFC 4180: quoted fields, "" escapes, CRLF/LF; comma or
 * semicolon delimiter detected from the header). Returns rows keyed by the
 * known columns; unknown columns are counted and ignored.
 */
export function parseReferenceCsv(text: string): { ok: true; rows: Array<Record<string, string>>; ignoredColumns: number } | { ok: false; error: 'empty' | 'missing_url_column' | 'too_many_rows' | 'malformed' } {
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return { ok: false, error: 'empty' };
  const firstLine = body.split(/\r?\n/, 1)[0]!;
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += c;
  }
  if (quoted) return { ok: false, error: 'malformed' };
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ''));
  const header = (nonEmpty.shift() ?? []).map((h) => h.trim().toLowerCase());
  if (!header.includes('url')) return { ok: false, error: 'missing_url_column' };
  if (nonEmpty.length > 2000) return { ok: false, error: 'too_many_rows' };
  const known = new Set<string>(CSV_COLUMNS);
  const ignoredColumns = header.filter((h) => !known.has(h)).length;
  const rows = nonEmpty.map((r) => {
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      if (known.has(h)) row[h] = (r[i] ?? '').trim();
    });
    return row;
  });
  return { ok: true, rows, ignoredColumns };
}

/** Maps a CSV row to validateReference()'s input. */
export function csvRowToReference(row: Record<string, string>): Record<string, unknown> {
  return {
    url: row['url'],
    creator: row['creator'],
    publishedAt: row['published_at'],
    views: row['views'],
    likes: row['likes'],
    comments: row['comments'],
    shares: row['shares'],
    observedAt: row['observed_at'],
    durationSeconds: row['duration_s'],
    relevance: row['relevance'] === undefined || row['relevance'] === '' ? undefined : row['relevance'].toLowerCase(),
    note: row['note'] ?? '',
  };
}
