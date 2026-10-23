import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, Session } from 'electron';
import { LISTING_SNAPSHOT_SCRIPT, readListing, type ListingFacts, type ListingIssue, type ListingSnapshot } from '@ugc/core';

/**
 * Reads the product listing open in an affiliate account's TikTok window (A3).
 * The snapshot runs in an isolated world, so the page's own scripts can't see
 * or alter it; it only reads meta tags, JSON blocks and visible text. Nothing
 * is clicked. A security check is left on screen for the owner to complete:
 * the reader keeps waiting (up to `securityWaitMs`) and reads the page after.
 */

const WORLD_ID = 1201;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export type ListingReadOutcome = { ok: true; value: ListingFacts; found: string[] } | { ok: false; issue: ListingIssue | 'window_closed' };

const isSnapshot = (v: unknown): v is ListingSnapshot => {
  const s = v as Partial<ListingSnapshot> | null;
  return (
    !!s &&
    typeof s.url === 'string' &&
    typeof s.title === 'string' &&
    typeof s.text === 'string' &&
    typeof s.security === 'boolean' &&
    !!s.meta &&
    typeof s.meta === 'object' &&
    Array.isArray(s.ld) &&
    Array.isArray(s.data)
  );
};

export async function readOpenListing(
  win: BrowserWindow,
  productId: string,
  options: { renderWaitMs?: number; securityWaitMs?: number; pollMs?: number; onSecurityCheck?: () => void } = {},
): Promise<ListingReadOutcome> {
  const { renderWaitMs = 30_000, securityWaitMs = 180_000, pollMs = 1_500 } = options;
  const started = Date.now();
  let last: ListingIssue = 'title_not_found';
  let securitySeen = false;
  for (;;) {
    if (win.isDestroyed()) return { ok: false, issue: 'window_closed' };
    if (!win.webContents.isLoading()) {
      const snap: unknown = await win.webContents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: LISTING_SNAPSHOT_SCRIPT }]).catch(() => null);
      if (isSnapshot(snap)) {
        const r = readListing(snap, productId);
        if (r.ok) return r;
        last = r.issue;
        if (r.issue === 'security_check' && !securitySeen) {
          securitySeen = true;
          options.onSecurityCheck?.();
        }
      }
    }
    if (Date.now() - started > (securitySeen ? securityWaitMs : renderWaitMs)) return { ok: false, issue: last };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Downloads the listing's main photo through the account's own session (its
 * proxy) into `dir`. Only HTTPS, JPEG/PNG/WebP, at most 8 MB. Returns the file
 * path, or null if it isn't a usable image.
 */
export async function downloadListingImage(ses: Session, url: string, dir: string): Promise<string | null> {
  if (!/^https:\/\//.test(url)) return null;
  const res = await ses.fetch(url, { redirect: 'follow' }).catch(() => null);
  if (!res || !res.ok) return null;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (!ext || declared > MAX_IMAGE_BYTES) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < 12 || body.length > MAX_IMAGE_BYTES) return null;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomUUID()}${ext}`);
  await writeFile(file, body, { mode: 0o600 });
  return file;
}
