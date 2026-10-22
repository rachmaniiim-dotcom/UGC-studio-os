import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { looksLikeMp4 } from '@ugc/core';
import { PROFILE_ID } from './profiles.js';
import { writeAtomic } from './atomic.js';

/**
 * Per-account video library: <userData>/library/<bundleId>/. Only files that
 * look like MP4s are kept, written atomically, with size and SHA-256 recorded
 * (the content itself is never read for anything else).
 */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export interface StoredVideo {
  /** Relative to userData, with forward slashes. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export class VideoLibrary {
  constructor(readonly userData: string) {}

  dirFor(bundleId: string): string {
    if (!PROFILE_ID.test(bundleId)) throw new Error('invalid bundle id');
    const dir = join(this.userData, 'library', bundleId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  absolute(file: string): string {
    const abs = join(this.userData, ...file.split('/'));
    if (!abs.startsWith(join(this.userData, 'library') + sep)) throw new Error('outside library');
    return abs;
  }

  #stored(abs: string, bytes: Buffer | Uint8Array): StoredVideo {
    return {
      file: relative(this.userData, abs).split(sep).join('/'),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** Stores a provider's output. Throws 'output_invalid' unless it is an MP4 within the size cap. */
  save(bundleId: string, jobId: string, bytes: Uint8Array): StoredVideo {
    if (bytes.byteLength > MAX_VIDEO_BYTES || !looksLikeMp4(bytes)) throw new Error('output_invalid');
    const abs = join(this.dirFor(bundleId), `${jobId}.mp4`);
    writeAtomic(abs, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return this.#stored(abs, bytes);
  }

  /** Path where a manual download is written first; finalize() validates and moves it into place. */
  partPath(bundleId: string, name: string): string {
    return join(this.dirFor(bundleId), `${name}.mp4.part`);
  }

  discard(partPath: string): void {
    rmSync(partPath, { force: true });
  }

  /** Validates a finished manual download and renames it to .mp4; deletes it if invalid. */
  finalize(partPath: string): StoredVideo | null {
    try {
      const size = statSync(partPath).size;
      const bytes = size <= MAX_VIDEO_BYTES ? readFileSync(partPath) : Buffer.alloc(0);
      if (!looksLikeMp4(bytes)) {
        rmSync(partPath, { force: true });
        return null;
      }
      const finalPath = partPath.replace(/\.part$/, '');
      renameSync(partPath, finalPath);
      return this.#stored(finalPath, bytes);
    } catch {
      rmSync(partPath, { force: true });
      return null;
    }
  }
}
