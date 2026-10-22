import { describe, expect, it } from 'vitest';
import {
  ASMR_TEMPLATE,
  buildConceptRequest,
  consistencyValues,
  contentFlags,
  DANCE_TEMPLATE,
  defaultConfig,
  GRANDMA_TEMPLATE,
  manualSteps,
  nearDuplicates,
  payloadIsSafe,
  planVariations,
  PROMPT_ACTIONS,
  renderContent,
  renderText,
  STARTER_TEMPLATES,
  TemplateProvider,
  validateConceptResponse,
  validateConfig,
  validateTemplate,
  type PromptTemplate,
  type TemplateConfig,
} from '../src/index.js';

async function batch(t: PromptTemplate, config: TemplateConfig = defaultConfig(t), seed = 'synthetic-seed') {
  const plan = planVariations(config.pools, config.count, seed);
  const items = plan.items.map((axes, i) => ({ position: i + 1, axes }));
  const request = buildConceptRequest(t, config, items, seed);
  const response = await new TemplateProvider().fill(request);
  const contents = items.map((it, i) => renderContent(t, config, it.axes, response.items[i]!.slots));
  return { plan, request, response, contents, texts: contents.map(renderText) };
}

describe('starter templates', () => {
  it.each(STARTER_TEMPLATES.map((t) => [t.name, t] as const))('%s validates and yields 10 complete, distinct, consistent prompts', async (_name, t) => {
    expect(validateTemplate(t)).toMatchObject({ ok: true });
    const config = defaultConfig(t);
    expect(config.count).toBe(10);
    const { plan, texts, contents } = await batch(t, config);
    expect(plan.items).toHaveLength(10);
    expect(new Set(texts).size).toBe(10);
    for (const [k, text] of texts.entries()) {
      // Production-grade: long, structured, every section present, nothing left unfilled.
      expect(text.length).toBeGreaterThan(900);
      expect(text.length).toBeLessThan(4000);
      for (const s of t.sections) expect(text).toContain(`${s.title}: `);
      expect(text).not.toMatch(/\{\{/);
      // The character/world/style text appears word for word in every prompt.
      for (const v of consistencyValues(t, config)) expect(text).toContain(v);
      expect(contentFlags(t, config, contents[k]!)).toEqual([]);
      expect(contents[k]!.caption.length).toBeLessThanOrEqual(t.caption.maxLength);
      expect(contents[k]!.caption).toContain(t.caption.hashtags[0]!);
    }
    expect(nearDuplicates(texts).every((d) => d.length === 0)).toBe(true);
  });

  it('starter characters are fictional and name no real creator, song or brand', () => {
    expect(GRANDMA_TEMPLATE.variables.find((v) => v.key === 'character')!.default).toContain('original fictional');
    expect(DANCE_TEMPLATE.variables.find((v) => v.key === 'character')!.default).toContain('not based on any real person');
    for (const t of STARTER_TEMPLATES) expect(JSON.stringify(t)).not.toMatch(/https?:\/\/|@[a-z]/i);
  });

  it('every pair of prompts in a batch differs in at least two variation axes', async () => {
    for (const t of STARTER_TEMPLATES) {
      const { plan } = await batch(t);
      for (let i = 0; i < plan.items.length; i++) {
        for (let j = i + 1; j < plan.items.length; j++) {
          const diff = Object.keys(plan.items[i]!).filter((k) => plan.items[i]![k] !== plan.items[j]![k]).length;
          expect(diff, `${t.key} #${i + 1} vs #${j + 1}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe('template validation', () => {
  const base = (patch: Record<string, unknown>) => ({ ...ASMR_TEMPLATE, key: 'custom-abc', builtin: false, ...patch });

  it('accepts an owner template derived from a starter', () => {
    expect(validateTemplate(base({ name: 'My ASMR' }))).toMatchObject({ ok: true, value: { key: 'custom-abc', name: 'My ASMR', builtin: false } });
  });

  it.each([
    ['unknown placeholder in a section', base({ sections: [{ key: 'scene', title: 'Scene', text: 'Uses {{nope}}' }] }), 'unknown_placeholder'],
    ['unknown placeholder in the caption', base({ caption: { ...ASMR_TEMPLATE.caption, pattern: '{{nope}}' } }), 'unknown_placeholder'],
    ['empty pool', base({ variables: ASMR_TEMPLATE.variables.map((v) => (v.kind === 'pool' ? { ...v, options: [] } : v)) }), 'invalid_options'],
    ['choice default not an option', base({ variables: [...ASMR_TEMPLATE.variables, { key: 'lang', label: 'L', kind: 'choice', required: true, default: 'x', options: ['a'], help: '' }] }), 'invalid_options'],
    ['duplicate keys', base({ variables: [...ASMR_TEMPLATE.variables, ASMR_TEMPLATE.variables[0]] }), 'duplicate_key'],
    ['no varying list', base({ variables: ASMR_TEMPLATE.variables.filter((v) => v.kind !== 'pool'), sections: [{ key: 's', title: 'S', text: 'x' }] }), 'no_variation'],
    ['bad hashtags', base({ caption: { ...ASMR_TEMPLATE.caption, hashtags: ['no hash'] } }), 'invalid_caption'],
    ['bad key', base({ key: 'Custom Key' }), 'invalid_template_key'],
    ['no sections', base({ sections: [] }), 'invalid_sections'],
    ['bad video', base({ video: { aspectRatio: '4:3', durationSeconds: 8, quality: 'fast' } }), 'invalid_video'],
    ['bad reference spec', base({ references: { ...ASMR_TEMPLATE.references, requirement: 'required', kinds: [] } }), 'invalid_reference_spec'],
  ])('rejects %s', (_name, raw, issue) => {
    const r = validateTemplate(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain(issue);
  });

  it('accepts long structured prompts', () => {
    const long = 'Detailed instruction with {{trigger}}. '.repeat(90);
    expect(validateTemplate(base({ sections: [...ASMR_TEMPLATE.sections, { key: 'long', title: 'Long', text: long }] })).ok).toBe(true);
  });
});

describe('account configuration', () => {
  it('validates values, pools, count, video and hashtags', () => {
    const t = GRANDMA_TEMPLATE;
    expect(validateConfig(t, defaultConfig(t)).ok).toBe(true);
    const bad = validateConfig(t, {
      ...defaultConfig(t),
      values: { ...defaultConfig(t).values, character: '' },
      pools: { ...defaultConfig(t).pools, message: ['  '] },
      count: 0,
      video: { aspectRatio: '9:16', durationSeconds: 99, quality: 'fast' },
      hashtags: ['nohash'],
    });
    expect(bad).toEqual({ ok: false, issues: expect.arrayContaining(['missing_required_value', 'pool_empty', 'invalid_count', 'invalid_video', 'invalid_hashtags']) });
    expect(validateConfig(t, { ...defaultConfig(t), count: 21 }).ok).toBe(false);
    const extra = validateConfig(t, { ...defaultConfig(t), values: { ...defaultConfig(t).values, unknown: 'x' } });
    expect(extra.ok && 'unknown' in extra.value.values).toBe(false);
  });
});

describe('variation planning', () => {
  it('is deterministic per seed and spreads options evenly', () => {
    const pools = { a: ['a1', 'a2', 'a3', 'a4', 'a5'], b: ['b1', 'b2'], c: ['c1', 'c2', 'c3', 'c4'] };
    const one = planVariations(pools, 10, 's');
    expect(planVariations(pools, 10, 's')).toEqual(one);
    expect(planVariations(pools, 10, 'other')).not.toEqual(one);
    const uses = (k: string) => {
      const counts = new Map<string, number>();
      for (const i of one.items) counts.set(i[k]!, (counts.get(i[k]!) ?? 0) + 1);
      return [...counts.values()];
    };
    expect(uses('a')).toEqual([2, 2, 2, 2, 2]);
    expect(uses('b')).toEqual([5, 5]);
    expect(new Set(one.items.map((i) => JSON.stringify(i))).size).toBe(10);
  });

  it('never repeats a combination: small pools return fewer with a shortfall', () => {
    const r = planVariations({ a: ['1', '2'], b: ['x', 'y'] }, 10, 's');
    expect(r.items).toHaveLength(4);
    expect(r.shortfall).toBe('variation_space_exhausted');
  });

  it('avoids combinations used before', () => {
    const pools = { a: ['1', '2', '3'], b: ['x', 'y'] };
    const first = planVariations(pools, 3, 's').items;
    const second = planVariations(pools, 3, 's2', first).items;
    for (const c of second) expect(first.some((f) => f['a'] === c['a'] && f['b'] === c['b'])).toBe(false);
  });
});

describe('prompt checks', () => {
  it('flags a changed character, leftovers, length and a missing required reference', async () => {
    const t = ASMR_TEMPLATE;
    const config = defaultConfig(t);
    const { contents } = await batch(t, config);
    const c = contents[0]!;
    const changed = { ...c, sections: c.sections.map((s) => (s.key === 'scene' ? { ...s, text: s.text.replace('brushed-silver ring', 'gold ring') } : s)) };
    expect(contentFlags(t, config, changed)).toEqual(['consistency_missing']);
    const leftover = { ...c, sections: [...c.sections, { key: 'x', title: 'X', text: '{{trigger}}' }] };
    expect(contentFlags(t, config, leftover)).toContain('unresolved_placeholder');
    const long = { ...c, sections: [...c.sections, { key: 'x', title: 'X', text: 'y'.repeat(4000) }] };
    expect(contentFlags(t, config, long)).toContain('too_long');
    const required = { ...DANCE_TEMPLATE, references: { ...DANCE_TEMPLATE.references, requirement: 'required' as const } };
    expect(contentFlags(required, defaultConfig(required), c)).toContain('reference_missing');
  });

  it('detects near-duplicates on what varies, not on the shared character text', () => {
    const shared = 'The same long character description appears in every prompt word for word here. ';
    const texts = [`${shared} slicing pastel soap with a blade slowly`, `${shared} slicing pastel soap with a blade slowly today`, `${shared} pouring honey from a dipper into a jar`];
    expect(nearDuplicates(texts)).toEqual([[1], [0], []]);
  });

  it('marks references without a verified Flow control as manual action', () => {
    expect(manualSteps(DANCE_TEMPLATE, [{ name: 'moves.mp4', kind: 'video' }])[0]).toContain('no verified control');
    expect(manualSteps(GRANDMA_TEMPLATE, [{ name: 'nenek.png', kind: 'image' }])[0]).toContain('upload "nenek.png" in Google Flow');
    expect(manualSteps(GRANDMA_TEMPLATE, [])).toEqual([]);
  });
});

describe('concept provider boundary', () => {
  it('the template provider is deterministic, offline and returns valid output', async () => {
    const a = await batch(GRANDMA_TEMPLATE);
    const b = await batch(GRANDMA_TEMPLATE);
    expect(a.response).toEqual(b.response);
    expect(validateConceptResponse(a.request, a.response)).toBe(true);
    expect(new TemplateProvider().descriptor).toMatchObject({ kind: 'deterministic', remote: false });
  });

  it('requests carry only template text, creative values and planned axes', async () => {
    const { request } = await batch(ASMR_TEMPLATE);
    expect(Object.keys(request).sort()).toEqual(['items', 'seed', 'template', 'values']);
    expect(Object.keys(request.template).sort()).toEqual(['name', 'niche', 'sections', 'slots']);
  });

  it('the payload guard catches planted sensitive values', async () => {
    const config = defaultConfig(ASMR_TEMPLATE);
    const planted = { ...config, values: { ...config.values, world: `${config.values['world']} Synthetic Account 07 proxy-07.synthetic.test` } };
    const { request } = await batch(ASMR_TEMPLATE, planted);
    expect(payloadIsSafe(request, ['Synthetic Account 07'])).toBe(false);
    expect(payloadIsSafe(request, ['proxy-07.synthetic.test'])).toBe(false);
    expect(payloadIsSafe(request, ['Unrelated Name', 'ab'])).toBe(true);
  });

  it.each([
    ['a URL', (s: Record<string, string>) => ({ ...s, opening: 'see https://example.test' })],
    ['a handle', (s: Record<string, string>) => ({ ...s, opening: 'like @somecreator does' })],
    ['a placeholder', (s: Record<string, string>) => ({ ...s, opening: '{{trigger}}' })],
    ['a missing slot', (s: Record<string, string>) => ({ ...s, opening: undefined as unknown as string })],
    ['an empty slot', (s: Record<string, string>) => ({ ...s, opening: ' ' })],
  ])('rejects provider output with %s', async (_name, mutate) => {
    const { request, response } = await batch(ASMR_TEMPLATE);
    const bad = { items: response.items.map((i, k) => (k === 0 ? { ...i, slots: JSON.parse(JSON.stringify(mutate({ ...i.slots }))) } : i)) };
    expect(validateConceptResponse(request, bad)).toBe(false);
    expect(validateConceptResponse(request, { items: response.items.slice(1) })).toBe(false);
    expect(validateConceptResponse(request, null)).toBe(false);
  });
});

describe('prompt statuses', () => {
  it('approval is separate from production: only queued prompts go to generation', () => {
    expect(PROMPT_ACTIONS.approve).toEqual({ from: ['draft'], to: 'approved' });
    expect(PROMPT_ACTIONS.queue.from).toEqual(['approved']);
    expect(PROMPT_ACTIONS.start_manual.from).toEqual(['queued']);
    // No action makes a video ready: only a linked video file does.
    expect(Object.values(PROMPT_ACTIONS).some((a) => a.to === 'video_ready')).toBe(false);
    expect(Object.values(PROMPT_ACTIONS).some((a) => a.from.includes('video_ready'))).toBe(false);
  });
});
