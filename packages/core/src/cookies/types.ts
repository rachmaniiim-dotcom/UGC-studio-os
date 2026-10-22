import type { SecretValue } from '../redaction/secret.js';

export type SameSite = 'strict' | 'lax' | 'none' | 'unspecified';

/** CHIPS partition key, as exposed by chrome.cookies. */
export interface CookiePartitionKey {
  readonly topLevelSite: string;
  readonly hasCrossSiteAncestor?: boolean;
}

/**
 * Browser-independent cookie. `domain` is lowercase without a leading dot;
 * `hostOnly` says whether it is a host-only or a domain cookie.
 * `expiresAt` is Unix seconds, or null for a session cookie.
 */
export interface NormalizedCookie {
  readonly name: string;
  readonly value: SecretValue;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: SameSite;
  readonly expiresAt: number | null;
  readonly partitionKey?: CookiePartitionKey;
}

export type DetectedFormat =
  | 'cookie-editor-json'
  | 'cookie-editor-json-firefox'
  | 'netscape'
  | 'header-string'
  | 'json-unrecognized'
  | 'empty'
  | 'unknown';

export type FileErrorCode =
  | 'file_too_large'
  | 'not_utf8'
  | 'invalid_json'
  | 'unsupported_format'
  | 'empty'
  | 'too_many_cookies';

export type EntryIssueCode =
  | 'not_an_object'
  | 'missing_attribute'
  | 'invalid_name'
  | 'invalid_value'
  | 'cookie_too_large'
  | 'invalid_domain'
  | 'domain_out_of_scope'
  | 'inconsistent_host_only'
  | 'invalid_path'
  | 'invalid_flag'
  | 'invalid_same_site'
  | 'same_site_none_requires_secure'
  | 'invalid_expiration'
  | 'inconsistent_session'
  | 'secure_prefix_violation'
  | 'host_prefix_violation'
  | 'invalid_partition_key'
  | 'expired'
  | 'exact_duplicate'
  | 'conflicting_duplicate';

export type EntryDisposition = 'imported' | 'skipped' | 'rejected';

export interface EntryResult {
  /** Zero-based position in the source file. */
  readonly index: number;
  readonly disposition: EntryDisposition;
  readonly code?: EntryIssueCode;
}

/**
 * Non-secret import report. Contains no cookie names or values: only counts,
 * positions in the source file and reason codes.
 */
export interface ImportReport {
  readonly format: DetectedFormat;
  readonly fileError?: FileErrorCode;
  readonly examined: number;
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly reasons: Partial<Record<EntryIssueCode, number>>;
  readonly entries: readonly EntryResult[];
  /** Groups of entry indices that share one cookie identity but disagree. */
  readonly conflictingDuplicateGroups: readonly (readonly number[])[];
  readonly ignoredFieldCount: number;
  readonly messages: readonly string[];
}

export interface ImportOptions {
  /** Registrable domains this import may target, e.g. ["kalodata.com"]. */
  readonly allowedDomains: readonly string[];
  readonly now?: Date;
  readonly maxBytes?: number;
  readonly maxCookies?: number;
}

export interface ImportResult {
  readonly ok: boolean;
  readonly cookies: readonly NormalizedCookie[];
  readonly report: ImportReport;
}
