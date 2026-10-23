import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Synthetic video clips for A2 tests, made by the locally installed FFmpeg
 * from its built-in test patterns (no downloads, no real footage).
 */

const exe = process.platform === 'win32' ? '.exe' : '';

/** The local FFmpeg binary, or null when it isn't installed (tests then skip with a reason). */
export function findFfmpeg(): string | null {
  const dirs = [process.env['UGC_FFMPEG_DIR'] ?? '', ...(process.env['PATH'] ?? '').split(delimiter)];
  if (process.platform === 'win32') {
    try {
      for (const d of readdirSync('C:\\')) if (/^ffmpeg/i.test(d)) dirs.push(join('C:\\', d, 'bin'));
    } catch {
      // ignore
    }
  }
  for (const d of dirs.filter(Boolean)) {
    if (existsSync(join(d, `ffmpeg${exe}`)) && existsSync(join(d, `ffprobe${exe}`))) return join(d, `ffmpeg${exe}`);
  }
  return null;
}

/**
 * Writes a synthetic clip: a moving test pattern, optionally with a sine tone.
 * Defaults to an 8-second 1080×1920 30 fps H.264 + AAC clip, like a Flow clip.
 */
export function makeSyntheticClip(
  file: string,
  options: { seconds?: number; width?: number; height?: number; fps?: number; audio?: boolean; pattern?: 'testsrc' | 'testsrc2' | 'smptebars'; tone?: number } = {},
): void {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not installed');
  const { seconds = 8, width = 1080, height = 1920, fps = 30, audio = true, pattern = 'testsrc2', tone = 440 } = options;
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${pattern}=size=${width}x${height}:rate=${fps}:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  execFileSync(ffmpeg, args);
}
