import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { SYNTHETIC_DOMAIN } from './fixtures.js';

/**
 * Local synthetic HTTP proxy (CONNECT only) for proxy-isolation tests.
 *
 * - Optional Basic proxy authentication (407 challenge).
 * - Tunnels only to the synthetic site's domain (mapped to 127.0.0.1); any
 *   other target is refused, so tests can never reach the internet.
 * - Announces a simulated exit IP to the site with a PROXY protocol v1 header,
 *   because on Windows a local process can't use 127.0.0.x (x > 1) as its
 *   source address.
 * Records only targets, usernames offered and outcomes, never passwords.
 */

export interface ProxyRecord {
  readonly target: string;
  /** Username offered in Proxy-Authorization, or null if none. */
  readonly username: string | null;
  readonly outcome: 'tunnelled' | 'auth_required' | 'auth_rejected' | 'refused';
}

export interface SyntheticProxy {
  readonly port: number;
  readonly exitIp: string;
  readonly records: ProxyRecord[];
  /** Number of tunnels currently open (for connection-closing tests). */
  openTunnels(): number;
  close(): Promise<void>;
}

export interface SyntheticProxyOptions {
  /** Simulated public IP; use documentation ranges (198.51.100.0/24, 203.0.113.0/24). */
  readonly exitIp: string;
  readonly credentials?: { readonly username: string; readonly password: string };
}

function offeredCredentials(req: IncomingMessage): { username: string; password: string } | null {
  const header = req.headers['proxy-authorization'];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export async function startSyntheticProxy(options: SyntheticProxyOptions): Promise<SyntheticProxy> {
  const records: ProxyRecord[] = [];
  const sockets = new Set<Socket>();
  const tunnels = new Set<Socket>();
  const server = createServer((_req, res) => {
    // Plain-HTTP proxying is not needed: every synthetic request is HTTPS (CONNECT).
    res.writeHead(405).end();
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = req.url ?? '';
    const offered = offeredCredentials(req);
    const expected = options.credentials;
    if (expected && (!offered || offered.username !== expected.username || offered.password !== expected.password)) {
      records.push({ target, username: offered?.username ?? null, outcome: offered ? 'auth_rejected' : 'auth_required' });
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="synthetic-proxy"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, portText] = target.split(':');
    const port = Number(portText);
    if (!host || !(host === SYNTHETIC_DOMAIN || host.endsWith(`.${SYNTHETIC_DOMAIN}`)) || !Number.isInteger(port)) {
      records.push({ target, username: offered?.username ?? null, outcome: 'refused' });
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port }, () => {
      records.push({ target, username: offered?.username ?? null, outcome: 'tunnelled' });
      upstream.write(`PROXY TCP4 ${options.exitIp} 127.0.0.1 ${upstream.localPort ?? 0} ${port}\r\n`);
      if (head.length > 0) upstream.write(head);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunnels.add(client);
      client.on('close', () => tunnels.delete(client));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const closeBoth = (): void => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', closeBoth);
    client.on('error', closeBoth);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    exitIp: options.exitIp,
    records,
    openTunnels: () => tunnels.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
