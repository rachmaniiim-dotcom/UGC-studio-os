import type { DetectedFormat } from './types.js';

export type Detection =
  | { readonly format: 'cookie-editor-json' | 'cookie-editor-json-firefox'; readonly entries: readonly unknown[] }
  | { readonly format: Exclude<DetectedFormat, 'cookie-editor-json' | 'cookie-editor-json-firefox'> }
  | { readonly format: 'invalid_json' };

const HEADER_STRING = /^[^=;\s]+=[^;\r\n]*(;\s*[^=;\s]+=[^;\r\n]*)*;?$/;

function looksLikeCookieObject(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    Object.hasOwn(entry, 'name') &&
    Object.hasOwn(entry, 'domain')
  );
}

/**
 * Identifies which Cookie-Editor export format a text is in. Only the JSON
 * export (Chromium variant) is supported; other formats lose security
 * attributes (Netscape: SameSite and session semantics; header string:
 * domain, path, Secure, HttpOnly) and are rejected rather than guessed.
 */
export function detectFormat(text: string): Detection {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { format: 'empty' };

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { format: 'invalid_json' };
    }
    if (!Array.isArray(parsed)) return { format: 'json-unrecognized' };
    if (parsed.length === 0) return { format: 'empty' };
    // Most entries must look like cookies; individual bad entries are then
    // rejected one by one during validation.
    const cookieLike = parsed.filter(looksLikeCookieObject).length;
    if (cookieLike === 0) return { format: 'json-unrecognized' };
    const firefox = parsed.some(
      (e) => looksLikeCookieObject(e) && Object.hasOwn(e as object, 'firstPartyDomain'),
    );
    return { format: firefox ? 'cookie-editor-json-firefox' : 'cookie-editor-json', entries: parsed };
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0 && !/^#(?!HttpOnly_)/.test(l.trim()));
  if (trimmed.startsWith('# Netscape') || (lines.length > 0 && lines.every((l) => l.split('\t').length === 7))) {
    return { format: 'netscape' };
  }
  if (!trimmed.includes('\n') && HEADER_STRING.test(trimmed)) return { format: 'header-string' };
  return { format: 'unknown' };
}
