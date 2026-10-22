import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { createLogger, redactText, redactValue, SecretValue } from '../src/index.js';
import { CANARY_MARKER, syntheticToken } from '../../test-fixtures/src/fixtures.js';

const TOKEN = syntheticToken('redact');
// Assembled at runtime so the repository secret scan does not flag this file.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJl'].join('.');

describe('redactText', () => {
  it.each([
    [`Cookie: poc_session=${TOKEN}; other=1`, 'Cookie: [REDACTED]'],
    [`set-cookie: poc_session=${TOKEN}`, 'set-cookie: [REDACTED]'],
    [`Authorization: Basic ${TOKEN}`, 'Authorization: [REDACTED]'],
    [`calling with Bearer ${TOKEN} now`, 'calling with Bearer [REDACTED] now'],
    [`GET https://auth.ugc-poc.test/cb?code=${TOKEN}&state=1 failed`, 'GET https://auth.ugc-poc.test/cb?[REDACTED] failed'],
    [`{"name":"poc_session","value":"${TOKEN}"}`, '{"name":"poc_session","value":"[REDACTED]"}'],
    [`token=${TOKEN}`, 'token=[REDACTED]'],
    [`password: ${TOKEN}`, 'password: [REDACTED]'],
  ])('redacts %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('redacts JWT-shaped strings and long opaque strings', () => {
    expect(redactText(`jwt ${JWT} end`)).toBe('jwt [REDACTED] end');
    expect(redactText(`blob ${'a1B2'.repeat(12)}`)).toBe('blob [REDACTED]');
  });

  it('leaves ordinary diagnostics and UUIDs readable', () => {
    const text = 'session 6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f imported 3 cookies for auth.ugc-poc.test';
    expect(redactText(text)).toBe(text);
  });
});

describe('redactValue', () => {
  it('redacts sensitive keys, nested strings, SecretValue and errors', () => {
    const err = new Error(`load failed for Cookie: a=${TOKEN}`);
    const out = redactValue({
      sessionId: 'abc',
      value: TOKEN,
      nested: { cookies: [{ name: 'x', value: TOKEN }], note: `token=${TOKEN}` },
      secret: new SecretValue(TOKEN),
      wrapped: new SecretValue(TOKEN),
      err,
      count: 3,
    });
    expect(JSON.stringify(out)).not.toContain(CANARY_MARKER);
    expect(out).toMatchObject({ count: 3, sessionId: '[REDACTED]', wrapped: '[REDACTED]' });
  });

  it('handles cycles and depth', () => {
    const a: Record<string, unknown> = { n: 1 };
    a['self'] = a;
    expect(redactValue(a)).toEqual({ n: 1, self: '[CIRCULAR]' });
  });
});

describe('SecretValue', () => {
  it('does not leak through string conversion, JSON or inspect', () => {
    const s = new SecretValue(TOKEN);
    for (const surface of [String(s), `${s}`, JSON.stringify({ s }), inspect(s), inspect({ s }, { depth: 5 })]) {
      expect(surface).not.toContain(CANARY_MARKER);
    }
    expect(s.reveal()).toBe(TOKEN);
    expect(Object.keys(s)).toEqual([]);
  });
});

describe('createLogger', () => {
  it('writes redacted JSON lines only', () => {
    const lines: string[] = [];
    const logger = createLogger((l) => lines.push(l), () => new Date(0));
    logger.error(`import failed: Cookie: a=${TOKEN}`, { value: TOKEN, url: `https://x.test/?t=${TOKEN}`, count: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(CANARY_MARKER);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: 'error', ts: '1970-01-01T00:00:00.000Z', count: 1 });
  });
});
