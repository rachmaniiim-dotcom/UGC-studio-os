import { net, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  // Videos from this app's own library only (app://ui/media/…, read-only, by id).
  "media-src 'self'",
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

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Maps a library video id to its file inside the library, or refuses (A2). */
export type MediaResolver = (kind: 'job' | 'final', id: string) => string | null;

/** Must run before app 'ready'. `stream` lets the in-app player seek library videos. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
}

/**
 * Serves the trusted UI from `rendererDir` at app://ui/ with a strict CSP,
 * and, read-only, the app's own library videos at app://ui/media/job/<jobId>
 * and app://ui/media/final/<videoId> for the in-app player (same origin, so
 * the player may load them). Only ids are accepted; the resolver decides the
 * file, which must be an MP4 inside the library.
 */
export function serveAppProtocol(rendererDir: string, media?: MediaResolver): void {
  const root = normalize(rendererDir);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'ui') return new Response(null, { status: 404 });
    const m = /^\/media\/(job|final)\/([^/]+)$/.exec(url.pathname);
    if (m) {
      if (!media || !ID.test(m[2]!)) return new Response(null, { status: 404 });
      let file: string | null;
      try {
        file = media(m[1] as 'job' | 'final', m[2]!);
      } catch {
        file = null;
      }
      if (!file || extname(file).toLowerCase() !== '.mp4') return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      return net.fetch(pathToFileURL(file).toString(), range ? { headers: { range } } : {});
    }
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
