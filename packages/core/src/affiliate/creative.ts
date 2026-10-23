import { MAX_PROMPT_CHARS, type VideoSettings } from '../generation/model.js';
import { nearDuplicates, planVariations, renderText, seededRandom, shuffled, type PromptContent } from '../templates/engine.js';
import type { ProductFacts } from './product.js';

/**
 * Affiliate Creative Studio (A2): one finished video = Clip A (8 s: hook and
 * product demonstration) + Clip B (8 s: comedic payoff and CTA), stitched
 * locally. Prompts are written in English for Google Flow with Indonesian
 * dialogue. Product identity is copied verbatim into both clips; character
 * continuity is required only for a seamless continuation, not for a
 * deliberate comedic cut. Only verified features are ever mentioned.
 */

export type ContinuityMode = 'seamless' | 'cut';
export type ContinuityChoice = ContinuityMode | 'mixed';

export interface AffiliateCreativeConfig {
  /** Pools the plans vary over (one option per line in the UI). */
  readonly characters: readonly string[];
  readonly reactors: readonly string[];
  readonly povs: readonly string[];
  readonly hooks: readonly string[];
  readonly setups: readonly string[];
  readonly locations: readonly string[];
  readonly punchlines: readonly string[];
  /** Look shared by both clips. */
  readonly style: string;
  readonly avoid: string;
  readonly continuity: ContinuityChoice;
  readonly count: number;
  readonly hashtags: readonly string[];
  /** Product reference images (owner confirmed rights), by reference asset id. */
  readonly referenceAssetIds: readonly string[];
}

export const CLIP_SETTINGS: VideoSettings = { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' };
export const AFFILIATE_TEMPLATE = { key: 'builtin-affiliate-comedy', version: 1, name: 'Komedi Jualan 2×8 detik' } as const;

export const DEFAULT_AFFILIATE_CONFIG: AffiliateCreativeConfig = {
  characters: [
    'an Indonesian housewife (ibu rumah tangga) in her 30s, hair in a ponytail, pastel home T-shirt and culottes, very expressive and dramatic',
    'an Indonesian university student living in a kos, early 20s, oversized T-shirt and track pants, messy hair, laid-back and funny',
    'an Indonesian ride-hailing driver (bapak ojol) in his 40s, plain green jacket with no logos, friendly, always joking',
    'a young Indonesian office worker (karyawan kantoran) in her late 20s, neat shirt and a plain lanyard, slightly panicked but funny',
  ],
  reactors: [
    "the character's partner in a white T-shirt and sarong, with an exaggerated shocked face",
    'a nosy neighbour auntie (ibu-ibu) in a floral daster peeking in through the door',
    'a roommate in pajamas holding a snack, jaw dropping',
    'a coworker holding an iced coffee, staring in disbelief',
  ],
  povs: [
    'selfie-style front camera, the character talking straight to the lens',
    'over-the-shoulder close-up of the hands using the product',
    'static tripod medium shot in a real home',
    'handheld vlog style with quick punch-in zooms on the product',
  ],
  hooks: [
    'opens on an extreme close-up of the everyday problem with a loud "Aduh!"',
    'the character freezes mid-action and stares into the camera in disbelief',
    'the product is slapped down onto the table into frame on the first beat',
    "a fast whip-pan from the character's frustrated face to the product",
  ],
  setups: [
    'a relatable daily chore keeps going wrong',
    'the character pretends to be calm while chaos happens behind them',
    'a dramatic "before" moment, exaggerated like a soap opera',
    'the character tries an old makeshift trick that fails comically',
  ],
  locations: [
    'a small, tidy Indonesian home kitchen with tiled walls',
    'a cosy kos bedroom with a standing fan and a small desk',
    'a front terrace with potted plants and a motorbike parked outside',
    'a small office pantry with a water dispenser',
  ],
  punchlines: [
    'an exaggerated slow-motion reaction, then a wink at the camera',
    'the character points down at the bottom of the screen with both hands',
    'a mock "case closed" gesture with the product held up next to the face',
    'someone grabs the product and runs off with it',
  ],
  style:
    'Photorealistic, natural daylight, authentic Indonesian everyday setting, handheld phone-camera feel, punchy fast pacing with quick cuts inside the clip, vivid but natural colours.',
  avoid:
    'No other brands or logos, no text overlays or subtitles, no price or discount claims, no medical or "guaranteed" claims, no fake reviews or testimonials, no distorted hands or product, no copyrighted music.',
  continuity: 'mixed',
  count: 10,
  hashtags: ['#racuntiktok', '#tiktokshop', '#rekomendasi'],
  referenceAssetIds: [],
};

/** Indonesian dialogue lines; {{product_name}}, {{feature_a}} and {{feature_b}} are filled from the product sheet. */
const LINES = {
  hook: ['Aduh, capek banget sama ini tiap hari!', 'Kalian pernah ngalamin gini nggak sih?', 'Stop! Jangan pakai cara lama ini lagi!', 'Serius, ini masalah paling nyebelin di rumah!'],
  demo: ['Coba lihat, pakai {{product_name}} langsung beres: {{feature_a}}.', 'Ini dia {{product_name}}. {{feature_a}}, gampang banget!', 'Makanya aku pakai {{product_name}}, soalnya {{feature_a}}.'],
  payoff: ['Terus yang bikin kaget, {{feature_b}}!', 'Bonusnya, {{feature_b}}. Nggak nyangka kan?', 'Dan ternyata {{feature_b}}, langsung heboh semua!'],
  cta: ['Mau juga? Cek keranjang kuning sekarang!', 'Langsung klik keranjang kuning di bawah ya!', 'Buruan cek keranjang kuning, jangan sampai nyesel!'],
  caption: ['Siapa yang butuh ini? 😂', 'Akhirnya nemu solusinya!', 'Wajib punya nggak sih?', 'Tonton sampai akhir 🤣'],
} as const;

export type ConfigIssue = 'invalid_pool' | 'invalid_text' | 'invalid_continuity' | 'invalid_count' | 'invalid_hashtags' | 'invalid_reference_assets';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validateAffiliateConfig(raw: unknown): { ok: true; value: AffiliateCreativeConfig } | { ok: false; issues: ConfigIssue[] } {
  const c = { ...DEFAULT_AFFILIATE_CONFIG, ...((typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>) } as Record<string, unknown>;
  const issues = new Set<ConfigIssue>();
  const pool = (k: string): string[] => {
    const v = c[k];
    if (!Array.isArray(v) || v.length > 40 || !v.every((x) => typeof x === 'string' && x.length <= 400 && !CONTROL.test(x))) {
      issues.add('invalid_pool');
      return [];
    }
    const list = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
    if (list.length === 0) issues.add('invalid_pool');
    return list;
  };
  const value = {
    characters: pool('characters'),
    reactors: pool('reactors'),
    povs: pool('povs'),
    hooks: pool('hooks'),
    setups: pool('setups'),
    locations: pool('locations'),
    punchlines: pool('punchlines'),
    style: typeof c['style'] === 'string' ? c['style'].trim() : '',
    avoid: typeof c['avoid'] === 'string' ? c['avoid'].trim() : '',
    continuity: c['continuity'] as ContinuityChoice,
    count: c['count'] as number,
    hashtags: Array.isArray(c['hashtags']) ? [...new Set(c['hashtags'] as string[])] : [],
    referenceAssetIds: Array.isArray(c['referenceAssetIds']) ? [...new Set(c['referenceAssetIds'] as string[])] : [],
  };
  if (!value.style || value.style.length > 1000 || CONTROL.test(value.style) || value.avoid.length > 1000 || CONTROL.test(value.avoid)) issues.add('invalid_text');
  if (!['seamless', 'cut', 'mixed'].includes(value.continuity)) issues.add('invalid_continuity');
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > 20) issues.add('invalid_count');
  if (value.hashtags.length > 30 || !value.hashtags.every((h) => typeof h === 'string' && /^#[\p{L}\p{N}_]{1,50}$/u.test(h))) issues.add('invalid_hashtags');
  if (value.referenceAssetIds.length > 5 || !value.referenceAssetIds.every((r) => typeof r === 'string' && /^[0-9a-f-]{36}$/.test(r))) issues.add('invalid_reference_assets');
  return issues.size > 0 ? { ok: false, issues: [...issues] } : { ok: true, value };
}

export type ProductIssue = 'title_missing' | 'no_verified_features' | 'listing_not_confirmed';

/** A product can get video plans only with a confirmed listing, its exact title and at least one verified feature. */
export function productReadiness(facts: ProductFacts, listing: string): ProductIssue[] {
  const issues: ProductIssue[] = [];
  if (listing !== 'confirmed') issues.push('listing_not_confirmed');
  if (!facts.title.trim()) issues.push('title_missing');
  if (facts.features.length === 0) issues.push('no_verified_features');
  return issues;
}

/** The product identity block, identical in both clips. */
export function productBlock(facts: ProductFacts, hasReferenceImage: boolean): string {
  return (
    `The product is "${facts.title.trim()}"${facts.shopName ? ` from ${facts.shopName.trim()}` : ''}. ` +
    `It must look exactly the same in every shot of both clips: same shape, colour, size and packaging${hasReferenceImage ? ' as the uploaded product reference image' : ''}. ` +
    'Only this product is shown; no other brands.'
  );
}

export interface ClipPairPlan {
  readonly continuity: ContinuityMode;
  /** Chosen options, by axis. */
  readonly axes: Readonly<Record<string, string>>;
  readonly clipA: PromptContent;
  readonly clipB: PromptContent;
  readonly caption: string;
}

const fill = (text: string, vars: Readonly<Record<string, string>>): string =>
  text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (whole, k: string) => (k in vars ? vars[k]! : whole)).replace(/[ \t]+/g, ' ').trim();

const AXES: Record<string, keyof AffiliateCreativeConfig> = {
  character: 'characters',
  pov: 'povs',
  hook: 'hooks',
  setup: 'setups',
  location: 'locations',
  punchline: 'punchlines',
};

/**
 * Plans `config.count` distinct finished videos for one product (or fewer,
 * if the pools can't give more distinct combinations). Deterministic per seed.
 */
export function planClipPairs(
  facts: ProductFacts,
  config: AffiliateCreativeConfig,
  seed: string,
  options: { hasReferenceImage: boolean; exclude?: ReadonlyArray<Readonly<Record<string, string>>> } = { hasReferenceImage: false },
): { plans: ClipPairPlan[]; shortfall: boolean } {
  const pools: Record<string, readonly string[]> = Object.fromEntries(Object.entries(AXES).map(([axis, key]) => [axis, config[key] as readonly string[]]));
  pools['feature'] = facts.features;
  let plan = planVariations(pools, config.count, seed, options.exclude ?? []);
  if (plan.shortfall && (options.exclude?.length ?? 0) > 0) plan = planVariations(pools, config.count, seed);
  const rand = seededRandom(`${seed}:lines`);
  const order = (list: readonly string[]) => shuffled(list, rand);
  const lines = { hook: order(LINES.hook), demo: order(LINES.demo), payoff: order(LINES.payoff), cta: order(LINES.cta), caption: order(LINES.caption) };
  const reactors = order(config.reactors);
  const product = productBlock(facts, options.hasReferenceImage);
  const plans = plan.items.map((axes, i): ClipPairPlan => {
    const continuity: ContinuityMode = config.continuity === 'mixed' ? (i % 2 === 0 ? 'seamless' : 'cut') : config.continuity;
    const fi = facts.features.indexOf(axes['feature']!);
    const featureB = facts.features.length > 1 ? facts.features[(fi + 1) % facts.features.length]! : axes['feature']!;
    const pick = <T>(list: readonly T[], k: number): T => list[(i + k) % list.length]!;
    const vars: Record<string, string> = {
      ...axes,
      reactor: continuity === 'cut' ? pick(reactors, 0) : '',
      product_name: facts.title.trim(),
      feature_a: axes['feature']!,
      feature_b: featureB,
      product: product,
      style: config.style,
      avoid: config.avoid,
    };
    const say = { hook: fill(pick(lines.hook, 0), vars), demo: fill(pick(lines.demo, 1), vars), payoff: fill(pick(lines.payoff, 2), vars), cta: fill(pick(lines.cta, 3), vars) };
    const clipA: PromptContent = {
      sections: [
        { key: 'scene', title: 'Scene', text: fill('Clip A of 2: vertical 9:16, 8 seconds, fast-paced Indonesian direct-selling comedy for TikTok. The main character is {{character}}.', vars) },
        { key: 'setting', title: 'Setting', text: fill('{{location}}. {{style}}', vars) },
        { key: 'product', title: 'Product', text: product },
        {
          key: 'action',
          title: 'Action',
          text: fill('0–2 s hook: {{hook}}. 2–8 s: {{setup}}, then the character demonstrates {{product_name}} actually working: {{feature_a}}. Camera: {{pov}}.', vars),
        },
        { key: 'dialogue', title: 'Dialogue', text: `In fast, natural Bahasa Indonesia with comic timing, the character says: "${say.hook} ${say.demo}" Lip movements match the words exactly.` },
        { key: 'audio', title: 'Audio', text: 'Clear voice, upbeat background beat made for this video, natural room sound; no copyrighted music.' },
        { key: 'avoid', title: 'Avoid', text: config.avoid },
      ],
      caption: '',
    };
    const clipB: PromptContent = {
      sections:
        continuity === 'seamless'
          ? [
              {
                key: 'scene',
                title: 'Scene',
                text: fill('Clip B of 2: vertical 9:16, 8 seconds. Continues seamlessly from the last frame of Clip A: the same character, wardrobe, place, lighting and camera style. The main character is {{character}}.', vars),
              },
              { key: 'setting', title: 'Setting', text: fill('{{location}}. {{style}}', vars) },
              { key: 'product', title: 'Product', text: product },
              { key: 'action', title: 'Action', text: fill('The moment continues: the character shows {{feature_b}} clearly, the problem is solved, comic payoff. Ends with: {{punchline}}.', vars) },
              { key: 'dialogue', title: 'Dialogue', text: `In fast, natural Bahasa Indonesia, the character says: "${say.payoff} ${say.cta}" Lip movements match the words exactly.` },
              { key: 'audio', title: 'Audio', text: 'Same voice and background beat as Clip A; no copyrighted music.' },
              { key: 'avoid', title: 'Avoid', text: config.avoid },
            ]
          : [
              { key: 'scene', title: 'Scene', text: fill('Clip B of 2: vertical 9:16, 8 seconds. A deliberate comedic cut to a new angle: {{reactor}}.', vars) },
              { key: 'setting', title: 'Setting', text: fill('{{location}}, seen from a different angle. {{style}}', vars) },
              { key: 'product', title: 'Product', text: product },
              {
                key: 'action',
                title: 'Action',
                text: fill('Exaggerated reaction to {{product_name}}, then the product is shown again: {{feature_b}}. Ends with: {{punchline}}.', vars),
              },
              { key: 'dialogue', title: 'Dialogue', text: `In fast, natural Bahasa Indonesia: "${say.payoff} ${say.cta}" Lip movements match the words exactly.` },
              { key: 'audio', title: 'Audio', text: 'Upbeat background beat continuing from Clip A, comic sound effect on the reaction; no copyrighted music.' },
              { key: 'avoid', title: 'Avoid', text: config.avoid },
            ],
      caption: '',
    };
    const caption = `${pick(lines.caption, 0)} ${config.hashtags.join(' ')}`.trim();
    return { continuity, axes: { ...axes, ...(vars['reactor'] ? { reactor: vars['reactor'] } : {}) }, clipA, clipB, caption };
  });
  return { plans, shortfall: plan.shortfall !== null };
}

export type PlanFlag = 'product_block_missing' | 'character_missing' | 'unresolved_placeholder' | 'too_long' | 'unverified_claim' | 'near_duplicate';
export const BLOCKING_PLAN_FLAGS: readonly PlanFlag[] = ['product_block_missing', 'character_missing', 'unresolved_placeholder', 'too_long', 'unverified_claim'];

/** Claims the app can't verify from the product sheet (Indonesian and English). */
const CLAIMS = /\b(diskon|promo|gratis|original|asli|garansi|bpom|halal|menyembuhkan|sembuh|terbukti|klinis|dokter|termurah|nomor\s*1|no\.\s*1|best\s*seller|discount|guarantee[d]?|cure[sd]?|clinically|doctor)\b|100\s*%|\brp\s*\d/i;

/** Checks a plan after generation or after the owner's edits. */
export function planFlags(facts: ProductFacts, plan: Pick<ClipPairPlan, 'continuity' | 'clipA' | 'clipB' | 'axes'>, hasReferenceImage: boolean): PlanFlag[] {
  const flags = new Set<PlanFlag>();
  const a = renderText(plan.clipA);
  const b = renderText(plan.clipB);
  const product = productBlock(facts, hasReferenceImage);
  if (!a.includes(product) || !b.includes(product)) flags.add('product_block_missing');
  if (plan.continuity === 'seamless' && plan.axes['character'] && (!a.includes(plan.axes['character']) || !b.includes(plan.axes['character']))) flags.add('character_missing');
  if (/\{\{\s*[a-z0-9_]+\s*\}\}/.test(a + b)) flags.add('unresolved_placeholder');
  if (a.length > MAX_PROMPT_CHARS || b.length > MAX_PROMPT_CHARS) flags.add('too_long');
  // Claims are allowed only if the owner typed them in the product sheet.
  const sheet = `${facts.title} ${facts.shopName} ${facts.features.join(' ')} ${facts.notes}`;
  const avoid = (c: PromptContent) => c.sections.filter((s) => s.key !== 'avoid').map((s) => s.text).join(' ');
  const claim = CLAIMS.exec(`${avoid(plan.clipA)} ${avoid(plan.clipB)}`);
  if (claim && !new RegExp(claim[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(sheet)) flags.add('unverified_claim');
  return [...flags];
}

/** Near-duplicate plans in a batch (by both clips' varying text). */
export const duplicatePlans = (plans: ReadonlyArray<Pick<ClipPairPlan, 'clipA' | 'clipB'>>): number[][] =>
  nearDuplicates(plans.map((p) => `${renderText(p.clipA)}\n${renderText(p.clipB)}`));

/** Steps the owner does by hand in Google Flow for this plan. */
export function clipManualSteps(continuity: ContinuityMode, slot: 'A' | 'B', referenceNames: readonly string[]): string[] {
  const steps = referenceNames.map((n) => `Upload "${n}" in Google Flow as the product ingredient for this clip.`);
  if (slot === 'B' && continuity === 'seamless') steps.push('Use Clip A\'s last frame (press "Export last frame" on Clip A) as the starting frame in Flow (frames to video).');
  return steps;
}
