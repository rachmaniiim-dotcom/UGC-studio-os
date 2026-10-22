import { createHash, X509Certificate } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { generate } from 'selfsigned';
import { SESSION_COOKIE, SYNTHETIC_DOMAIN, SYNTHETIC_HOST, syntheticToken } from './fixtures.js';

export interface RecordedRequest {
  readonly path: string;
  readonly cookieNames: readonly string[];
  /** SHA-256 of the session token, so tests can compare without seeing it. */
  readonly sessionTokenHash: string | null;
  /**
   * The client address the site saw: a synthetic proxy's exit IP (sent with
   * the PROXY protocol header, as real load balancers do), or 'direct' for a
   * connection that did not come through a synthetic proxy.
   */
  readonly clientIp: string;
  /** Whether the request carried an Authorization header (never its content). */
  readonly authorizationSent: boolean;
}

export interface SyntheticSite {
  readonly port: number;
  /** Electron-style fingerprint: "sha256/<base64 of DER digest>". */
  readonly certificateFingerprint: string;
  readonly requests: RecordedRequest[];
  url(path?: string): string;
  /** Registers a session token the site will accept for `user`. */
  addUser(user: string, token?: string): string;
  revokeToken(token: string): void;
  /** Makes the primary IP-diagnostic endpoint (/ip) fail, to exercise the backup (/ip-backup). */
  failPrimaryIp(fail: boolean): void;
  close(): Promise<void>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Companion cookie set together with a rotated session token; must match it. */
export const CSRF_COOKIE = 'poc_csrf';
export function csrfFor(token: string): string {
  return `csrf_${hashToken(token).slice(0, 32)}`;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

const PAGE = (script: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Synthetic PoC site</title></head>
<body><h1>Synthetic PoC site</h1><p id="status" data-state="loading">Loading…</p>
<script>${script}</script></body></html>`;

// The page shows who the server thinks you are. It never displays cookie values.
const HOME_SCRIPT = `
fetch('/whoami').then(r => r.json()).then(d => {
  const el = document.getElementById('status');
  el.dataset.state = d.authenticated ? 'authenticated' : 'anonymous';
  el.textContent = d.authenticated ? 'Authenticated as ' + d.user : 'Not authenticated (' + d.reason + ')';
});`;

// Stand-in for sites that also require non-cookie state (e.g. a device token in localStorage).
const STRICT_SCRIPT = `
const deviceToken = localStorage.getItem('poc_device_token') || '';
fetch('/whoami-strict', { headers: { 'x-device-token': deviceToken } }).then(r => r.json()).then(d => {
  const el = document.getElementById('status');
  el.dataset.state = d.authenticated ? 'authenticated' : 'anonymous';
  el.textContent = d.authenticated ? 'Authenticated as ' + d.user : 'Not authenticated (' + d.reason + ')';
});`;

const MARK_SCRIPT = (state: string, text: string): string => `
const el = document.getElementById('status');
el.dataset.state = ${JSON.stringify(state)};
el.textContent = ${JSON.stringify(text)};`;

const LOGIN_SCRIPT = (deviceToken: string): string => `
localStorage.setItem('poc_device_token', ${JSON.stringify(deviceToken)});
const el = document.getElementById('status');
el.dataset.state = 'logged-in';
el.textContent = 'Interactive login complete';`;

/**
 * Local HTTPS site for the synthetic proof of concept. It recognizes only
 * tokens registered through addUser(); everything is in memory.
 */
export async function startSyntheticSite(): Promise<SyntheticSite> {
  const pems = await generate([{ name: 'commonName', value: SYNTHETIC_HOST }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: SYNTHETIC_HOST },
          { type: 2, value: `*.${SYNTHETIC_DOMAIN}` },
        ],
      },
    ],
  });
  const der = new X509Certificate(pems.cert).raw;
  const certificateFingerprint = `sha256/${createHash('sha256').update(der).digest('base64')}`;

  const users = new Map<string, string>();
  const deviceTokens = new Map<string, string>();
  let rotations = 0;
  let primaryIpFails = false;
  /** Client address per TCP connection, keyed by the connection's remote port. */
  const clientIps = new Map<number, string>();
  const requests: RecordedRequest[] = [];

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const html = (res: ServerResponse, body: string, headers: Record<string, string | string[]> = {}): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `https://${SYNTHETIC_HOST}`);
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get(SESSION_COOKIE) ?? null;
    const clientIp = clientIps.get(req.socket.remotePort ?? -1) ?? 'direct';
    requests.push({
      path: url.pathname,
      cookieNames: [...cookies.keys()].sort(),
      sessionTokenHash: token ? hashToken(token) : null,
      clientIp,
      authorizationSent: req.headers.authorization !== undefined,
    });
    const user = token ? users.get(token) : undefined;

    switch (url.pathname) {
      case '/':
        return html(res, PAGE(HOME_SCRIPT));
      case '/strict':
        return html(res, PAGE(STRICT_SCRIPT));
      case '/whoami': {
        // A CSRF companion from another generation means a mixed (inconsistent) session state.
        const csrf = cookies.get(CSRF_COOKIE);
        if (user && csrf !== undefined && token && csrf !== csrfFor(token)) {
          return json(res, 401, { authenticated: false, reason: 'inconsistent_session' });
        }
        if (user) return json(res, 200, { authenticated: true, user });
        return json(res, 401, { authenticated: false, reason: token ? 'unknown_session' : 'no_session' });
      }
      case '/rotate': {
        // Replaces the session token (the old one stops working) and sets a matching
        // CSRF cookie in the same response. Both are session cookies (no expiry).
        if (!user || !token) return html(res, PAGE(MARK_SCRIPT('anonymous', 'Not authenticated')));
        rotations += 1;
        const next = syntheticToken(`${user}_r${rotations}`);
        users.delete(token);
        users.set(next, user);
        return html(res, PAGE(MARK_SCRIPT('rotated', `Rotated for ${user}`)), {
          'set-cookie': [
            `${SESSION_COOKIE}=${next}; Path=/; Secure; HttpOnly; SameSite=Lax`,
            `${CSRF_COOKIE}=${csrfFor(next)}; Path=/; Secure; SameSite=Lax`,
          ],
        });
      }
      // IP-diagnostic endpoints (synthetic stand-ins for the reviewed public ones).
      case '/ip':
        if (primaryIpFails) return json(res, 503, { error: 'unavailable' });
        return json(res, 200, { ip: clientIp });
      case '/ip-backup':
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        return void res.end(`${clientIp}\n`);
      // A site asking for HTTP Basic auth: proxy credentials must never be offered here.
      case '/basic-auth':
        res.writeHead(401, { 'www-authenticate': 'Basic realm="synthetic-site"', 'content-type': 'text/plain' });
        return void res.end('site authentication required');
      case '/logout':
        if (token) users.delete(token);
        return html(res, PAGE(MARK_SCRIPT('logged-out', 'Logged out')), {
          'set-cookie': [`${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`, `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`],
        });
      case '/whoami-strict': {
        if (!user) return json(res, 401, { authenticated: false, reason: token ? 'unknown_session' : 'no_session' });
        const device = req.headers['x-device-token'];
        if (typeof device === 'string' && device.length > 0 && deviceTokens.get(device) === user) {
          return json(res, 200, { authenticated: true, user });
        }
        return json(res, 401, { authenticated: false, reason: 'device_not_recognized' });
      }
      case '/interactive-login': {
        // Simulates a real login: the site sets both its cookie and non-cookie state.
        const name = url.searchParams.get('user') ?? 'interactive-user';
        const sessionToken = syntheticToken(`login_${name}`);
        const deviceToken = syntheticToken(`device_${name}`);
        users.set(sessionToken, name);
        deviceTokens.set(deviceToken, name);
        return html(res, PAGE(LOGIN_SCRIPT(deviceToken)), {
          'set-cookie': `${SESSION_COOKIE}=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        });
      }
      default:
        res.writeHead(404).end();
    }
  };

  const server = createServer({ key: pems.private, cert: pems.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const innerPort = (server.address() as AddressInfo).port;

  // A TCP relay in front of the HTTPS server. It reads the PROXY protocol v1
  // header the synthetic proxies send (absent on direct connections), records
  // the client IP under the relay connection's port, and forwards the rest.
  const sockets = new Set<Socket>();
  const track = (s: Socket): void => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };
  const front = createTcpServer((socket) => {
    track(socket);
    socket.once('data', (chunk: Buffer) => {
      socket.pause();
      let rest = chunk;
      let ip = 'direct';
      const text = chunk.subarray(0, 108).toString('latin1');
      if (text.startsWith('PROXY ')) {
        const end = text.indexOf('\r\n');
        ip = text.slice(0, end).split(' ')[2] ?? 'unknown';
        rest = chunk.subarray(end + 2);
      }
      const inner = connect({ host: '127.0.0.1', port: innerPort }, () => {
        const relayPort = inner.localPort ?? -1;
        clientIps.set(relayPort, ip);
        inner.on('close', () => clientIps.delete(relayPort));
        if (rest.length > 0) inner.write(rest);
        socket.pipe(inner);
        inner.pipe(socket);
      });
      track(inner);
      const closeBoth = (): void => {
        inner.destroy();
        socket.destroy();
      };
      inner.on('error', closeBoth);
      socket.on('error', closeBoth);
      inner.on('close', () => socket.destroy());
      socket.on('close', () => inner.destroy());
    });
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const { port } = front.address() as AddressInfo;

  return {
    port,
    certificateFingerprint,
    requests,
    url: (path = '/') => `https://${SYNTHETIC_HOST}:${port}${path}`,
    addUser(user, token = syntheticToken(user)) {
      users.set(token, user);
      return token;
    },
    revokeToken(token) {
      users.delete(token);
    },
    failPrimaryIp(fail) {
      primaryIpFails = fail;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close();
        front.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
