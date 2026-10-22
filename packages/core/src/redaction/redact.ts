import { REDACTED, SecretValue } from './secret.js';

const SENSITIVE_KEY =
  /^(value|cookies?|set-cookie|authorization|proxy-authorization|proxy_?(user(name)?|pass(word)?|credentials?)|username|token|access_?token|refresh_?token|id_?token|session_?(id|token)?|sid|password|passwd|secret|api_?key|auth|credentials?|storage_?state|payload)$/i;

const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // HTTP header lines carrying credentials.
  [/\b(cookie|set-cookie|authorization|proxy-authorization)(\s*[:=]\s*)[^\r\n]*/gi, `$1$2${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // JWT-shaped tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Credentials inside URLs (e.g. a proxy URL user:password@host).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED}@`],
  // Query strings can carry tokens; keep scheme/host/path only.
  [/(\bhttps?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, `$1?${REDACTED}`],
  // "value": "..." pairs from serialized cookie JSON.
  [/("value"\s*:\s*)"(?:[^"\\]|\\.)*"/g, `$1"${REDACTED}"`],
  // key=value / key: value pairs for sensitive names.
  [
    /\b(token|access_token|refresh_token|id_token|session_?id|session_?token|sid|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)"?[^\s"&;,]+"?/gi,
    `$1$2${REDACTED}`,
  ],
  // Long opaque strings (40+ chars) are treated as credentials. UUIDs (36) survive.
  [/[A-Za-z0-9+/_=-]{40,}/g, REDACTED],
];

export function redactText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of TEXT_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MAX_DEPTH = 8;

/** Deep-copies a value for logging, redacting sensitive keys and strings. */
export function redactValue(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (input instanceof SecretValue) return REDACTED;
  if (typeof input === 'string') return redactText(input);
  if (input === null || typeof input !== 'object') return input;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(input)) return '[CIRCULAR]';
  seen.add(input);

  if (input instanceof Error) {
    return {
      name: input.name,
      message: redactText(input.message),
      ...(input.stack ? { stack: redactText(input.stack) } : {}),
    };
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, depth + 1, seen);
  }
  return out;
}
