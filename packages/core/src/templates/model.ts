import { DEFAULT_VIDEO_SETTINGS, validateCreativeInput, type VideoSettings } from '../generation/model.js';

/**
 * Prompt templates for Ternak Akun (T1). A template is versioned data: long
 * prompt sections with {{placeholders}}, the variables that fill them, the
 * pools that make each prompt different, character/world blocks that must
 * appear verbatim in every prompt, reference-asset needs and a caption
 * strategy. Starter templates ship in code; the owner's own templates are
 * stored and versioned in the database. Validation here is the only gate
 * for both.
 */

export type VariableKind =
  /** One value for every prompt of the account (e.g. language). */
  | 'text'
  /** A character, world or style description copied verbatim into every prompt and checked after edits. */
  | 'consistency'
  /** Pick one of the options for every prompt. */
  | 'choice'
  /** A variation axis: each prompt uses a different option where possible. */
  | 'pool';

export interface TemplateVariable {
  readonly key: string;
  readonly label: string;
  readonly kind: VariableKind;
  readonly required: boolean;
  /** Default value (text, consistency, choice). */
  readonly default: string;
  /** Choice options or the default pool. */
  readonly options: readonly string[];
  readonly help: string;
}

/** Filled per prompt by the concept provider (deterministic: rotated from the options). */
export interface TemplateSlot {
  readonly key: string;
  readonly label: string;
  readonly options: readonly string[];
}

export interface TemplateSection {
  readonly key: string;
  readonly title: string;
  readonly text: string;
}

export type ReferenceKind = 'image' | 'video';

export interface ReferenceSpec {
  readonly requirement: 'none' | 'optional' | 'required';
  readonly kinds: readonly ReferenceKind[];
  readonly purpose: 'appearance' | 'motion' | 'style';
  /**
   * manual_upload: Google Flow has a matching control, used by hand.
   * unsupported: no verified Flow control (e.g. motion transfer from a video): manual action outside the app.
   */
  readonly flowSupport: 'manual_upload' | 'unsupported';
  readonly instructions: string;
}

export interface CaptionStrategy {
  /** May use {{caption_line}}-style slots, variables and {{hashtags}}. */
  readonly pattern: string;
  readonly hashtags: readonly string[];
  readonly maxLength: number;
}

export type TemplateFamily = 'asmr' | 'grandma' | 'dance' | 'custom';

export interface PromptTemplate {
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly family: TemplateFamily;
  readonly niche: string;
  readonly description: string;
  readonly builtin: boolean;
  readonly sections: readonly TemplateSection[];
  readonly variables: readonly TemplateVariable[];
  readonly slots: readonly TemplateSlot[];
  readonly references: ReferenceSpec;
  readonly video: VideoSettings;
  readonly caption: CaptionStrategy;
}

/** Placeholders every template may use without declaring them. */
export const BUILTIN_PLACEHOLDERS = ['duration_seconds', 'aspect_ratio'] as const;

export const TEMPLATE_LIMITS = {
  sections: 20,
  sectionText: 4000,
  variables: 30,
  slots: 20,
  options: 60,
  optionText: 600,
  consistencyText: 2000,
  label: 80,
  name: 80,
  description: 500,
} as const;

const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const TEMPLATE_KEY = /^(builtin|custom)-[a-z0-9-]{1,40}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

export const placeholdersIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);

export type TemplateIssue =
  | 'invalid_template_key'
  | 'invalid_template_name'
  | 'invalid_template_text'
  | 'invalid_sections'
  | 'invalid_variables'
  | 'duplicate_key'
  | 'invalid_options'
  | 'unknown_placeholder'
  | 'no_variation'
  | 'invalid_reference_spec'
  | 'invalid_caption'
  | 'invalid_video';

const str = (v: unknown, max: number, allowEmpty = false): v is string =>
  typeof v === 'string' && (allowEmpty || v.trim().length > 0) && v.length <= max && !CONTROL.test(v);
const strList = (v: unknown, maxItems: number, maxLen: number): v is string[] => Array.isArray(v) && v.length <= maxItems && v.every((x) => str(x, maxLen));

/** Validates a template (starter or owner-made). Returns the normalized template or every issue. */
export function validateTemplate(raw: unknown): { ok: true; value: PromptTemplate } | { ok: false; issues: TemplateIssue[] } {
  const issues = new Set<TemplateIssue>();
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof t['key'] !== 'string' || !TEMPLATE_KEY.test(t['key'])) issues.add('invalid_template_key');
  if (!Number.isInteger(t['version']) || (t['version'] as number) < 1) issues.add('invalid_template_key');
  if (!str(t['name'], TEMPLATE_LIMITS.name)) issues.add('invalid_template_name');
  if (!str(t['niche'], TEMPLATE_LIMITS.label) || !str(t['description'], TEMPLATE_LIMITS.description, true)) issues.add('invalid_template_text');
  if (!['asmr', 'grandma', 'dance', 'custom'].includes(t['family'] as string)) issues.add('invalid_template_text');

  const sections = Array.isArray(t['sections']) ? (t['sections'] as Array<Record<string, unknown>>) : null;
  if (!sections || sections.length === 0 || sections.length > TEMPLATE_LIMITS.sections) issues.add('invalid_sections');
  const variables = Array.isArray(t['variables']) ? (t['variables'] as Array<Record<string, unknown>>) : null;
  if (!variables || variables.length > TEMPLATE_LIMITS.variables) issues.add('invalid_variables');
  const slots = Array.isArray(t['slots']) ? (t['slots'] as Array<Record<string, unknown>>) : null;
  if (!slots || slots.length > TEMPLATE_LIMITS.slots) issues.add('invalid_variables');

  const keys = new Set<string>(BUILTIN_PLACEHOLDERS);
  for (const s of sections ?? []) {
    if (typeof s !== 'object' || s === null || !KEY.test(String(s['key'])) || !str(s['title'], TEMPLATE_LIMITS.label) || !str(s['text'], TEMPLATE_LIMITS.sectionText)) issues.add('invalid_sections');
  }
  if (new Set((sections ?? []).map((s) => s?.['key'])).size !== (sections ?? []).length) issues.add('duplicate_key');
  for (const v of variables ?? []) {
    if (typeof v !== 'object' || v === null) {
      issues.add('invalid_variables');
      continue;
    }
    const kind = v['kind'];
    if (!KEY.test(String(v['key'])) || !str(v['label'], TEMPLATE_LIMITS.label) || !['text', 'consistency', 'choice', 'pool'].includes(kind as string)) issues.add('invalid_variables');
    if (typeof v['required'] !== 'boolean' || !str(v['help'], TEMPLATE_LIMITS.description, true)) issues.add('invalid_variables');
    const maxDefault = kind === 'consistency' ? TEMPLATE_LIMITS.consistencyText : TEMPLATE_LIMITS.optionText;
    if (!str(v['default'], maxDefault, true)) issues.add('invalid_variables');
    if (!strList(v['options'], TEMPLATE_LIMITS.options, TEMPLATE_LIMITS.optionText)) issues.add('invalid_options');
    else if ((kind === 'choice' || kind === 'pool') && (v['options'] as string[]).length === 0) issues.add('invalid_options');
    else if (kind === 'choice' && !(v['options'] as string[]).includes(v['default'] as string)) issues.add('invalid_options');
    if (keys.has(String(v['key']))) issues.add('duplicate_key');
    keys.add(String(v['key']));
  }
  for (const s of slots ?? []) {
    if (typeof s !== 'object' || s === null || !KEY.test(String(s['key'])) || !str(s['label'], TEMPLATE_LIMITS.label)) issues.add('invalid_variables');
    else if (!strList(s['options'], TEMPLATE_LIMITS.options, TEMPLATE_LIMITS.optionText) || (s['options'] as string[]).length === 0) issues.add('invalid_options');
    if (keys.has(String(s?.['key']))) issues.add('duplicate_key');
    keys.add(String(s?.['key']));
  }
  if ((variables ?? []).length > 0 && !(variables ?? []).some((v) => v?.['kind'] === 'pool')) issues.add('no_variation');
  if ((variables ?? []).length === 0) issues.add('no_variation');

  const caption = (typeof t['caption'] === 'object' && t['caption'] !== null ? t['caption'] : {}) as Record<string, unknown>;
  const captionKeys = new Set([...keys, 'hashtags']);
  if (
    !str(caption['pattern'], 600) ||
    !strList(caption['hashtags'], 30, 60) ||
    !(caption['hashtags'] as string[]).every((h) => /^#[\p{L}\p{N}_]{1,50}$/u.test(h)) ||
    !Number.isInteger(caption['maxLength']) ||
    (caption['maxLength'] as number) < 20 ||
    (caption['maxLength'] as number) > 2200
  ) {
    issues.add('invalid_caption');
  } else if (placeholdersIn(caption['pattern'] as string).some((p) => !captionKeys.has(p))) issues.add('unknown_placeholder');
  for (const s of sections ?? []) {
    if (typeof s?.['text'] === 'string' && placeholdersIn(s['text']).some((p) => !keys.has(p))) issues.add('unknown_placeholder');
  }

  const r = (typeof t['references'] === 'object' && t['references'] !== null ? t['references'] : {}) as Record<string, unknown>;
  if (
    !['none', 'optional', 'required'].includes(r['requirement'] as string) ||
    !Array.isArray(r['kinds']) ||
    !(r['kinds'] as unknown[]).every((k) => k === 'image' || k === 'video') ||
    (r['requirement'] !== 'none' && (r['kinds'] as unknown[]).length === 0) ||
    !['appearance', 'motion', 'style'].includes(r['purpose'] as string) ||
    !['manual_upload', 'unsupported'].includes(r['flowSupport'] as string) ||
    !str(r['instructions'], TEMPLATE_LIMITS.description, true)
  ) {
    issues.add('invalid_reference_spec');
  }

  const video = validateCreativeInput({ prompt: 'x', settings: t['video'] });
  if (!video.ok) issues.add('invalid_video');

  if (issues.size > 0) return { ok: false, issues: [...issues] };
  const clean = (o: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.map((f) => [f, o[f]]));
  return {
    ok: true,
    value: {
      key: t['key'] as string,
      version: t['version'] as number,
      name: (t['name'] as string).trim(),
      family: t['family'] as TemplateFamily,
      niche: (t['niche'] as string).trim(),
      description: (t['description'] as string).trim(),
      builtin: t['builtin'] === true,
      sections: sections!.map((s) => clean(s, ['key', 'title', 'text']) as unknown as TemplateSection),
      variables: variables!.map((v) => clean(v, ['key', 'label', 'kind', 'required', 'default', 'options', 'help']) as unknown as TemplateVariable),
      slots: slots!.map((s) => clean(s, ['key', 'label', 'options']) as unknown as TemplateSlot),
      references: clean(r, ['requirement', 'kinds', 'purpose', 'flowSupport', 'instructions']) as unknown as ReferenceSpec,
      video: video.ok ? video.value.settings : DEFAULT_VIDEO_SETTINGS,
      caption: clean(caption, ['pattern', 'hashtags', 'maxLength']) as unknown as CaptionStrategy,
    },
  };
}

/** An account's settings for one template. */
export interface TemplateConfig {
  /** text, consistency and choice values by variable key. */
  readonly values: Readonly<Record<string, string>>;
  /** The account's pools by variable key (start as the template's options). */
  readonly pools: Readonly<Record<string, readonly string[]>>;
  readonly count: number;
  readonly video: VideoSettings;
  readonly hashtags: readonly string[];
  readonly referenceAssetIds: readonly string[];
}

export const DEFAULT_PROMPT_COUNT = 10;
export const MAX_PROMPT_COUNT = 20;

export function defaultConfig(t: PromptTemplate): TemplateConfig {
  return {
    values: Object.fromEntries(t.variables.filter((v) => v.kind !== 'pool').map((v) => [v.key, v.default])),
    pools: Object.fromEntries(t.variables.filter((v) => v.kind === 'pool').map((v) => [v.key, [...v.options]])),
    count: DEFAULT_PROMPT_COUNT,
    video: t.video,
    hashtags: [...t.caption.hashtags],
    referenceAssetIds: [],
  };
}

export type ConfigIssue =
  | 'missing_required_value'
  | 'value_too_long'
  | 'invalid_choice'
  | 'pool_empty'
  | 'invalid_count'
  | 'invalid_video'
  | 'invalid_hashtags'
  | 'invalid_reference_assets'
  | 'reference_kind_not_allowed';

/** Validates an account's configuration against its template (unknown keys are dropped). */
export function validateConfig(t: PromptTemplate, raw: unknown): { ok: true; value: TemplateConfig } | { ok: false; issues: ConfigIssue[] } {
  const issues = new Set<ConfigIssue>();
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawValues = (typeof c['values'] === 'object' && c['values'] !== null ? c['values'] : {}) as Record<string, unknown>;
  const rawPools = (typeof c['pools'] === 'object' && c['pools'] !== null ? c['pools'] : {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  const pools: Record<string, string[]> = {};
  for (const v of t.variables) {
    if (v.kind === 'pool') {
      const list = rawPools[v.key] ?? v.options;
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
        issues.add('pool_empty');
        continue;
      }
      const cleaned = (list as string[]).map((x) => x.trim()).filter(Boolean);
      if (cleaned.length === 0) issues.add('pool_empty');
      if (cleaned.length > TEMPLATE_LIMITS.options || cleaned.some((x) => x.length > TEMPLATE_LIMITS.optionText || CONTROL.test(x))) issues.add('value_too_long');
      pools[v.key] = [...new Set(cleaned)];
      continue;
    }
    const value = rawValues[v.key] ?? v.default;
    if (typeof value !== 'string' || CONTROL.test(value)) {
      issues.add('value_too_long');
      continue;
    }
    const trimmed = value.trim();
    if (v.required && trimmed === '') issues.add('missing_required_value');
    if (trimmed.length > (v.kind === 'consistency' ? TEMPLATE_LIMITS.consistencyText : TEMPLATE_LIMITS.optionText)) issues.add('value_too_long');
    if (v.kind === 'choice' && !v.options.includes(trimmed)) issues.add('invalid_choice');
    values[v.key] = trimmed;
  }
  const count = c['count'] ?? DEFAULT_PROMPT_COUNT;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_PROMPT_COUNT) issues.add('invalid_count');
  const video = validateCreativeInput({ prompt: 'x', settings: c['video'] ?? t.video });
  if (!video.ok) issues.add('invalid_video');
  const hashtags = c['hashtags'] ?? t.caption.hashtags;
  if (!Array.isArray(hashtags) || hashtags.length > 30 || !hashtags.every((h) => typeof h === 'string' && /^#[\p{L}\p{N}_]{1,50}$/u.test(h))) issues.add('invalid_hashtags');
  const refs = c['referenceAssetIds'] ?? [];
  if (!Array.isArray(refs) || refs.length > 10 || !refs.every((r) => typeof r === 'string' && /^[0-9a-f-]{36}$/.test(r))) issues.add('invalid_reference_assets');
  if (issues.size > 0) return { ok: false, issues: [...issues] };
  return {
    ok: true,
    value: { values, pools, count: count as number, video: video.ok ? video.value.settings : t.video, hashtags: [...new Set(hashtags as string[])], referenceAssetIds: [...new Set(refs as string[])] },
  };
}

/**
 * Prompt statuses. Approval is about the text only; production statuses
 * (queued → generating → video_ready) are separate and only reached from an
 * approved prompt. An approved prompt is never a video.
 */
export type PromptStatus = 'draft' | 'approved' | 'rejected' | 'queued' | 'generating' | 'video_ready';
export type PromptAction = 'approve' | 'reject' | 'reopen' | 'queue' | 'unqueue' | 'start_manual' | 'back_to_queue';

export const PROMPT_ACTIONS: Readonly<Record<PromptAction, { readonly from: readonly PromptStatus[]; readonly to: PromptStatus }>> = {
  approve: { from: ['draft'], to: 'approved' },
  reject: { from: ['draft', 'approved'], to: 'rejected' },
  reopen: { from: ['approved', 'rejected'], to: 'draft' },
  queue: { from: ['approved'], to: 'queued' },
  unqueue: { from: ['queued'], to: 'approved' },
  /** The owner takes the prompt to Google Flow by hand; the next manual download is linked to it. */
  start_manual: { from: ['queued'], to: 'generating' },
  back_to_queue: { from: ['generating'], to: 'queued' },
};

export const EDITABLE_STATUSES: readonly PromptStatus[] = ['draft', 'approved', 'rejected'];

/** Flags that block approval until the prompt is edited. */
export const BLOCKING_FLAGS = ['unresolved_placeholder', 'too_long', 'consistency_missing', 'reference_missing'] as const;
export type PromptFlag = (typeof BLOCKING_FLAGS)[number] | 'near_duplicate';
