import { importCookieEditorExport } from '../cookies/import.js';
import type { NormalizedCookie, SameSite } from '../cookies/types.js';

/**
 * Plaintext format of a sealed session-cookie restore record (Gate 1
 * hardening prototype for R-10). The caller encrypts the text with OS-backed
 * protection before it touches disk; this module never does I/O.
 *
 * The cookies are stored in Cookie-Editor's JSON shape so that restoring
 * runs them through the same importer, and therefore the same validation,
 * as a fresh import. The record is bound to one profile and partition.
 */
export const RESTORE_PAYLOAD_VERSION = 1;

export interface RestoreBinding {
  readonly profileId: string;
  readonly partition: string;
}

export type RestoreDecodeError = 'malformed' | 'unsupported_version' | 'binding_mismatch' | 'invalid_cookies';

export type RestoreDecodeResult =
  | { readonly ok: true; readonly cookies: readonly NormalizedCookie[] }
  | { readonly ok: false; readonly code: RestoreDecodeError };

const SAME_SITE_OUT: Record<SameSite, string | null> = {
  none: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: null,
};

/** Only session cookies (no expiry) are kept; the browser persists the rest itself. */
export function restorableSessionCookies(cookies: readonly NormalizedCookie[]): NormalizedCookie[] {
  return cookies.filter((c) => c.expiresAt === null && !c.partitionKey);
}

/** Builds the plaintext record. The result contains secrets: encrypt it, never log it. */
export function encodeSessionRestore(binding: RestoreBinding, cookies: readonly NormalizedCookie[]): string {
  const entries = restorableSessionCookies(cookies).map((c) => ({
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
  }));
  return JSON.stringify({ version: RESTORE_PAYLOAD_VERSION, profileId: binding.profileId, partition: binding.partition, cookies: entries });
}

/**
 * Parses and re-validates a decrypted record. Error codes carry no content
 * from the record. Any invalid cookie rejects the whole record, so a
 * tampered or partially valid record restores nothing.
 */
export function decodeSessionRestore(text: string, expected: RestoreBinding, allowedDomains: readonly string[]): RestoreDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, code: 'malformed' };
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== RESTORE_PAYLOAD_VERSION) return { ok: false, code: 'unsupported_version' };
  if (record['profileId'] !== expected.profileId || record['partition'] !== expected.partition) {
    return { ok: false, code: 'binding_mismatch' };
  }
  const entries = record['cookies'];
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, code: 'malformed' };

  const result = importCookieEditorExport(JSON.stringify(entries), { allowedDomains });
  const clean =
    result.ok &&
    result.report.imported === entries.length &&
    result.cookies.every((c) => c.expiresAt === null && !c.partitionKey);
  return clean ? { ok: true, cookies: result.cookies } : { ok: false, code: 'invalid_cookies' };
}
