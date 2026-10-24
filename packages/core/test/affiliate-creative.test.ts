import { describe, expect, it } from 'vitest';
import {
  checkClip,
  checkFinal,
  DEFAULT_AFFILIATE_CONFIG,
  parseProbe,
  planClipPairs,
  planFlags,
  productBlock,
  productReadiness,
  renderText,
  stitchArgs,
  validateAffiliateConfig,
  type ProductFacts,
} from '../src/index.js';

const FACTS: ProductFacts = {
  title: 'Kipas Angin Mini Sintetis',
  shopName: 'Toko Sintetis',
  priceIdr: 89000,
  commissionPct: 12,
  features: ['3 kecepatan angin', 'baterai isi ulang USB-C', 'bisa dilipat'],
  references: [],
  notes: '',
};

describe('product readiness', () => {
  it('needs a confirmed listing, a title and at least one verified feature', () => {
    expect(productReadiness(FACTS, 'confirmed')).toEqual([]);
    expect(productReadiness({ ...FACTS, title: ' ', features: [] }, 'unverified')).toEqual(['listing_not_confirmed', 'title_missing', 'no_verified_features']);
  });
});

describe('clip-pair plans', () => {
  it('10 distinct plans; product identity verbatim in both clips; only verified features; Indonesian dialogue', () => {
    const { plans, shortfall } = planClipPairs(FACTS, DEFAULT_AFFILIATE_CONFIG, 'seed-1', { hasReferenceImage: true });
    expect(shortfall).toBe(false);
    expect(plans).toHaveLength(10);
    expect(new Set(plans.map((p) => renderText(p.clipA) + renderText(p.clipB))).size).toBe(10);
    const block = productBlock(FACTS, true);
    for (const p of plans) {
      const a = renderText(p.clipA);
      const b = renderText(p.clipB);
      expect(a).toContain(block);
      expect(b).toContain(block);
      expect(a).toMatch(/^Scene: Clip A of 2: vertical 9:16, 8 seconds/);
      expect(b).toMatch(/^Scene: Clip B of 2: vertical 9:16, 8 seconds/);
      expect(b).toMatch(/keranjang kuning/); // CTA wording only
      expect(FACTS.features).toContain(p.axes['feature']);
      expect(a).toContain(p.axes['feature']!);
      expect(planFlags(FACTS, p, true)).toEqual([]);
      expect(a.length).toBeLessThan(4000);
    }
  });

  it('continuity is configurable: seamless keeps the character in both clips, a cut brings a reactor, mixed alternates', () => {
    const seamless = planClipPairs(FACTS, { ...DEFAULT_AFFILIATE_CONFIG, continuity: 'seamless', count: 3 }, 's').plans;
    for (const p of seamless) {
      expect(p.continuity).toBe('seamless');
      expect(renderText(p.clipB)).toContain('Continues seamlessly from the last frame of Clip A');
      expect(renderText(p.clipB)).toContain(p.axes['character']!);
    }
    const cut = planClipPairs(FACTS, { ...DEFAULT_AFFILIATE_CONFIG, continuity: 'cut', count: 3 }, 's').plans;
    for (const p of cut) {
      expect(p.continuity).toBe('cut');
      expect(p.axes['reactor']).toBeTruthy();
      expect(renderText(p.clipB)).toContain('A deliberate comedic cut');
      expect(renderText(p.clipB)).toContain(p.axes['reactor']!);
      expect(renderText(p.clipB)).not.toContain('last frame of Clip A');
    }
    expect(planClipPairs(FACTS, { ...DEFAULT_AFFILIATE_CONFIG, continuity: 'mixed', count: 4 }, 's').plans.map((p) => p.continuity)).toEqual(['seamless', 'cut', 'seamless', 'cut']);
    // The default is a comedic cut: no last-frame upload in Flow (A3).
    expect(DEFAULT_AFFILIATE_CONFIG.continuity).toBe('cut');
  });

  it('custom characters are used', () => {
    const custom = 'a synthetic grandfather in a batik shirt who loves gadgets';
    const { plans } = planClipPairs(FACTS, { ...DEFAULT_AFFILIATE_CONFIG, characters: [custom], count: 2 }, 's');
    expect(plans.every((p) => renderText(p.clipA).includes(custom))).toBe(true);
  });

  it('flags edits that break product identity, character continuity, or add unverified claims', () => {
    const p = planClipPairs(FACTS, { ...DEFAULT_AFFILIATE_CONFIG, continuity: 'seamless', count: 1 }, 's').plans[0]!;
    const swap = (c: typeof p.clipA, key: string, text: string) => ({ ...c, sections: c.sections.map((s) => (s.key === key ? { ...s, text } : s)) });
    expect(planFlags(FACTS, { ...p!, clipB: swap(p!.clipB, 'product', 'Some fan.') }, false)).toContain('product_block_missing');
    expect(planFlags(FACTS, { ...p!, clipB: swap(p!.clipB, 'scene', 'Clip B with someone else.') }, false)).toContain('character_missing');
    expect(planFlags(FACTS, { ...p!, clipA: swap(p!.clipA, 'dialogue', 'Diskon 50%, original 100%!') }, false)).toContain('unverified_claim');
    expect(planFlags(FACTS, { ...p!, clipA: swap(p!.clipA, 'dialogue', 'Harganya cuma Rp 89.000!') }, false)).toContain('unverified_claim');
    // A claim the owner put in the product sheet is allowed.
    expect(planFlags({ ...FACTS, notes: 'garansi resmi 1 tahun' }, { ...p!, clipA: swap(p!.clipA, 'dialogue', 'Ada garansi resmi!') }, false)).not.toContain('unverified_claim');
  });

  it('validates the creative settings', () => {
    expect(validateAffiliateConfig(DEFAULT_AFFILIATE_CONFIG).ok).toBe(true);
    expect(validateAffiliateConfig({ characters: [], continuity: 'sometimes', count: 0, hashtags: ['no tag'] })).toEqual({
      ok: false,
      issues: expect.arrayContaining(['invalid_pool', 'invalid_continuity', 'invalid_count', 'invalid_hashtags']),
    });
  });
});

describe('FFmpeg helpers', () => {
  const probe = (duration: number, streams: object[], format = 'mov,mp4,m4a,3gp,3g2,mj2') => parseProbe(JSON.stringify({ format: { duration: String(duration), format_name: format }, streams }));
  const v = (w = 1080, h = 1920, rate = '30/1') => ({ codec_type: 'video', codec_name: 'h264', width: w, height: h, avg_frame_rate: rate, pix_fmt: 'yuv420p' });
  const a = { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 };

  it('checks clips (~8 s MP4 with video; audio optional)', () => {
    expect(checkClip(probe(8, [v(), a]))).toEqual({ ok: true, issues: [], hasAudio: true, durationSeconds: 8 });
    expect(checkClip(probe(8.02, [v(720, 1280, '24/1')]))).toMatchObject({ ok: true, hasAudio: false });
    expect(checkClip(probe(3, [a], 'matroska')).issues).toEqual(['not_mp4', 'no_video', 'too_short']);
    expect(checkClip(probe(12, [v()])).issues).toEqual(['too_long']);
  });

  it('checks the finished video (~16 s, 1080×1920, 30 fps, H.264 + AAC)', () => {
    expect(checkFinal(probe(16.1, [v(), a]))).toEqual([]);
    expect(checkFinal(probe(9, [v(720, 1280, '25/1')]))).toEqual(['wrong_duration', 'no_audio', 'wrong_size', 'wrong_fps']);
  });

  it('builds stitch arguments: scale/pad, fps, silence for a silent clip, loudness normalisation, H.264/AAC', () => {
    const args = stitchArgs(
      [
        { file: 'a.mp4', hasAudio: true, durationSeconds: 8 },
        { file: 'b.mp4', hasAudio: false, durationSeconds: 8 },
      ],
      'out.mp4',
    );
    expect(args.slice(0, 7)).toEqual(['-y', '-v', 'error', '-i', 'a.mp4', '-i', 'b.mp4']);
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920');
    expect(graph).toContain('fps=30');
    expect(graph).toContain('[2:a]aresample=48000');
    expect(graph).toContain('concat=n=2:v=1:a=1');
    expect(graph).toContain('loudnorm=I=-14:TP=-1.5');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']));
    expect(args.at(-1)).toBe('out.mp4');
  });
});

describe('character reference sheets', () => {
  it('keys are stable across spacing and case; the sheet prompt and the reference line say what Flow gets', async () => {
    const { characterKey, characterSheetPrompt, referenceLine } = await import('../src/index.js');
    expect(characterKey('An Indonesian  housewife')).toBe(characterKey(' an indonesian housewife '));
    expect(characterKey('a')).not.toBe(characterKey('b'));
    expect(characterKey('x')).toMatch(/^[0-9a-f]{16}$/);
    const sheet = characterSheetPrompt('a synthetic grandmother in a batik blouse', 'Photorealistic.');
    expect(sheet).toContain('Character reference sheet of a synthetic grandmother in a batik blouse.');
    expect(sheet).toContain('full body front view');
    expect(sheet).toContain('Not a real or famous person.');
    expect(referenceLine({ product: true, character: false })).toContain('the product reference image');
    expect(referenceLine({ product: true, character: true })).toContain('; and the character reference sheet');
    expect(referenceLine({ product: false, character: false })).toBe('');
  });
});
