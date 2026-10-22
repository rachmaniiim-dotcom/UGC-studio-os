import { importCookieEditorExport } from '../cookies/import.js';
import type { NormalizedCookie, SameSite } from '../cookies/types.js';

/**
 * Plaintext formats for a profile's sealed session-cookie snapshot and its
 * revision record (R-10 / C1). The caller encrypts both with OS-backed
 * protection before they touch disk; this module never does I/O.
 *
 * Snapshot cookies are stored in Cookie-Editor's JSON shape so that restoring
 * runs them through the same importer, and so the same validation, as a fresh
 * import. Both records are bound to one profile, partition and platform.
 */
export const RESTORE_PAYLOAD_VERSION = 2;
export const REVISION_RECORD_VERSION = 1;

export interface RestoreBinding {
  readonly profileId: string;
  readonly partition: string;
  readonly platformId: string;
}

export type RestoreDecodeError = 'malformed' | 'unsupported_version' | 'binding_mismatch' | 'invalid_cookies' | 'invalid_revision';

export type RestoreDecodeResult =
  | { readonly ok: true; readonly revision: number; readonly cookies: readonly NormalizedCookie[] }
  | { readonly ok: false; readonly code: RestoreDecodeError };

export type RevisionDecodeResult =
  | { readonly ok: true; readonly revision: number; readonly count: number }
  | { readonly ok: false; readonly code: RestoreDecodeError };

const SAME_SITE_OUT: Record<SameSite, string | null> = {
  none: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: null,
};

const isRevision = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

function toEntry(c: NormalizedCookie): Record<string, unknown> {
  return {
    name: c.name,
    value: c.value.reveal(),
    domain: c.hostOnly ? c.domain : `.${c.domain}`,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: SAME_SITE_OUT[c.sameSite],
    session: true,
    storeId: null,
  };
}

/**
 * Keeps the session cookies (no expiry, not partitioned) that would pass the
 * importer's validation inside `allowedDomains`, so a sealed snapshot always
 * restores. `dropped` counts session cookies left out.
 */
export function restorableSessionCookies(
  cookies: readonly NormalizedCookie[],
  allowedDomains: readonly string[],
): { cookies: NormalizedCookie[]; dropped: number } {
  const session = cookies.filter((c) => c.expiresAt === null);
  const candidates = session.filter((c) => !c.partitionKey);
  if (candidates.length === 0) return { cookies: [], dropped: session.length };
  const result = importCookieEditorExport(JSON.stringify(candidates.map(toEntry)), { allowedDomains });
  const kept = result.cookies.filter((c) => c.expiresAt === null && !c.partitionKey);
  return { cookies: kept, dropped: session.length - kept.length };
}

/** Builds the snapshot plaintext. Contains secrets: encrypt it, never log it. */
export function encodeSessionRestore(binding: RestoreBinding, revision: number, cookies: readonly NormalizedCookie[]): string {
  if (!isRevision(revision)) throw new Error('invalid revision');
  return JSON.stringify({ version: RESTORE_PAYLOAD_VERSION, ...pickBinding(binding), revision, cookies: cookies.map(toEntry) });
}

/** Builds the revision record plaintext (no secrets, but sealed so it can't be edited unnoticed). */
export function encodeRevisionRecord(binding: RestoreBinding, revision: number, count: number): string {
  if (!isRevision(revision) || !Number.isSafeInteger(count) || count < 0) throw new Error('invalid revision record');
  return JSON.stringify({ version: REVISION_RECORD_VERSION, kind: 'session-revision', ...pickBinding(binding), revision, count });
}

function pickBinding(b: RestoreBinding): RestoreBinding {
  return { profileId: b.profileId, partition: b.partition, platformId: b.platformId };
}

function parseBound(text: string, version: number, expected: RestoreBinding): Record<string, unknown> | RestoreDecodeError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'malformed';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'malformed';
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== version) return 'unsupported_version';
  if (record['profileId'] !== expected.profileId || record['partition'] !== expected.partition || record['platformId'] !== expected.platformId) {
    return 'binding_mismatch';
  }
  if (!isRevision(record['revision'])) return 'invalid_revision';
  return record;
}

/**
 * Parses and re-validates a decrypted snapshot. Error codes carry no content
 * from the record. Any invalid cookie rejects the whole record, so a
 * tampered or partially valid record restores nothing.
 */
export function decodeSessionRestore(text: string, expected: RestoreBinding, allowedDomains: readonly string[]): RestoreDecodeResult {
  const record = parseBound(text, RESTORE_PAYLOAD_VERSION, expected);
  if (typeof record === 'string') return { ok: false, code: record };
  const entries = record['cookies'];
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, code: 'malformed' };

  const result = importCookieEditorExport(JSON.stringify(entries), { allowedDomains });
  const clean =
    result.ok && result.report.imported === entries.length && result.cookies.every((c) => c.expiresAt === null && !c.partitionKey);
  return clean ? { ok: true, revision: record['revision'] as number, cookies: result.cookies } : { ok: false, code: 'invalid_cookies' };
}

export function decodeRevisionRecord(text: string, expected: RestoreBinding): RevisionDecodeResult {
  const record = parseBound(text, REVISION_RECORD_VERSION, expected);
  if (typeof record === 'string') return { ok: false, code: record };
  const count = record['count'];
  if (record['kind'] !== 'session-revision' || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return { ok: false, code: 'malformed' };
  }
  return { ok: true, revision: record['revision'] as number, count };
}
