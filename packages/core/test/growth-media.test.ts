import { describe, expect, it } from 'vitest';
import {
  captionFlags,
  contentFlags,
  FYP_VARIATION_TEMPLATE,
  fypVariationConfig,
  normalizeHashtags,
  parseModelJson,
  referenceInstructions,
  renderContent,
  renderText,
  validateReferenceAnalysis,
  validateVariations,
  validateVideoAnalysis,
  variationInstructions,
  videoCaptionInstructions,
} from '../src/index.js';

describe('Ternak Akun media analysis rules', () => {
  it('video analysis: only an understood video with a caption is captioned; values are cleaned', () => {
    expect(validateVideoAnalysis({ understood: true, confidence: 0.9, summary: 'A cat jumps', caption: ' Kucing ini loncat tinggi banget! ', hashtags: ['Kucing', '#lucu!', '#kucing'] })).toEqual({
      understood: true,
      confidence: 0.9,
      summary: 'A cat jumps',
      caption: 'Kucing ini loncat tinggi banget!',
      hashtags: ['#kucing', '#lucu'],
    });
    // "Understood" without a caption, or not understood: no caption is invented.
    expect(validateVideoAnalysis({ understood: true, confidence: 1, caption: '' })).toMatchObject({ understood: false, caption: '', hashtags: [] });
    expect(validateVideoAnalysis({ understood: false, caption: 'made up', hashtags: ['#x'] })).toMatchObject({ understood: false, caption: '' });
    expect(validateVideoAnalysis({ caption: 'no flag' })).toBeNull();
    expect(normalizeHashtags(['#a', 'masak hemat', '##Resep', 'x'.repeat(50)])).toEqual(['#masakhemat', '#resep']);
  });

  it('flags unclear, low-confidence, generic and repetitive captions', () => {
    const base = { understood: true, confidence: 0.9, summary: 's', caption: 'Cara melipat baju dalam lima detik, kamu bisa?', hashtags: ['#lipatbaju'] };
    expect(captionFlags(base, [])).toEqual([]);
    expect(captionFlags({ ...base, understood: false }, [])).toEqual(['unclear_video']);
    expect(captionFlags({ ...base, confidence: 0.3 }, [])).toEqual(['low_confidence']);
    expect(captionFlags({ ...base, caption: 'Wajib nonton!' }, [])).toEqual(['generic_caption']);
    expect(captionFlags(base, ['Cara melipat baju dalam lima detik, kamu bisa?'])).toEqual(['repetitive_caption']);
    expect(captionFlags({ ...base, hashtags: [] }, [])).toEqual(['no_hashtags']);
  });

  it('reference breakdowns and variations are validated; incomplete ones are dropped', () => {
    expect(validateReferenceAnalysis({ hook: 'Result first', structure: ['a', 'b'], pacing: 'fast', attention: ['x'], format: 'Reveal then steps', audio: 'beat' })).toMatchObject({ hook: 'Result first' });
    expect(validateReferenceAnalysis({ hook: 'h', structure: [], format: 'f' })).toBeNull();
    const v = validateVariations({ variations: [{ hook: 'h', scene: 's', action: 'a', style: 'st', audio: 'au', caption: 'c' }, { hook: 'missing scene' }, { hook: 'h2', scene: 's2', action: 'a2' }] }, 5);
    expect(v.map((x) => x.hook)).toEqual(['h', 'h2']);
    expect(validateVariations({ variations: [{ hook: 'h', scene: 's', action: 'a' }, { hook: 'h', scene: 's', action: 'a' }] }, 1)).toHaveLength(1);
    expect(parseModelJson('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('no json')).toBeNull();
  });

  it('instructions keep captions to the actual video and variations original (no niche anywhere)', () => {
    const cap = videoCaptionInstructions({ note: 'resep warung', recentCaptions: ['Old caption one'] });
    expect(cap).toContain('ONLY on what is actually visible or audible');
    expect(cap).toContain('"understood" to false');
    expect(cap).toContain('Old caption one');
    expect(cap).toContain('resep warung');
    expect(cap.toLowerCase()).not.toContain('niche');
    expect(referenceInstructions('')).toContain('Describe the FORMAT, not the specific content');
    const ref = { hook: 'h', structure: ['a', 'b'], pacing: 'p', attention: ['x'], format: 'f', audio: 'au' };
    const v = variationInstructions(ref, 3, { durationSeconds: 8, aspectRatio: '9:16' }, ['old hook']);
    expect(v).toContain('Write 3 ORIGINAL');
    expect(v).toContain('Never copy the reference');
    expect(v).toContain('old hook');
  });

  it('the FYP variation template renders complete Flow prompts with no content flags', () => {
    const content = renderContent(FYP_VARIATION_TEMPLATE, fypVariationConfig(1), {}, { scene: 'A kitchen', hook: 'Pot overflows', action: 'Beats', style: 'Handheld', audio: 'Sizzle', caption_line: 'Caption' });
    const text = renderText(content);
    expect(text).toContain('Scene: Vertical 9:16, 8 seconds. A kitchen');
    expect(text).toContain('Hook (first 1–2 seconds): Pot overflows');
    expect(content.caption).toBe('Caption');
    expect(contentFlags(FYP_VARIATION_TEMPLATE, fypVariationConfig(1), content)).toEqual([]);
  });
});
