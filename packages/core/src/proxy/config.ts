import { isIPv4, isIPv6 } from 'node:net';
import { SecretValue } from '../redaction/secret.js';

/**
 * A bundle's dedicated proxy (Gate 3). Platform-neutral so the future Linux
 * worker (Playwright) can use the same validated configuration.
 *
 * Supported now: HTTP and HTTPS proxies, with or without Basic credentials,
 * and SOCKS5 *without* credentials. Chromium (Electron and Playwright alike)
 * can't authenticate to SOCKS5 proxies, so SOCKS5 with credentials is refused
 * (owner decision Q1: deferred unless the purchased proxies need it).
 */
export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyEndpoint {
  readonly protocol: ProxyProtocol;
  /** Lower-case hostname, IPv4, or IPv6 without brackets. */
  readonly host: string;
  readonly port: number;
}

export interface ProxyCredentials {
  readonly username: SecretValue;
  readonly password: SecretValue;
}

export interface ProxySettings {
  readonly endpoint: ProxyEndpoint;
  readonly credentials: ProxyCredentials | null;
}

export type ProxyIssue =
  | 'invalid_protocol'
  | 'invalid_host'
  | 'invalid_port'
  | 'credentials_incomplete'
  | 'invalid_username'
  | 'invalid_password'
  | 'socks5_auth_unsupported';

const PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5'];
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function normalizeHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host.length === 0 || host.length > 253) return null;
  if (isIPv4(host) || isIPv6(host)) return host;
  // Hostnames only: no scheme, path, port or userinfo smuggled into the host field.
  return host.split('.').every((label) => HOST_LABEL.test(label)) ? host : null;
}

/**
 * Validates raw form input. Returns the settings with credentials wrapped in
 * SecretValue, or every problem found. Issue codes never include the input.
 */
export function validateProxyInput(raw: {
  protocol: unknown;
  host: unknown;
  port: unknown;
  username?: unknown;
  password?: unknown;
}): { ok: true; settings: ProxySettings } | { ok: false; issues: ProxyIssue[] } {
  const issues: ProxyIssue[] = [];
  const protocol = PROTOCOLS.find((p) => p === raw.protocol);
  if (!protocol) issues.push('invalid_protocol');
  const host = typeof raw.host === 'string' ? normalizeHost(raw.host) : null;
  if (!host) issues.push('invalid_host');
  const port = typeof raw.port === 'number' ? raw.port : typeof raw.port === 'string' && /^\d{1,5}$/.test(raw.port) ? Number(raw.port) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push('invalid_port');

  const username = raw.username === undefined || raw.username === null || raw.username === '' ? null : raw.username;
  const password = raw.password === undefined || raw.password === null || raw.password === '' ? null : raw.password;
  if ((username === null) !== (password === null)) issues.push('credentials_incomplete');
  // RFC 7617: a Basic user-id can't contain ':'.
  if (username !== null && (typeof username !== 'string' || username.length > 256 || CONTROL.test(username) || username.includes(':'))) {
    issues.push('invalid_username');
  }
  if (password !== null && (typeof password !== 'string' || password.length > 256 || CONTROL.test(password))) issues.push('invalid_password');
  if (protocol === 'socks5' && username !== null) issues.push('socks5_auth_unsupported');

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    settings: {
      endpoint: { protocol: protocol!, host: host!, port },
      credentials: username === null ? null : { username: new SecretValue(username as string), password: new SecretValue(password as string) },
    },
  };
}

/**
 * Chromium proxy rule for one proxy used for every URL scheme. It never
 * contains credentials (Chromium ignores them there; they are supplied on
 * the 407 challenge instead).
 */
export function chromiumProxyRules(endpoint: ProxyEndpoint): string {
  const host = isIPv6(endpoint.host) ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.protocol}://${host}:${endpoint.port}`;
}

/** True if a proxy authentication challenge comes from exactly this endpoint. */
export function challengeMatches(endpoint: ProxyEndpoint, challenge: { host: string; port: number }): boolean {
  return normalizeHost(challenge.host) === endpoint.host && challenge.port === endpoint.port;
}
