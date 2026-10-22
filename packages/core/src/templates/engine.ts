import { MAX_PROMPT_CHARS } from '../generation/model.js';
import { placeholdersIn, type PromptFlag, type PromptTemplate, type ReferenceKind, type TemplateConfig } from './model.js';

/**
 * Deterministic prompt assembly (T1): variation planning, rendering, and the
 * checks that keep a batch usable (consistency blocks present verbatim, no
 * leftovers, length, near-duplicates). Pure functions: same input, same output.
 */

/** Small seeded PRNG (mulberry32) over a string seed. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface VariationPlan {
  /** Per prompt: the chosen option of each pool, by variable key. */
  readonly items: ReadonlyArray<Readonly<Record<string, string>>>;
  /** Set when fewer distinct combinations exist than were requested. */
  readonly shortfall: 'variation_space_exhausted' | null;
}

const MAX_CANDIDATES = 5000;

/**
 * Picks `count` distinct pool combinations, spreading options evenly and
 * maximizing how many axes differ between any two prompts. Never repeats a
 * combination (and avoids `exclude`); returns fewer, with a shortfall, when
 * the pools can't provide enough.
 */
export function planVariations(
  pools: Readonly<Record<string, readonly string[]>>,
  count: number,
  seed: string,
  exclude: ReadonlyArray<Readonly<Record<string, string>>> = [],
): VariationPlan {
  const rand = seededRandom(seed);
  const axes = Object.keys(pools)
    .sort()
    .filter((k) => pools[k]!.length > 0);
  if (axes.length === 0) return { items: [], shortfall: 'variation_space_exhausted' };
  const sizes = axes.map((k) => pools[k]!.length);
  const total = sizes.reduce((a, b) => a * b, 1);
  let candidates: number[][] = [];
  if (total <= MAX_CANDIDATES) {
    for (let n = 0; n < total; n++) {
      let rest = n;
      candidates.push(sizes.map((s) => {
        const i = rest % s;
        rest = Math.floor(rest / s);
        return i;
      }));
    }
    candidates = shuffled(candidates, rand);
  } else {
    const seen = new Set<string>();
    while (candidates.length < MAX_CANDIDATES) {
      const c = sizes.map((s) => Math.floor(rand() * s));
      const id = c.join(',');
      if (!seen.has(id)) {
        seen.add(id);
        candidates.push(c);
      }
    }
  }
  const toIdx = (r: Readonly<Record<string, string>>): number[] => axes.map((k) => pools[k]!.indexOf(r[k] ?? ''));
  const chosen: number[][] = exclude.map(toIdx);
  const fixed = chosen.length;
  const usage = sizes.map((s) => new Array<number>(s).fill(0));
  const distance = (a: number[], b: number[]) => a.reduce((d, x, i) => d + (x === b[i] ? 0 : 1), 0);
  while (chosen.length - fixed < count) {
    let best: number[] | null = null;
    let bestDist = -1;
    let bestUse = Infinity;
    for (const c of candidates) {
      const d = chosen.length === 0 ? axes.length : Math.min(...chosen.map((x) => distance(c, x)));
      if (d === 0) continue;
      const use = c.reduce((u, x, i) => u + usage[i]![x]!, 0);
      if (d > bestDist || (d === bestDist && use < bestUse)) {
        best = c;
        bestDist = d;
        bestUse = use;
      }
    }
    if (!best) break;
    chosen.push(best);
    best.forEach((x, i) => usage[i]![x]!++);
  }
  const items = chosen.slice(fixed).map((c) => Object.fromEntries(axes.map((k, i) => [k, pools[k]![c[i]!]!])));
  return { items, shortfall: items.length < count ? 'variation_space_exhausted' : null };
}

export interface PromptSection {
  readonly key: string;
  readonly title: string;
  readonly text: string;
}

export interface PromptContent {
  readonly sections: readonly PromptSection[];
  readonly caption: string;
}

const fill = (text: string, vars: Readonly<Record<string, string>>): string =>
  text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (whole, key: string) => (key in vars ? vars[key]! : whole));

/** All values a prompt's placeholders resolve to. */
export function promptVariables(
  t: PromptTemplate,
  config: TemplateConfig,
  axes: Readonly<Record<string, string>>,
  slots: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    duration_seconds: String(config.video.durationSeconds),
    aspect_ratio: config.video.aspectRatio,
    ...config.values,
    ...axes,
    ...slots,
  };
}

/** Renders one prompt from the template: sections and caption, every placeholder filled. */
export function renderContent(t: PromptTemplate, config: TemplateConfig, axes: Readonly<Record<string, string>>, slots: Readonly<Record<string, string>>): PromptContent {
  const vars = promptVariables(t, config, axes, slots);
  const sections = t.sections.map((s) => ({ key: s.key, title: s.title, text: fill(s.text, vars).replace(/[ \t]+/g, ' ').trim() }));
  let caption = fill(t.caption.pattern, { ...vars, hashtags: config.hashtags.join(' ') }).replace(/\s+/g, ' ').trim();
  if (caption.length > t.caption.maxLength) caption = caption.slice(0, t.caption.maxLength).trimEnd();
  return { sections, caption };
}

/** The text pasted into Google Flow. */
export const renderText = (c: PromptContent): string => c.sections.map((s) => `${s.title}: ${s.text}`).join('\n\n');

/** Consistency values (character, world, style…) that must appear verbatim. */
export const consistencyValues = (t: PromptTemplate, config: TemplateConfig): string[] =>
  t.variables.filter((v) => v.kind === 'consistency' && t.sections.some((s) => placeholdersIn(s.text).includes(v.key))).map((v) => config.values[v.key] ?? '').filter((x) => x !== '');

/** Checks that don't depend on the other prompts of the batch. */
export function contentFlags(t: PromptTemplate, config: TemplateConfig, content: PromptContent): PromptFlag[] {
  const flags: PromptFlag[] = [];
  const text = renderText(content);
  if (/\{\{\s*[a-z0-9_]+\s*\}\}/.test(text + content.caption)) flags.push('unresolved_placeholder');
  if (text.length > MAX_PROMPT_CHARS) flags.push('too_long');
  if (consistencyValues(t, config).some((v) => !text.includes(v))) flags.push('consistency_missing');
  if (t.references.requirement === 'required' && config.referenceAssetIds.length === 0) flags.push('reference_missing');
  return flags;
}

const words = (s: string): string[] => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
const shingles = (s: string, n = 3): Set<string> => {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};

export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/**
 * Near-duplicates within a batch. Text shared by every prompt (template
 * boilerplate, character and world blocks) is ignored, so the comparison
 * is about what actually varies. Returns, per prompt, the indexes it is too
 * similar to.
 */
export function nearDuplicates(texts: readonly string[], threshold = NEAR_DUPLICATE_THRESHOLD): number[][] {
  const sets = texts.map((t) => shingles(t));
  const common = sets.length > 1 ? new Set([...sets[0]!].filter((g) => sets.every((s) => s.has(g)))) : new Set<string>();
  const varying = sets.map((s) => new Set([...s].filter((g) => !common.has(g))));
  const result = texts.map(() => [] as number[]);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = varying[i]!;
      const b = varying[j]!;
      const union = new Set([...a, ...b]).size;
      const inter = [...a].filter((g) => b.has(g)).length;
      const sim = union === 0 ? 1 : inter / union;
      if (sim >= threshold) {
        result[i]!.push(j);
        result[j]!.push(i);
      }
    }
  }
  return result;
}

/** Steps the owner must do by hand for this prompt's reference assets. */
export function manualSteps(t: PromptTemplate, assets: ReadonlyArray<{ name: string; kind: ReferenceKind }>): string[] {
  const steps: string[] = [];
  for (const a of assets) {
    if (t.references.flowSupport === 'unsupported') {
      steps.push(`Manual action: "${a.name}" is a ${t.references.purpose} reference, and Google Flow has no verified control for it. Recreate it from the prompt's description or apply it by hand.`);
    } else {
      steps.push(`Manual action: upload "${a.name}" in Google Flow as a ${t.references.purpose} reference before generating.`);
    }
  }
  if (t.references.requirement === 'required' && assets.length === 0) steps.push('A reference file is required for this template: attach one in the configuration.');
  return steps;
}
