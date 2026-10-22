import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
}

/** Serves the trusted UI from `rendererDir` at app://ui/ with a strict CSP. */
export function serveAppProtocol(rendererDir: string): void {
  const root = normalize(rendererDir);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'ui') return new Response(null, { status: 404 });
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    const type = MIME[extname(file)];
    if (!file.startsWith(root + sep) || !type) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
