/**
 * Local FFmpeg stitching (A2): argument builders and ffprobe checks as pure
 * functions. The desktop app runs them with the locally installed FFmpeg
 * (argument arrays, never a shell). Output: MP4, 1080×1920, 30 fps, H.264
 * yuv420p, AAC 48 kHz stereo, loudness-normalised, fast start.
 */

export interface StitchOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Integrated loudness target (LUFS) and true peak (dBTP). */
  readonly loudnessI: number;
  readonly truePeak: number;
  /** Seconds trimmed from the start/end of each clip (0 = none). */
  readonly trimStart: readonly [number, number];
  readonly trimEnd: readonly [number, number];
}

export const DEFAULT_STITCH: StitchOptions = { width: 1080, height: 1920, fps: 30, loudnessI: -14, truePeak: -1.5, trimStart: [0, 0], trimEnd: [0, 0] };

export interface ProbeStream {
  readonly codecType: 'video' | 'audio' | string;
  readonly codecName: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly pixFmt?: string;
}

export interface ProbeResult {
  readonly durationSeconds: number;
  readonly formatName: string;
  readonly streams: readonly ProbeStream[];
}

/** Parses `ffprobe -print_format json -show_streams -show_format` output. */
export function parseProbe(json: string): ProbeResult {
  const data = JSON.parse(json) as { format?: { duration?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
  const rate = (r: unknown): number | undefined => {
    if (typeof r !== 'string') return undefined;
    const [n, d] = r.split('/').map(Number);
    return n && d ? Math.round((n / d) * 1000) / 1000 : undefined;
  };
  return {
    durationSeconds: Number(data.format?.duration ?? 0),
    formatName: data.format?.format_name ?? '',
    streams: (data.streams ?? []).map((s) => {
      const out: Record<string, unknown> = { codecType: String(s['codec_type']), codecName: String(s['codec_name']) };
      if (typeof s['width'] === 'number') out['width'] = s['width'];
      if (typeof s['height'] === 'number') out['height'] = s['height'];
      const fr = rate(s['avg_frame_rate']) ?? rate(s['r_frame_rate']);
      if (fr) out['frameRate'] = fr;
      if (s['sample_rate']) out['sampleRate'] = Number(s['sample_rate']);
      if (typeof s['channels'] === 'number') out['channels'] = s['channels'];
      if (typeof s['pix_fmt'] === 'string') out['pixFmt'] = s['pix_fmt'];
      return out as unknown as ProbeStream;
    }),
  };
}

export type ClipIssue = 'not_mp4' | 'no_video' | 'too_short' | 'too_long';
export interface ClipCheck {
  readonly ok: boolean;
  readonly issues: ClipIssue[];
  readonly hasAudio: boolean;
  readonly durationSeconds: number;
}

/** A Flow clip must be an MP4 with a video stream of about 8 seconds (6–10 s). A missing audio track is allowed (silence is added). */
export function checkClip(p: ProbeResult): ClipCheck {
  const issues: ClipIssue[] = [];
  if (!/mp4|mov/.test(p.formatName)) issues.push('not_mp4');
  if (!p.streams.some((s) => s.codecType === 'video')) issues.push('no_video');
  if (p.durationSeconds < 6) issues.push('too_short');
  if (p.durationSeconds > 10.5) issues.push('too_long');
  return { ok: issues.length === 0, issues, hasAudio: p.streams.some((s) => s.codecType === 'audio'), durationSeconds: p.durationSeconds };
}

export type FinalIssue = 'wrong_duration' | 'no_video' | 'no_audio' | 'wrong_size' | 'wrong_codec' | 'wrong_fps';

/** The finished video: about 16 s (12–20 s), 1080×1920, 30 fps, H.264 + AAC. */
export function checkFinal(p: ProbeResult, o: StitchOptions = DEFAULT_STITCH): FinalIssue[] {
  const issues: FinalIssue[] = [];
  const v = p.streams.find((s) => s.codecType === 'video');
  const a = p.streams.find((s) => s.codecType === 'audio');
  if (p.durationSeconds < 12 || p.durationSeconds > 20) issues.push('wrong_duration');
  if (!v) issues.push('no_video');
  if (!a) issues.push('no_audio');
  if (v && (v.width !== o.width || v.height !== o.height)) issues.push('wrong_size');
  if ((v && v.codecName !== 'h264') || (a && a.codecName !== 'aac')) issues.push('wrong_codec');
  if (v && v.frameRate !== undefined && Math.abs(v.frameRate - o.fps) > 0.5) issues.push('wrong_fps');
  return issues;
}

export const probeArgs = (file: string): string[] => ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file];

/** Full decode pass: any error output means a broken file. */
export const decodeCheckArgs = (file: string): string[] => ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'];

/** Saves the last frame of a clip as PNG (for a seamless Clip B in Flow). */
export const lastFrameArgs = (clip: string, png: string): string[] => ['-y', '-v', 'error', '-sseof', '-0.2', '-i', clip, '-update', '1', '-frames:v', '1', png];

/**
 * Joins Clip A and Clip B: each scaled and padded to the output size, same
 * frame rate and pixel format, optional trims, audio resampled (or silence
 * for a clip without audio), concatenated, loudness-normalised, encoded.
 */
export function stitchArgs(
  clips: readonly [{ file: string; hasAudio: boolean; durationSeconds: number }, { file: string; hasAudio: boolean; durationSeconds: number }],
  output: string,
  o: StitchOptions = DEFAULT_STITCH,
): string[] {
  const args = ['-y', '-v', 'error'];
  clips.forEach((c) => args.push('-i', c.file));
  // Silent audio inputs for clips without a sound track.
  const silent: number[] = [];
  clips.forEach((c, i) => {
    if (!c.hasAudio) {
      silent[i] = 2 + silent.filter((x) => x !== undefined).length;
      args.push('-f', 'lavfi', '-t', String(c.durationSeconds), '-i', 'anullsrc=r=48000:cl=stereo');
    }
  });
  const parts: string[] = [];
  clips.forEach((c, i) => {
    const start = o.trimStart[i] ?? 0;
    const end = Math.max(start + 1, c.durationSeconds - (o.trimEnd[i] ?? 0));
    const trim = start > 0 || (o.trimEnd[i] ?? 0) > 0 ? `trim=start=${start}:end=${end},setpts=PTS-STARTPTS,` : '';
    const atrim = start > 0 || (o.trimEnd[i] ?? 0) > 0 ? `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,` : '';
    parts.push(
      `[${i}:v]${trim}scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${o.fps},format=yuv420p[v${i}]`,
    );
    const audioIn = c.hasAudio ? `[${i}:a]` : `[${silent[i]}:a]`;
    parts.push(`${audioIn}${atrim}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  parts.push(`[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`);
  parts.push(`[a]loudnorm=I=${o.loudnessI}:TP=${o.truePeak}:LRA=11,aresample=48000[an]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[an]');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(o.fps));
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output);
  return args;
}
