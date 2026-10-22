import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BundleStore, MetadataDb, ProfileStore } from '../src/main/profiles.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ugc-store-'));
const specs = [
  { platformId: 'tiktok', label: 'TikTok', optional: false },
  { platformId: 'kalodata', label: 'Kalodata', optional: true },
];

describe('metadata store (SQLite)', () => {
  it('creates a draft bundle with one isolated session per platform, in one transaction', () => {
    const meta = MetadataDb.open(dir());
    const sessions = new ProfileStore(meta);
    const bundles = new BundleStore(meta);
    const a = bundles.create({ displayName: 'A', mode: 'affiliate_ugc' }, specs, sessions);
    const b = bundles.create({ displayName: 'B', mode: 'account_growth' }, specs, sessions);
    expect(a.proxy).toBeNull();
    const all = sessions.list();
    expect(all).toHaveLength(4);
    expect(new Set(all.map((s) => s.partition)).size).toBe(4); // never shared
    expect(sessions.forBundle(a.id).map((s) => [s.platformId, s.optional, s.status])).toEqual([
      ['tiktok', false, 'never_configured'],
      ['kalodata', true, 'never_configured'],
    ]);
    expect(sessions.forBundle(b.id).every((s) => s.bundleId === b.id)).toBe(true);
    meta.close();
  });

  it('persists updates across reopen and keeps only non-secret columns', () => {
    const d = dir();
    let meta = MetadataDb.open(d);
    const sessions = new ProfileStore(meta);
    const bundles = new BundleStore(meta);
    const a = bundles.create({ displayName: 'A', mode: 'affiliate_ugc' }, specs, sessions);
    bundles.update(a.id, {
      displayName: 'A renamed',
      proxy: {
        protocol: 'http',
        host: 'proxy.example',
        port: 8080,
        hasCredentials: true,
        status: 'ok',
        observedIp: '198.51.100.1',
        endpoint: 'primary',
        testedAt: 'x',
        lastPassedAt: 'x',
        error: null,
      },
    });
    const s = sessions.forBundle(a.id)[0]!;
    sessions.update(s.id, { status: 'confirmed_by_user', statusReason: 'owner_confirmed' });
    meta.close();

    meta = MetadataDb.open(d);
    expect(new BundleStore(meta).get(a.id)).toMatchObject({ displayName: 'A renamed', proxy: { host: 'proxy.example', hasCredentials: true } });
    expect(new ProfileStore(meta).get(s.id)).toMatchObject({ status: 'confirmed_by_user', statusReason: 'owner_confirmed' });
    meta.close();

    const raw = new DatabaseSync(join(d, 'ugc.db'), { readOnly: true });
    const columns = (table: string) => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const all = [...columns('account_bundles'), ...columns('platform_sessions')];
    expect(all.filter((c) => /pass|secret|cookie|token|credential|username/i.test(c))).toEqual([]);
    raw.close();
  });

  it('imports the Gate 1/2 JSON metadata once as bundle-less sessions and renames the file', () => {
    const d = dir();
    const id = '0f8b5a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
    writeFileSync(
      join(d, 'poc-profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id,
            label: 'Profile A',
            platformId: 'kalodata',
            partition: 'persist:ps_1a2b3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
            status: 'confirmed_by_user',
            statusReason: 'owner_confirmed',
            lastImport: null,
            sessionSync: { revision: 7, savedCount: 2, savedAt: 'x', saveError: null, restore: null },
          },
        ],
      }),
    );
    const meta = MetadataDb.open(d);
    const imported = new ProfileStore(meta).get(id);
    expect(imported).toMatchObject({ bundleId: null, platformId: 'kalodata', status: 'confirmed_by_user', sessionSync: { revision: 7, savedCount: 2 } });
    expect(existsSync(join(d, 'poc-profiles.json'))).toBe(false);
    expect(existsSync(join(d, 'poc-profiles.json.migrated'))).toBe(true);
    meta.close();
    // Reopening doesn't import again or fail.
    MetadataDb.open(d).close();
  });

  it('read-only mode never creates or changes the database', () => {
    const d = dir();
    const missing = MetadataDb.open(d, { readOnly: true });
    expect(new ProfileStore(missing).list()).toEqual([]);
    expect(existsSync(join(d, 'ugc.db'))).toBe(false);

    const meta = MetadataDb.open(d);
    new BundleStore(meta).create({ displayName: 'A', mode: 'affiliate_ugc' }, specs, new ProfileStore(meta));
    meta.close();
    const before = readFileSync(join(d, 'ugc.db'));
    const ro = MetadataDb.open(d, { readOnly: true });
    expect(new BundleStore(ro).list()).toHaveLength(1);
    expect(() => new ProfileStore(ro).create({ bundleId: null, platformId: 'tiktok', label: 'x', optional: false })).toThrow();
    ro.close();
    expect(readFileSync(join(d, 'ugc.db')).equals(before)).toBe(true);
  });

  it('seeds the two synthetic test profiles only when asked', () => {
    const meta = MetadataDb.open(dir());
    expect(new ProfileStore(meta).list()).toHaveLength(0);
    expect(new ProfileStore(meta, 'synthetic-poc').list().map((p) => p.label)).toEqual(['Synthetic Profile A', 'Synthetic Profile B']);
    expect(new ProfileStore(meta, 'synthetic-poc').list()).toHaveLength(2); // not seeded twice
    meta.close();
  });
});
