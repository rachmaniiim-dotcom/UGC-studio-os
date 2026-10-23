import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { decodeCheckArgs, lastFrameArgs, parseProbe, probeArgs, stitchArgs, type ProbeResult, type StitchOptions } from '@ugc/core';

/**
 * Locally installed FFmpeg (A2): found via UGC_FFMPEG_DIR, PATH, or a
 * C:\ffmpeg*\bin folder. Never downloaded or bundled. Always run with an
 * argument array (no shell), with a timeout, only on files the caller chose
 * inside the account library.
 */

export interface FfmpegInstall {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly version: string;
}

const exe = process.platform === 'win32' ? '.exe' : '';

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env['UGC_FFMPEG_DIR']) dirs.push(process.env['UGC_FFMPEG_DIR']);
  dirs.push(...(process.env['PATH'] ?? '').split(delimiter).filter(Boolean));
  if (process.platform === 'win32') {
    try {
      for (const d of readdirSync('C:\\')) if (/^ffmpeg/i.test(d)) dirs.push(join('C:\\', d, 'bin'));
    } catch {
      // no C:\ listing: rely on PATH
    }
    dirs.push('C:\\Program Files\\ffmpeg\\bin');
  }
  return dirs;
}

function run(bin: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr).slice(0, 2000) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export class FfmpegRunner {
  private constructor(readonly install: FfmpegInstall) {}

  /** Finds a working FFmpeg + ffprobe pair, or null. */
  static async locate(): Promise<FfmpegRunner | null> {
    for (const dir of candidateDirs()) {
      const ffmpeg = join(dir, `ffmpeg${exe}`);
      const ffprobe = join(dir, `ffprobe${exe}`);
      if (!existsSync(ffmpeg) || !existsSync(ffprobe)) continue;
      try {
        const { stdout } = await run(ffmpeg, ['-version'], 15_000);
        return new FfmpegRunner({ ffmpeg, ffprobe, version: stdout.split(/\r?\n/)[0]!.replace(/ Copyright.*$/, '').slice(0, 120) });
      } catch {
        // not runnable; keep looking
      }
    }
    return null;
  }

  async probe(file: string): Promise<ProbeResult> {
    const { stdout } = await run(this.install.ffprobe, probeArgs(file), 60_000);
    return parseProbe(stdout);
  }

  /** True if the whole file decodes without errors. */
  async decodes(file: string): Promise<boolean> {
    try {
      const { stderr } = await run(this.install.ffmpeg, decodeCheckArgs(file), 180_000);
      return stderr.trim() === '';
    } catch {
      return false;
    }
  }

  async stitch(clips: Parameters<typeof stitchArgs>[0], output: string, options?: StitchOptions): Promise<void> {
    await run(this.install.ffmpeg, stitchArgs(clips, output, options), 600_000);
  }

  async lastFrame(clip: string, png: string): Promise<void> {
    await run(this.install.ffmpeg, lastFrameArgs(clip, png), 60_000);
  }
}
