import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, EMPTY_STRATEGY, type ResearchProvider, type ResearchProviderDescriptor } from '@ugc/core';
import { SYNTHETIC_EXPECTATIONS, SYNTHETIC_REJECTED_ROWS, SYNTHETIC_ROW_COUNT, syntheticReferenceCsv, syntheticVideoId, syntheticVideoUrl } from '@ugc/test-fixtures';
import { GrowthError, GrowthService } from '../src/main/growth.js';
import { BundleStore, MetadataDb, ProfileStore } from '../src/main/profiles.js';

const NOW = new Date('2026-10-22T12:00:00Z');

function setup(mode: 'account_growth' | 'affiliate_ugc' = 'account_growth') {
  const userData = mkdtempSync(join(tmpdir(), 'ugc-growth-'));
  const meta = MetadataDb.open(userData);
  const bundles = new BundleStore(meta);
  const lines: string[] = [];
  const service = new GrowthService(meta, bundles, createLogger((l) => lines.push(l)), () => NOW);
  const bundle = bundles.create({ displayName: 'Growth 01', mode }, [], new ProfileStore(meta));
  return { userData, meta, bundles, service, bundle, lines };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof GrowthError ? e.code : 'other';
  }
  return undefined;
};

describe('growth service (SQLite, synthetic data)', () => {
  it('imports the synthetic CSV and scores every scenario as expected', () => {
    const { service, bundle, lines } = setup();
    const result = service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    expect(result).toMatchObject({ added: SYNTHETIC_ROW_COUNT - SYNTHETIC_REJECTED_ROWS, updated: 0, rejected: SYNTHETIC_REJECTED_ROWS, ignoredColumns: 0 });
    expect(result.rows.filter((r) => r.status === 'rejected').map((r) => r.issues)).toEqual([['short_link_unsupported'], ['invalid_views']]);

    const view = service.view(bundle.id);
    expect(view.strategySaved).toBe(false);
    const byN = (n: number) => view.references.find((r) => r.platformVideoId === syntheticVideoId(n))!;
    for (const [name, e] of Object.entries(SYNTHETIC_EXPECTATIONS)) {
      const a = byN(e.n).assessment;
      expect(a.verdict, name).toBe(e.verdict);
      if ('confidence' in e) expect(a.confidence, name).toBe(e.confidence);
      if ('reason' in e) expect(a.reasons, name).toContain(e.reason);
    }
    expect(view.shortlist).toEqual([byN(10).id, byN(26).id]);
    // Logs carry counts, never URLs, handles or numbers from the research.
    expect(lines.join('\n')).not.toMatch(/synth\.|tiktok\.com|150000/);
  });

  it('re-importing updates instead of duplicating; manual entry upserts by video id', () => {
    const { service, bundle } = setup();
    service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    const again = service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    expect(again).toMatchObject({ added: 0, updated: SYNTHETIC_ROW_COUNT - SYNTHETIC_REJECTED_ROWS });
    expect(service.addReference(bundle.id, { url: syntheticVideoUrl('synth.kitchen.lab', 10), views: '200000', pinned: true })).toBe('updated');
    expect(service.addReference(bundle.id, { url: syntheticVideoUrl('synth.kitchen.lab', 77), views: '1000' })).toBe('added');
    expect(service.references(bundle.id)).toHaveLength(SYNTHETIC_ROW_COUNT - SYNTHETIC_REJECTED_ROWS + 1);
  });

  it('re-importing keeps what the owner set when the row leaves it blank', () => {
    const { service, bundle } = setup();
    service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    const target = service.references(bundle.id).find((r) => r.platformVideoId === syntheticVideoId(1))!;
    service.updateReference(bundle.id, target.id, { publishedAt: target.publishedAt, views: '18000', relevance: 'relevant', note: 'owner note', pinned: true });
    service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    expect(service.references(bundle.id).find((r) => r.id === target.id)).toMatchObject({ relevance: 'relevant', note: 'owner note', pinned: true });
    // A row without any metrics doesn't erase stored ones.
    service.importCsv(bundle.id, `url
${syntheticVideoUrl('synth.kitchen.lab', 1)}
`);
    expect(service.references(bundle.id).find((r) => r.id === target.id)!.metrics.views).toEqual({ value: 18000, exactness: 'exact' });
  });

  it('edits metrics, relevance and pin; the URL cannot change', () => {
    const { service, bundle } = setup();
    service.addReference(bundle.id, { url: syntheticVideoUrl('synth.a', 1), publishedAt: '2026-10-15', views: '5000' });
    const [ref] = service.references(bundle.id);
    service.updateReference(bundle.id, ref!.id, { url: syntheticVideoUrl('synth.other', 9), views: '1.5K', publishedAt: '2026-10-15', relevance: 'relevant', pinned: true });
    const [after] = service.references(bundle.id);
    expect(after).toMatchObject({ url: ref!.url, creatorHandle: 'synth.a', relevance: 'relevant', pinned: true, metrics: { views: { value: 1500, exactness: 'rounded' } } });
    expect(service.view(bundle.id).shortlist).toEqual([ref!.id]); // pinned, unverified
    expect(code(() => service.updateReference(bundle.id, ref!.id, { views: 'lots' }))).toBe('invalid_reference');
    expect(code(() => service.updateReference(bundle.id, '00000000-0000-4000-8000-000000000000', {}))).toBe('unknown_reference');
    service.removeReference(bundle.id, ref!.id);
    expect(service.references(bundle.id)).toHaveLength(0);
  });

  it('saves the strategy; thresholds re-score the references', () => {
    const { service, bundle } = setup();
    service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    expect(code(() => service.saveStrategy(bundle.id, { ...EMPTY_STRATEGY, niche: '' }))).toBe('invalid_strategy');
    service.saveStrategy(bundle.id, { ...EMPTY_STRATEGY, niche: 'synthetic kitchen', thresholds: { ...EMPTY_STRATEGY.thresholds, outlierThreshold: 8 } });
    const view = service.view(bundle.id);
    expect(view.strategySaved).toBe(true);
    expect(view.strategy.niche).toBe('synthetic kitchen');
    expect(view.shortlist).toEqual([]); // 7.4× and 4.3× are below 8×
  });

  it('manages reference creators (handle or profile link)', () => {
    const { service, bundle } = setup();
    service.addCreator(bundle.id, '@Synth.Kitchen.Lab', 'synthetic');
    service.addCreator(bundle.id, 'https://www.tiktok.com/@synth.clean.daily', '');
    service.addCreator(bundle.id, 'synth.kitchen.lab', 'updated note');
    expect(code(() => service.addCreator(bundle.id, 'not a handle!', ''))).toBe('invalid_creator');
    service.importCsv(bundle.id, syntheticReferenceCsv(NOW));
    const { creators } = service.view(bundle.id);
    expect(creators.map((c) => [c.handle, c.note, c.videoCount])).toEqual([
      ['synth.kitchen.lab', 'updated note', 12],
      ['synth.clean.daily', '', 8],
    ]);
    service.removeCreator(bundle.id, creators[0]!.id);
    expect(service.view(bundle.id).creators).toHaveLength(1);
  });

  it('refuses non-growth accounts and malformed CSV', () => {
    const { service, bundle } = setup('affiliate_ugc');
    expect(code(() => service.view(bundle.id))).toBe('not_growth_account');
    expect(code(() => service.importCsv(bundle.id, 'url\nx'))).toBe('not_growth_account');
    const g = setup();
    expect(code(() => g.service.importCsv(g.bundle.id, 'views\n1'))).toBe('invalid_csv');
  });

  it('an unattended research source runs only with a recorded automated-retrieval authorization', async () => {
    const { service, bundle } = setup();
    const descriptor = (automated: boolean): ResearchProviderDescriptor => ({
      id: 'synthetic-licensed',
      displayName: 'Synthetic licensed source',
      authorization: { automation: automated ? 'permitted' : 'not_permitted', aiDataUse: 'not_permitted', basis: 'synthetic test source' },
    });
    const provider = (automated: boolean): ResearchProvider => ({ descriptor: descriptor(automated), search: async () => [{ url: syntheticVideoUrl('synth.a', 1), views: '1000' }] });
    const query = { market: 'ID', keywords: ['synthetic'] };
    await expect(service.importFromProvider(bundle.id, provider(false), query)).rejects.toMatchObject({ code: 'source_not_authorized' });
    expect(service.references(bundle.id)).toHaveLength(0);
    await expect(service.importFromProvider(bundle.id, provider(true), query)).resolves.toMatchObject({ added: 1 });
    expect(service.references(bundle.id)[0]!.source).toBe('synthetic-licensed');
  });
});
