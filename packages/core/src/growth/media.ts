// Ternak Akun media analysis (G1): what a multimodal model is asked about a
// finished video or an FYP reference, and the strict checks its answers pass
// before the app uses them. Captions come from the actual video, never from a
// permanent account niche; a video the model can't make out is flagged, not
// captioned by guesswork.

import { defaultConfig, type PromptTemplate, type TemplateConfig } from '../templates/model.js';

export interface VideoAnalysis {
  /** The model could tell what happens in the video. */
  readonly understood: boolean;
  /** 0–1, the model's own confidence. */
  readonly confidence: number;
  /** What is visibly/audibly in the video (one or two sentences). */
  readonly summary: string;
  /** Indonesian caption, based only on the video and the owner's note. */
  readonly caption: string;
  readonly hashtags: readonly string[];
}

export interface ReferenceAnalysis {
  /** What grabs attention in the first 1–2 seconds. */
  readonly hook: string;
  /** The beats, in order. */
  readonly structure: readonly string[];
  readonly pacing: string;
  readonly attention: readonly string[];
  /** The repeatable format, described without the reference's specific people, brands or words. */
  readonly format: string;
  readonly audio: string;
}

/** One original video idea in a reference's format, as Flow prompt parts. */
export interface Variation {
  readonly hook: string;
  readonly scene: string;
  readonly action: string;
  readonly style: string;
  readonly audio: string;
  readonly caption: string;
}

export type CaptionFlag = 'unclear_video' | 'low_confidence' | 'repetitive_caption' | 'generic_caption' | 'no_hashtags';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');
const list = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => clean(x, maxLen)).filter(Boolean))].slice(0, maxItems) : [];

/** "#Masak", "masak hemat", "#masak#hemat" → ["#masak", "#masakhemat"]; letters, digits and _ only. */
export function normalizeHashtags(v: unknown, max = 6): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const tag = String(raw)
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_]/gu, '');
    if (tag.length >= 2 && tag.length <= 40 && !out.includes(`#${tag}`)) out.push(`#${tag}`);
    if (out.length >= max) break;
  }
  return out;
}

/** Model output may wrap JSON in prose or code fences; take the first JSON object. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function validateVideoAnalysis(raw: unknown): VideoAnalysis | null {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o || typeof o['understood'] !== 'boolean') return null;
  const confidence = typeof o['confidence'] === 'number' && Number.isFinite(o['confidence']) ? Math.min(1, Math.max(0, o['confidence'])) : 0;
  const understood = o['understood'] && clean(o['caption'], 300) !== '';
  return {
    understood,
    confidence,
    summary: clean(o['summary'], 500),
    caption: understood ? clean(o['caption'], 300) : '',
    hashtags: understood ? normalizeHashtags(o['hashtags']) : [],
  };
}

export function validateReferenceAnalysis(raw: unknown): ReferenceAnalysis | null {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o) return null;
  const r: ReferenceAnalysis = {
    hook: clean(o['hook'], 400),
    structure: list(o['structure'], 8, 300),
    pacing: clean(o['pacing'], 300),
    attention: list(o['attention'], 8, 200),
    format: clean(o['format'], 600),
    audio: clean(o['audio'], 300),
  };
  return r.hook && r.format && r.structure.length > 0 ? r : null;
}

export function validateVariations(raw: unknown, max: number): Variation[] {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  const items = Array.isArray(o?.['variations']) ? (o!['variations'] as unknown[]) : [];
  const out: Variation[] = [];
  for (const it of items) {
    const v = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const x: Variation = {
      hook: clean(v['hook'], 600),
      scene: clean(v['scene'], 1500),
      action: clean(v['action'], 1500),
      style: clean(v['style'], 800),
      audio: clean(v['audio'], 600),
      caption: clean(v['caption'], 300),
    };
    if (x.hook && x.scene && x.action) out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

const captionWords = (s: string): string[] => s.toLowerCase().replace(/#\S+/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
const pairs = (w: readonly string[]): Set<string> => new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));

/** Word-pair overlap of two captions (0–1), hashtags ignored. */
export function captionSimilarity(a: string, b: string): number {
  const x = pairs(captionWords(a));
  const y = pairs(captionWords(b));
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : [...x].filter((g) => y.has(g)).length / union;
}

const GENERIC = /^(video (lucu|keren|seru)|wajib nonton|cek ini|lihat ini|keren banget|mantap|fyp|viral)[\s!.]*$/i;

/** Why a caption needs the owner's look before posting (empty = fine). */
export function captionFlags(a: VideoAnalysis, recentCaptions: readonly string[]): CaptionFlag[] {
  const flags: CaptionFlag[] = [];
  if (!a.understood) return ['unclear_video'];
  if (a.confidence < 0.5) flags.push('low_confidence');
  const words = a.caption.replace(/#\S+/g, '').trim();
  if (words.length < 12 || GENERIC.test(words)) flags.push('generic_caption');
  if (recentCaptions.some((c) => captionSimilarity(a.caption, c) >= 0.6)) flags.push('repetitive_caption');
  if (a.hashtags.length === 0) flags.push('no_hashtags');
  return flags;
}

/** Instructions for captioning one finished video (the video itself is attached). */
export function videoCaptionInstructions(context: { note: string; recentCaptions: readonly string[]; fileName?: string }): string {
  return [
    'You are writing a TikTok caption for the attached short video, for an Indonesian audience.',
    'Watch and listen to the whole video. Base everything ONLY on what is actually visible or audible in it, plus the owner note below if any.',
    'Do not invent names, places, products, prices, events or claims that are not in the video. Do not describe the video as AI-made unless it says so.',
    'If you cannot tell what the video shows, set "understood" to false and leave caption empty.',
    'Caption: natural, casual Bahasa Indonesia, 1–2 short sentences, a hook or question that fits this specific video, no emojis spam (at most 2), no hashtags inside the caption text.',
    'Hashtags: 3–6 relevant lowercase hashtags, without generic ones like #fyp #viral #foryou unless nothing else fits.',
    context.recentCaptions.length > 0 ? `Do not repeat or closely paraphrase these recent captions of the same account:\n- ${context.recentCaptions.slice(0, 15).join('\n- ')}` : '',
    context.note ? `Owner note about this video: ${context.note}` : '',
    context.fileName ? `The file was named "${context.fileName}"; use it only if it matches what the video shows.` : '',
    'Reply with JSON only: {"understood": boolean, "confidence": number 0-1, "summary": string, "caption": string, "hashtags": string[]}.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Instructions for breaking down FYP reference videos the owner supplied (attached). */
export function referenceInstructions(note: string): string {
  return [
    'The attached short videos are reference examples of a format that performs well on TikTok, supplied by the owner.',
    'Describe the FORMAT, not the specific content: what hooks attention in the first 1–2 seconds, the beats in order, pacing (cuts, length of shots), the attention-grabbing elements, and the audio approach.',
    'Describe it so an original video can be made in the same format with different people, setting and subject. Do not include names, brands, logos, on-screen text or exact lines from the references.',
    note ? `Owner note: ${note}` : '',
    'Reply with JSON only: {"hook": string, "structure": string[], "pacing": string, "attention": string[], "format": string, "audio": string}.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Instructions for writing original Flow video prompts in a reference's format. */
export function variationInstructions(ref: ReferenceAnalysis, count: number, video: { durationSeconds: number; aspectRatio: string }, avoid: readonly string[]): string {
  return [
    `Write ${count} ORIGINAL short-video ideas for Google Flow (text-to-video), each ${video.durationSeconds} seconds, ${video.aspectRatio}, for an Indonesian TikTok audience.`,
    'Each idea must use this proven format but be clearly different from the reference and from each other: new characters, setting, subject and situation. Never copy the reference.',
    `Format: ${ref.format}`,
    `Hook pattern: ${ref.hook}`,
    `Beats: ${ref.structure.join(' → ')}`,
    `Pacing: ${ref.pacing}`,
    `Attention elements: ${ref.attention.join('; ')}`,
    `Audio approach: ${ref.audio}`,
    'Rules: photorealistic unless the format is clearly animated; no real people, celebrities, brands, logos or copyrighted characters/music; no text overlays; any dialogue in casual Bahasa Indonesia.',
    avoid.length > 0 ? `Avoid repeating these earlier hooks:\n- ${avoid.slice(0, 20).join('\n- ')}` : '',
    'For each idea give: hook (what happens in the first 1–2 seconds), scene (characters, setting, look), action (the beats with timing), style (camera, lighting, look), audio (sounds, dialogue lines), caption (1–2 sentences in Bahasa Indonesia, no hashtags).',
    'Reply with JSON only: {"variations": [{"hook": string, "scene": string, "action": string, "style": string, "audio": string, "caption": string}]}.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The prompt template FYP variations are stored with, so they use the
 * existing Prompt Studio queue and Flow workflow unchanged.
 */
export const FYP_VARIATION_TEMPLATE: PromptTemplate = {
  key: 'builtin-fyp-variation',
  version: 1,
  name: 'FYP format variation',
  family: 'custom',
  niche: '',
  description: 'Original variations of a format from FYP references the owner supplied.',
  builtin: true,
  sections: [
    { key: 'scene', title: 'Scene', text: 'Vertical {{aspect_ratio}}, {{duration_seconds}} seconds. {{scene}}' },
    { key: 'hook', title: 'Hook (first 1–2 seconds)', text: '{{hook}}' },
    { key: 'action', title: 'Action', text: '{{action}}' },
    { key: 'style', title: 'Style', text: '{{style}}' },
    { key: 'audio', title: 'Audio', text: '{{audio}}' },
  ],
  variables: [],
  slots: [
    { key: 'scene', label: 'Scene', options: [] },
    { key: 'hook', label: 'Hook', options: [] },
    { key: 'action', label: 'Action', options: [] },
    { key: 'style', label: 'Style', options: [] },
    { key: 'audio', label: 'Audio', options: [] },
    { key: 'caption_line', label: 'Caption', options: [] },
  ],
  references: { requirement: 'none', kinds: [], purpose: 'style', flowSupport: 'manual_upload', instructions: '' },
  video: { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' },
  caption: { pattern: '{{caption_line}}', hashtags: [], maxLength: 300 },
};

export function fypVariationConfig(count: number): TemplateConfig {
  return { ...defaultConfig(FYP_VARIATION_TEMPLATE), count };
}
