import { SecretValue } from '../redaction/secret.js';
import { detectFormat } from './detect.js';
import type {
  CookiePartitionKey,
  DetectedFormat,
  EntryIssueCode,
  EntryResult,
  FileErrorCode,
  ImportOptions,
  ImportReport,
  ImportResult,
  NormalizedCookie,
  SameSite,
} from './types.js';

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_COOKIES = 5000;
const MAX_NAME_VALUE_BYTES = 4096;
const MAX_PATH_LENGTH = 1024;

const KNOWN_FIELDS = new Set([
  'name',
  'value',
  'domain',
  'hostOnly',
  'path',
  'secure',
  'httpOnly',
  'sameSite',
  'session',
  'expirationDate',
  'storeId',
  'partitionKey',
]);
const REQUIRED_FIELDS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'hostOnly'] as const;

// Cookie-Editor's JSON export: Chromium sameSite values, with "unspecified" written as null.
const SAME_SITE_MAP: Record<string, SameSite> = {
  no_restriction: 'none',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified',
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DOMAIN_LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const DOMAIN_PATTERN = new RegExp(`^${DOMAIN_LABEL}(\\.${DOMAIN_LABEL})+$`);
const PARTITION_SITE = /^https:\/\/[a-z0-9.-]+$/;

type Parsed = { readonly cookie: NormalizedCookie; readonly ignoredFields: number } | { readonly code: EntryIssueCode };

function normalizeAllowedDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./, '');
}

/** True if `domain` equals or is a subdomain of one of the allowed domains. */
export function isDomainInScope(domain: string, allowed: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return allowed.some((a) => d === a || d.endsWith(`.${a}`));
}

function parseEntry(raw: unknown, allowed: readonly string[]): Parsed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { code: 'not_an_object' };
  const has = (key: string): boolean => Object.hasOwn(raw, key);
  const get = (key: string): unknown => (has(key) ? (raw as Record<string, unknown>)[key] : undefined);

  for (const field of REQUIRED_FIELDS) {
    if (!has(field)) return { code: 'missing_attribute' };
  }

  const name = get('name');
  if (typeof name !== 'string' || name.length === 0 || name !== name.trim() || CONTROL_CHARS.test(name) || /[;=]/.test(name)) {
    return { code: 'invalid_name' };
  }
  const value = get('value');
  if (typeof value !== 'string' || CONTROL_CHARS.test(value) || value.includes(';')) {
    return { code: 'invalid_value' };
  }
  if (new TextEncoder().encode(name + value).length > MAX_NAME_VALUE_BYTES) return { code: 'cookie_too_large' };

  const secure = get('secure');
  const httpOnly = get('httpOnly');
  const hostOnly = get('hostOnly');
  const session = get('session');
  if (typeof secure !== 'boolean' || typeof httpOnly !== 'boolean' || typeof hostOnly !== 'boolean') {
    return { code: 'invalid_flag' };
  }
  if (session !== undefined && typeof session !== 'boolean') return { code: 'invalid_flag' };

  const rawDomain = get('domain');
  if (typeof rawDomain !== 'string') return { code: 'invalid_domain' };
  let domain = rawDomain.toLowerCase();
  if (domain.startsWith('.')) {
    if (hostOnly) return { code: 'inconsistent_host_only' };
    domain = domain.slice(1);
  }
  if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) return { code: 'invalid_domain' };
  if (!isDomainInScope(domain, allowed)) return { code: 'domain_out_of_scope' };

  const path = get('path');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LENGTH || CONTROL_CHARS.test(path) || path.includes(';')) {
    return { code: 'invalid_path' };
  }

  const rawSameSite = get('sameSite');
  let sameSite: SameSite;
  if (rawSameSite === undefined || rawSameSite === null) {
    sameSite = 'unspecified';
  } else if (typeof rawSameSite === 'string' && Object.hasOwn(SAME_SITE_MAP, rawSameSite)) {
    sameSite = SAME_SITE_MAP[rawSameSite] as SameSite;
  } else {
    return { code: 'invalid_same_site' };
  }

  const rawExpiration = get('expirationDate');
  let expiresAt: number | null = null;
  if (rawExpiration !== undefined && rawExpiration !== null) {
    if (typeof rawExpiration !== 'number' || !Number.isFinite(rawExpiration) || rawExpiration <= 0) {
      return { code: 'invalid_expiration' };
    }
    expiresAt = rawExpiration;
  }
  if ((session === true && expiresAt !== null) || (session === false && expiresAt === null)) {
    return { code: 'inconsistent_session' };
  }

  // Never "fix" security attributes: an inconsistent cookie is rejected.
  if (sameSite === 'none' && !secure) return { code: 'same_site_none_requires_secure' };
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith('__secure-') && !secure) return { code: 'secure_prefix_violation' };
  if (lowerName.startsWith('__host-') && (!secure || !hostOnly || path !== '/')) {
    return { code: 'host_prefix_violation' };
  }

  const rawPartition = get('partitionKey');
  let partitionKey: CookiePartitionKey | undefined;
  if (rawPartition !== undefined && rawPartition !== null) {
    if (typeof rawPartition !== 'object' || Array.isArray(rawPartition)) return { code: 'invalid_partition_key' };
    const site = Object.hasOwn(rawPartition, 'topLevelSite') ? (rawPartition as Record<string, unknown>)['topLevelSite'] : undefined;
    const ancestor = Object.hasOwn(rawPartition, 'hasCrossSiteAncestor')
      ? (rawPartition as Record<string, unknown>)['hasCrossSiteAncestor']
      : undefined;
    if (typeof site !== 'string' || !PARTITION_SITE.test(site) || (ancestor !== undefined && typeof ancestor !== 'boolean') || !secure) {
      return { code: 'invalid_partition_key' };
    }
    partitionKey = ancestor === undefined ? { topLevelSite: site } : { topLevelSite: site, hasCrossSiteAncestor: ancestor };
  }

  const ignoredFields = Object.keys(raw).filter((k) => !KNOWN_FIELDS.has(k)).length;
  const cookie: NormalizedCookie = {
    name,
    value: new SecretValue(value),
    domain,
    hostOnly,
    path,
    secure,
    httpOnly,
    sameSite,
    expiresAt,
    ...(partitionKey ? { partitionKey } : {}),
  };
  return { cookie, ignoredFields };
}

/** Cookies with equal identity overwrite each other in a browser's cookie jar. */
export function cookieIdentity(c: NormalizedCookie): string {
  return JSON.stringify([
    c.name,
    c.domain,
    c.hostOnly,
    c.path,
    c.partitionKey?.topLevelSite ?? null,
    c.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);
}

function sameContent(a: NormalizedCookie, b: NormalizedCookie): boolean {
  return (
    a.value.equals(b.value) &&
    a.secure === b.secure &&
    a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite &&
    a.expiresAt === b.expiresAt
  );
}

const FORMAT_MESSAGES: Partial<Record<DetectedFormat | 'invalid_json', string>> = {
  'cookie-editor-json-firefox':
    'This looks like a Cookie-Editor export from Firefox. Only the Chrome export is supported in this build.',
  netscape: 'This is a Netscape cookies.txt export. Use the Cookie-Editor "JSON" export instead; Netscape files lose SameSite and session information.',
  'header-string': 'This is a header-string export. Use the Cookie-Editor "JSON" export instead; header strings carry no domain, path or security flags.',
  'json-unrecognized': 'The file is JSON but not a Cookie-Editor cookie list.',
  unknown: 'The file is not a recognized Cookie-Editor export.',
  invalid_json: 'The file is not valid JSON.',
  empty: 'The file contains no cookies.',
};

function fileFailure(format: DetectedFormat, fileError: FileErrorCode, message: string): ImportResult {
  return {
    ok: false,
    cookies: [],
    report: {
      format,
      fileError,
      examined: 0,
      imported: 0,
      skipped: 0,
      rejected: 0,
      reasons: {},
      entries: [],
      conflictingDuplicateGroups: [],
      ignoredFieldCount: 0,
      messages: [message],
    },
  };
}

/** Result for a file the caller refused to read because of its size. */
export function oversizedFileResult(maxBytes = DEFAULT_MAX_BYTES): ImportResult {
  return fileFailure('unknown', 'file_too_large', `The file is larger than ${maxBytes} bytes.`);
}

/**
 * Validates and normalizes a Cookie-Editor JSON export for one target site.
 * Returns normalized cookies plus a report that never contains cookie
 * names or values.
 */
export function importCookieEditorExport(input: string | Uint8Array, options: ImportOptions): ImportResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxCookies = options.maxCookies ?? DEFAULT_MAX_COOKIES;
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  const allowed = options.allowedDomains.map(normalizeAllowedDomain).filter((d) => d.length > 0);
  if (allowed.length === 0) throw new Error('importCookieEditorExport requires at least one allowed domain');

  let text: string;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > maxBytes) return oversizedFileResult(maxBytes);
    text = input;
  } else {
    if (input.byteLength > maxBytes) return oversizedFileResult(maxBytes);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      return fileFailure('unknown', 'not_utf8', 'The file is not UTF-8 text.');
    }
  }
  text = text.replace(/^﻿/, '');

  const detection = detectFormat(text);
  if (detection.format === 'invalid_json') {
    return fileFailure('unknown', 'invalid_json', FORMAT_MESSAGES.invalid_json as string);
  }
  if (detection.format === 'empty') return fileFailure('empty', 'empty', FORMAT_MESSAGES.empty as string);
  if (!('entries' in detection) || detection.format !== 'cookie-editor-json') {
    return fileFailure(detection.format, 'unsupported_format', FORMAT_MESSAGES[detection.format] ?? 'Unsupported format.');
  }
  if (detection.entries.length > maxCookies) {
    return fileFailure(detection.format, 'too_many_cookies', `The file has more than ${maxCookies} cookies.`);
  }

  const results = new Map<number, EntryResult>();
  const candidates: Array<{ index: number; cookie: NormalizedCookie }> = [];
  let ignoredFieldCount = 0;

  detection.entries.forEach((raw, index) => {
    const parsed = parseEntry(raw, allowed);
    if ('code' in parsed) {
      results.set(index, { index, disposition: 'rejected', code: parsed.code });
      return;
    }
    ignoredFieldCount += parsed.ignoredFields;
    if (parsed.cookie.expiresAt !== null && parsed.cookie.expiresAt <= nowSeconds) {
      results.set(index, { index, disposition: 'skipped', code: 'expired' });
      return;
    }
    candidates.push({ index, cookie: parsed.cookie });
  });

  // Duplicate policy: identical copies collapse to one; copies that disagree
  // are all rejected, because picking one would be a guess.
  const groups = new Map<string, Array<{ index: number; cookie: NormalizedCookie }>>();
  for (const candidate of candidates) {
    const key = cookieIdentity(candidate.cookie);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const cookies: NormalizedCookie[] = [];
  const conflictingDuplicateGroups: number[][] = [];
  const messages: string[] = [];
  for (const group of groups.values()) {
    const [first, ...rest] = group as [(typeof group)[number], ...typeof group];
    if (rest.every((other) => sameContent(first.cookie, other.cookie))) {
      cookies.push(first.cookie);
      results.set(first.index, { index: first.index, disposition: 'imported' });
      for (const other of rest) results.set(other.index, { index: other.index, disposition: 'skipped', code: 'exact_duplicate' });
    } else {
      const indices = group.map((g) => g.index);
      conflictingDuplicateGroups.push(indices);
      for (const index of indices) results.set(index, { index, disposition: 'rejected', code: 'conflicting_duplicate' });
      messages.push(
        `Entries ${indices.map((i) => `#${i + 1}`).join(', ')} describe the same cookie (same name, domain, path, ` +
          'host-only flag and partition) but have different values or attributes. All of them were rejected. ' +
          'Export the cookies again from the browser.',
      );
    }
  }

  const entries = [...results.values()].sort((a, b) => a.index - b.index);
  const reasons: Partial<Record<EntryIssueCode, number>> = {};
  for (const entry of entries) {
    if (entry.code) reasons[entry.code] = (reasons[entry.code] ?? 0) + 1;
  }
  const count = (d: EntryResult['disposition']): number => entries.filter((e) => e.disposition === d).length;
  if (cookies.length === 0) messages.push('No cookies could be imported.');

  return {
    ok: cookies.length > 0,
    cookies,
    report: {
      format: detection.format,
      examined: detection.entries.length,
      imported: count('imported'),
      skipped: count('skipped'),
      rejected: count('rejected'),
      reasons,
      entries,
      conflictingDuplicateGroups,
      ignoredFieldCount,
      messages,
    },
  };
}
