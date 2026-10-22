import { describe, expect, it } from 'vitest';
import { challengeMatches, chromiumProxyRules, redactText, validateProxyInput } from '../src/index.js';

describe('proxy settings', () => {
  it('accepts HTTP/HTTPS with credentials and normalizes the host', () => {
    const r = validateProxyInput({ protocol: 'http', host: ' Proxy.Example.COM ', port: '8080', username: 'u', password: 'p@ss:word' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.endpoint).toEqual({ protocol: 'http', host: 'proxy.example.com', port: 8080 });
      expect(r.settings.credentials?.password.reveal()).toBe('p@ss:word');
      expect(JSON.stringify(r)).not.toContain('p@ss:word'); // SecretValue
    }
    expect(validateProxyInput({ protocol: 'https', host: '203.0.113.5', port: 443 }).ok).toBe(true);
    expect(validateProxyInput({ protocol: 'http', host: '[2001:db8::1]', port: 3128 }).ok).toBe(true);
    expect(validateProxyInput({ protocol: 'socks5', host: '127.0.0.1', port: 1080 }).ok).toBe(true);
  });

  it.each([
    [{ protocol: 'ftp', host: 'a.example', port: 1 }, 'invalid_protocol'],
    [{ protocol: 'http', host: 'user:pw@a.example', port: 1 }, 'invalid_host'],
    [{ protocol: 'http', host: 'http://a.example', port: 1 }, 'invalid_host'],
    [{ protocol: 'http', host: 'a.example/path', port: 1 }, 'invalid_host'],
    [{ protocol: 'http', host: 'a.example', port: 0 }, 'invalid_port'],
    [{ protocol: 'http', host: 'a.example', port: 65536 }, 'invalid_port'],
    [{ protocol: 'http', host: 'a.example', port: '80x' }, 'invalid_port'],
    [{ protocol: 'http', host: 'a.example', port: 1, username: 'u' }, 'credentials_incomplete'],
    [{ protocol: 'http', host: 'a.example', port: 1, username: 'u:x', password: 'p' }, 'invalid_username'],
    [{ protocol: 'http', host: 'a.example', port: 1, username: 'u', password: 'p\n' }, 'invalid_password'],
    [{ protocol: 'socks5', host: 'a.example', port: 1, username: 'u', password: 'p' }, 'socks5_auth_unsupported'],
  ])('rejects %j with %s', (input, issue) => {
    const r = validateProxyInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain(issue);
  });

  it('builds Chromium rules without credentials, bracketing IPv6', () => {
    expect(chromiumProxyRules({ protocol: 'http', host: 'proxy.example.com', port: 8080 })).toBe('http://proxy.example.com:8080');
    expect(chromiumProxyRules({ protocol: 'https', host: '2001:db8::1', port: 443 })).toBe('https://[2001:db8::1]:443');
  });

  it('matches a challenge only from the exact proxy host and port', () => {
    const e = { protocol: 'http', host: 'proxy.example.com', port: 8080 } as const;
    expect(challengeMatches(e, { host: 'PROXY.example.com', port: 8080 })).toBe(true);
    expect(challengeMatches(e, { host: 'proxy.example.com', port: 8081 })).toBe(false);
    expect(challengeMatches(e, { host: 'evil.example.com', port: 8080 })).toBe(false);
  });

  it('redacts credentials in proxy URLs and proxy fields in logs', () => {
    expect(redactText('using http://alice:s3cret@proxy.example.com:8080 now')).toBe('using http://[REDACTED]@proxy.example.com:8080 now');
    expect(redactText('Proxy-Authorization: Basic YWxpY2U6czNjcmV0')).not.toContain('YWxpY2U6czNjcmV0');
  });
});
