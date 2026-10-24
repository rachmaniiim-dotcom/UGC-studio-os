import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isSessionStatus,
  type EntryIssueCode,
  type FileErrorCode,
  type ProductionMode,
  type SessionStatus,
} from '@ugc/core';
import type { BrowserLoadIssue } from './electron-cookies.js';

/**
 * Gate 3 metadata store (SQLite, `ugc.db` in userData). Only non-secret
 * state lives here: names, modes, statuses, counts, proxy host/port/status.
 * Cookies, snapshots and proxy credentials are sealed separately
 * (session-sync.ts, proxy.ts) and never written to this database.
 */

/** Non-secret summary of the last import. Never holds cookie names or values. */
export interface ImportSummary {
  readonly at: string;
  readonly format: string;
  readonly fileError: FileErrorCode | null;
  readonly examined: number;
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly reasons: Partial<Record<EntryIssueCode, number>>;
  readonly messages: readonly string[];
  readonly browserLoaded: number;
  readonly browserFailures: Partial<Record<BrowserLoadIssue, number>>;
}

/** Outcome of restoring the sealed session-cookie snapshot at startup. */
export interface SessionRestoreSummary {
  readonly at: string;
  readonly state: 'restored' | 'failed';
  readonly count: number;
  /** A reason code only; never cookie content or OS error text. */
  readonly error: string | null;
  /** Cookies the browser refused or can't take back (e.g. partitioned ones), skipped without undoing the rest. */
  readonly skipped?: number;
}

/**
 * Non-secret state of the session-cookie snapshot (C1). `revision` is the
 * last revision durably written; it only grows and is one of the three
 * copies a restore checks against rollback.
 */
export interface SessionSyncState {
  readonly revision: number;
  readonly savedCount: number;
  readonly savedAt: string | null;
  readonly saveError: string | null;
  readonly restore: SessionRestoreSummary | null;
}

/** Non-secret proxy settings and test result. Credentials are sealed in proxy.ts; only whether they exist is kept. */
export interface ProxyState {
  readonly protocol: 'http' | 'https' | 'socks5';
  readonly host: string;
  readonly port: number;
  readonly hasCredentials: boolean;
  readonly status: 'untested' | 'ok' | 'failed';
  readonly observedIp: string | null;
  readonly endpoint: 'primary' | 'backup' | null;
  readonly testedAt: string | null;
  /** When this proxy configuration last passed Test Proxy (kept across restarts; cleared when it changes). */
  readonly lastPassedAt: string | null;
  /** Sanitized error code of the last failed test. */
  readonly error: string | null;
}

export const EMPTY_SYNC: SessionSyncState = { revision: 0, savedCount: 0, savedAt: null, saveError: null, restore: null };

/** One platform session: one isolated partition, one platform, one account. */
export interface PocProfile {
  readonly id: string;
  readonly label: string;
  readonly platformId: string;
  /** The Account Bundle it belongs to; null for the synthetic test profiles of earlier gates. */
  readonly bundleId: string | null;
  readonly optional: boolean;
  /** Collision-resistant Electron partition, independent of the label. */
  readonly partition: string;
  readonly status: SessionStatus;
  readonly statusReason: string | null;
  readonly lastImport: ImportSummary | null;
  readonly sessionSync: SessionSyncState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountBundle {
  readonly id: string;
  readonly displayName: string;
  readonly mode: ProductionMode;
  readonly proxy: ProxyState | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PARTITION = /^persist:ps_[0-9a-f-]{36}$/;
const PLATFORM_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * A migration is SQL run in one transaction. A table rebuild (SQLite can't
 * alter a CHECK constraint) needs foreign-key enforcement paused around the
 * transaction, then a foreign_key_check before it is turned back on.
 */
type Migration = string | { readonly sql: string; readonly foreignKeysOff: true };

export const MIGRATIONS: readonly Migration[] = [
  `CREATE TABLE account_bundles (
     id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('affiliate_ugc', 'account_growth')),
     proxy_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE platform_sessions (
     id TEXT PRIMARY KEY,
     bundle_id TEXT REFERENCES account_bundles(id),
     platform_id TEXT NOT NULL,
     label TEXT NOT NULL,
     partition TEXT NOT NULL UNIQUE,
     optional INTEGER NOT NULL DEFAULT 0,
     state_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (bundle_id, platform_id)
   );`,
  // Gate 4: video generation. Jobs keep no prompt copy, no provider text and no page content.
  `CREATE TABLE creative_settings (
     bundle_id TEXT PRIMARY KEY REFERENCES account_bundles(id),
     prompt TEXT NOT NULL,
     settings_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE generation_jobs (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     source TEXT NOT NULL CHECK (source IN ('provider', 'manual_download')),
     provider_id TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'waiting_for_user', 'failed')),
     settings_json TEXT,
     progress REAL,
     error_code TEXT,
     needs_user INTEGER NOT NULL DEFAULT 0,
     video_file TEXT,
     video_bytes INTEGER,
     video_sha256 TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE generation_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES generation_jobs(id),
     at TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT NOT NULL,
     code TEXT
   );`,
  // Gate 5 (R1/R2): growth strategy, reference creators and reference videos. Baselines and
  // outlier assessments are computed on demand from these rows, never stored.
  `CREATE TABLE growth_strategies (
     bundle_id TEXT PRIMARY KEY REFERENCES account_bundles(id),
     strategy_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE reference_creators (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     handle TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     added_at TEXT NOT NULL,
     UNIQUE (bundle_id, handle)
   );
   CREATE TABLE reference_videos (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     url TEXT NOT NULL,
     platform_video_id TEXT NOT NULL,
     creator_handle TEXT NOT NULL,
     published_at TEXT,
     duration_s INTEGER,
     metrics_json TEXT NOT NULL,
     relevance TEXT NOT NULL DEFAULT 'unrated' CHECK (relevance IN ('unrated', 'relevant', 'not_relevant')),
     pinned INTEGER NOT NULL DEFAULT 0,
     note TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (bundle_id, platform_video_id)
   );`,
  // T1 (Ternak Akun): prompt templates (owner-made; starters ship in code), per-account template
  // settings, reusable character/world presets, local reference files, and prompt batches whose
  // items carry their own status (prompt approval is separate from video production).
  `CREATE TABLE prompt_templates (
     key TEXT NOT NULL,
     version INTEGER NOT NULL,
     definition_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (key, version)
   );
   CREATE TABLE creative_presets (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('character', 'world', 'style')),
     name TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (kind, name)
   );
   CREATE TABLE reference_assets (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     file TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
     bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     rights_confirmed_at TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE template_configs (
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     template_key TEXT NOT NULL,
     config_json TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (bundle_id, template_key)
   );
   CREATE TABLE prompt_batches (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     template_key TEXT NOT NULL,
     template_version INTEGER NOT NULL,
     template_json TEXT NOT NULL,
     config_json TEXT NOT NULL,
     assets_json TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     seed TEXT NOT NULL,
     requested INTEGER NOT NULL,
     shortfall TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE prompt_items (
     id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL REFERENCES prompt_batches(id),
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     position INTEGER NOT NULL,
     axes_json TEXT NOT NULL,
     slots_json TEXT NOT NULL,
     content_json TEXT NOT NULL,
     rendered TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'queued', 'generating', 'video_ready')),
     edited INTEGER NOT NULL DEFAULT 0,
     flags_json TEXT NOT NULL DEFAULT '[]',
     duplicates_json TEXT NOT NULL DEFAULT '[]',
     handoff TEXT CHECK (handoff IN ('provider', 'manual')),
     job_id TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (batch_id, position)
   );
   ALTER TABLE generation_jobs ADD COLUMN prompt_item_id TEXT;`,
  // T2 (Ternak Akun): posts the owner made by hand and recorded here (the app never publishes),
  // and each account's daily video target.
  `CREATE TABLE post_records (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     prompt_item_id TEXT NOT NULL UNIQUE REFERENCES prompt_items(id),
     job_id TEXT NOT NULL,
     post_url TEXT,
     platform_video_id TEXT,
     posted_at TEXT NOT NULL
   );
   CREATE TABLE production_targets (
     bundle_id TEXT PRIMARY KEY REFERENCES account_bundles(id),
     daily_videos INTEGER NOT NULL CHECK (daily_videos BETWEEN 1 AND 50),
     updated_at TEXT NOT NULL
   );`,
  // A1 (Affiliate Factory): products per affiliate account, identified by TikTok product ID only.
  // Listing facts are what the owner verified; Showcase states record who confirmed an addition.
  `CREATE TABLE affiliate_products (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     platform_product_id TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('link', 'research_address')),
     facts_json TEXT NOT NULL,
     selected_on TEXT,
     listing_state TEXT NOT NULL DEFAULT 'unverified' CHECK (listing_state IN ('unverified', 'confirmed', 'mismatch')),
     eligibility_state TEXT NOT NULL DEFAULT 'unknown' CHECK (eligibility_state IN ('unknown', 'can_promote', 'cannot_promote')),
     showcase_state TEXT NOT NULL DEFAULT 'not_requested'
       CHECK (showcase_state IN ('not_requested', 'in_progress', 'added_seen_by_you', 'added_confirmed_by_tiktok', 'not_eligible', 'failed', 'removed')),
     showcase_method TEXT CHECK (showcase_method IN ('assisted', 'api')),
     showcase_changed_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (bundle_id, platform_product_id)
   );
   ALTER TABLE production_targets ADD COLUMN daily_products INTEGER;`,
  // F0 (Flow session pool): a third account kind, flow_pool (a Flow-only Google account with its
  // own proxy), its credit settings and ledger, and which pool account produced a video or holds a prompt.
  {
    foreignKeysOff: true,
    sql: `CREATE TABLE account_bundles_new (
     id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('affiliate_ugc', 'account_growth', 'flow_pool')),
     proxy_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   INSERT INTO account_bundles_new (id, display_name, mode, proxy_json, created_at, updated_at)
     SELECT id, display_name, mode, proxy_json, created_at, updated_at FROM account_bundles;
   DROP TABLE account_bundles;
   ALTER TABLE account_bundles_new RENAME TO account_bundles;
   CREATE TABLE flow_pool_settings (
     bundle_id TEXT PRIMARY KEY REFERENCES account_bundles(id),
     monthly_credits INTEGER NOT NULL CHECK (monthly_credits BETWEEN 1 AND 1000000),
     reset_day INTEGER NOT NULL CHECK (reset_day BETWEEN 1 AND 28),
     credits_per_download INTEGER NOT NULL CHECK (credits_per_download BETWEEN 1 AND 10000),
     updated_at TEXT NOT NULL
   );
   CREATE TABLE flow_credit_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     pool_bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     at TEXT NOT NULL,
     credits INTEGER NOT NULL,
     reason TEXT NOT NULL CHECK (reason IN ('download', 'adjust')),
     job_id TEXT UNIQUE
   );
   ALTER TABLE generation_jobs ADD COLUMN flow_bundle_id TEXT;
   ALTER TABLE prompt_items ADD COLUMN flow_bundle_id TEXT;`,
  },
  // A2 (Affiliate Creative Studio): finished-video plans (Clip A + Clip B), their clips, a separate
  // log of attempts / failures / unusable outputs / approvals, credit limits per Flow account, and
  // per-account production limits.
  `CREATE TABLE affiliate_videos (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     product_row_id TEXT NOT NULL REFERENCES affiliate_products(id),
     product_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     template_key TEXT NOT NULL,
     template_version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     facts_json TEXT NOT NULL,
     has_reference INTEGER NOT NULL DEFAULT 0,
     continuity TEXT NOT NULL CHECK (continuity IN ('seamless', 'cut')),
     axes_json TEXT NOT NULL,
     clip_a_json TEXT NOT NULL,
     clip_b_json TEXT NOT NULL,
     caption TEXT NOT NULL,
     edited INTEGER NOT NULL DEFAULT 0,
     flags_json TEXT NOT NULL DEFAULT '[]',
     duplicates_json TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'producing', 'stitching', 'review', 'final_approved')),
     final_file TEXT,
     final_meta_json TEXT,
     final_sha256 TEXT,
     review_note TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (batch_id, position)
   );
   CREATE TABLE affiliate_clips (
     id TEXT PRIMARY KEY,
     video_id TEXT NOT NULL REFERENCES affiliate_videos(id),
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     slot TEXT NOT NULL CHECK (slot IN ('A', 'B')),
     status TEXT NOT NULL CHECK (status IN ('waiting', 'in_flow', 'received', 'unusable', 'approved')),
     flow_bundle_id TEXT,
     job_id TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     credits INTEGER NOT NULL DEFAULT 0,
     last_reason TEXT,
     updated_at TEXT NOT NULL,
     UNIQUE (video_id, slot)
   );
   CREATE TABLE production_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     product_id TEXT NOT NULL,
     video_id TEXT NOT NULL,
     clip_id TEXT,
     flow_bundle_id TEXT,
     at TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('attempt', 'generation_failed', 'unusable_output', 'clip_approved', 'stitch_failed', 'final_approved', 'final_rejected')),
     reason TEXT,
     credits INTEGER NOT NULL DEFAULT 0
   );
   ALTER TABLE generation_jobs ADD COLUMN affiliate_clip_id TEXT;
   ALTER TABLE flow_pool_settings ADD COLUMN daily_credit_limit INTEGER;
   ALTER TABLE production_targets ADD COLUMN max_clip_attempts INTEGER;
   ALTER TABLE production_targets ADD COLUMN daily_videos_per_product INTEGER;`,
  // 9: A3 product photo read from the listing (a reference asset id).
  `ALTER TABLE affiliate_products ADD COLUMN image_asset_id TEXT;`,
  // 10: Ternak Akun posting queue (G1): ready-made and AI-generated videos per account, captions
  // from multimodal analysis, FYP reference breakdowns, analysis settings and estimated spend.
  `CREATE TABLE post_queue (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     source TEXT NOT NULL CHECK (source IN ('ready_made', 'ai_generated')),
     job_id TEXT NOT NULL UNIQUE,
     prompt_item_id TEXT,
     original_name TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('analyzing', 'needs_review', 'ready', 'posted', 'rejected', 'analysis_failed')),
     caption TEXT NOT NULL DEFAULT '',
     hashtags_json TEXT NOT NULL DEFAULT '[]',
     summary TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     flags_json TEXT NOT NULL DEFAULT '[]',
     analysis_error TEXT,
     caption_edited INTEGER NOT NULL DEFAULT 0,
     post_url TEXT,
     posted_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (bundle_id, sha256)
   );
   CREATE TABLE fyp_references (
     id TEXT PRIMARY KEY,
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     asset_ids_json TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     analysis_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE analysis_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     model TEXT NOT NULL,
     cost_per_call_usd REAL NOT NULL,
     monthly_budget_usd REAL NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE analysis_usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bundle_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     at TEXT NOT NULL,
     cost_usd REAL NOT NULL,
     ok INTEGER NOT NULL
   );`,
  // 11: Affiliate character reference images (one per character description, per account), uploaded with each clip.
  `CREATE TABLE affiliate_characters (
     bundle_id TEXT NOT NULL REFERENCES account_bundles(id),
     character_key TEXT NOT NULL,
     character_text TEXT NOT NULL,
     asset_id TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (bundle_id, character_key)
   );`,
];

export class MetadataDb {
  private constructor(readonly db: DatabaseSync | null) {}

  /** Opens (and migrates) `ugc.db`. Read-only mode never creates or changes anything. */
  static open(userData: string, options: { readOnly?: boolean } = {}): MetadataDb {
    const path = join(userData, 'ugc.db');
    if (options.readOnly) return new MetadataDb(existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
    MIGRATIONS.forEach((migration, i) => {
      const version = i + 1;
      if (applied.has(version)) return;
      const sql = typeof migration === 'string' ? migration : migration.sql;
      const pauseForeignKeys = typeof migration !== 'string' && migration.foreignKeysOff;
      if (pauseForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(sql);
        if (pauseForeignKeys && (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > 0) throw new Error(`migration ${version} broke foreign keys`);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        if (pauseForeignKeys) db.exec('PRAGMA foreign_keys = ON');
      }
    });
    const store = new MetadataDb(db);
    store.#importLegacyJson(join(userData, 'poc-profiles.json'));
    return store;
  }

  /** One-time import of the Gate 1/2 JSON metadata as bundle-less sessions; the file is then renamed. */
  #importLegacyJson(path: string): void {
    if (!this.db || !existsSync(path)) return;
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM platform_sessions').get() as { n: number }).n;
    if (count > 0) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; profiles?: unknown[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) throw new Error('legacy profile store has an unexpected shape');
    const insert = this.db.prepare(
      'INSERT INTO platform_sessions (id, bundle_id, platform_id, label, partition, optional, state_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 0, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const raw of parsed.profiles) {
        const p = raw as Record<string, unknown>;
        if (typeof p['id'] !== 'string' || !PROFILE_ID.test(p['id']) || typeof p['partition'] !== 'string' || !PARTITION.test(p['partition'])) continue;
        const platformId = typeof p['platformId'] === 'string' && PLATFORM_ID.test(p['platformId']) ? p['platformId'] : 'synthetic-poc';
        const sync = (p['sessionSync'] ?? null) as SessionSyncState | null;
        const state = {
          status: isSessionStatus(p['status']) ? p['status'] : 'never_configured',
          statusReason: typeof p['statusReason'] === 'string' ? p['statusReason'] : null,
          lastImport: (p['lastImport'] ?? null) as ImportSummary | null,
          sessionSync: sync ? { ...EMPTY_SYNC, ...sync } : EMPTY_SYNC,
        };
        const now = new Date().toISOString();
        insert.run(p['id'], platformId, String(p['label'] ?? 'Profile'), p['partition'], JSON.stringify(state), String(p['createdAt'] ?? now), String(p['updatedAt'] ?? now));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    renameSync(path, `${path}.migrated`);
  }

  close(): void {
    this.db?.close();
  }
}

interface SessionRow {
  id: string;
  bundle_id: string | null;
  platform_id: string;
  label: string;
  partition: string;
  optional: number;
  state_json: string;
  created_at: string;
  updated_at: string;
}

function toProfile(row: SessionRow): PocProfile {
  const state = JSON.parse(row.state_json) as Partial<Pick<PocProfile, 'status' | 'statusReason' | 'lastImport' | 'sessionSync'>>;
  const sync = state.sessionSync;
  return {
    id: row.id,
    label: row.label,
    platformId: row.platform_id,
    bundleId: row.bundle_id,
    optional: row.optional === 1,
    partition: row.partition,
    status: isSessionStatus(state.status) ? state.status : 'never_configured',
    statusReason: state.statusReason ?? null,
    lastImport: state.lastImport ?? null,
    sessionSync: sync ? { ...EMPTY_SYNC, ...sync, revision: Number.isSafeInteger(sync.revision) && sync.revision >= 0 ? sync.revision : 0 } : EMPTY_SYNC,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ProfilePatch = Partial<Pick<PocProfile, 'status' | 'statusReason' | 'lastImport' | 'sessionSync'>>;

/** Platform sessions (the "profiles" of Gates 1–2), with or without a bundle. */
export class ProfileStore {
  readonly #db: DatabaseSync | null;

  /**
   * `seedLegacyPlatformId`: seeds two bundle-less test profiles for that
   * platform if none exist (synthetic test runs of the earlier gates).
   */
  constructor(meta: MetadataDb, seedLegacyPlatformId: string | null = null) {
    this.#db = meta.db;
    if (seedLegacyPlatformId && this.#db && !this.list().some((p) => p.bundleId === null && p.platformId === seedLegacyPlatformId)) {
      const prefix = seedLegacyPlatformId === 'synthetic-poc' ? 'Synthetic Profile' : 'Profile';
      this.create({ bundleId: null, platformId: seedLegacyPlatformId, label: `${prefix} A`, optional: false });
      this.create({ bundleId: null, platformId: seedLegacyPlatformId, label: `${prefix} B`, optional: false });
    }
  }

  list(): readonly PocProfile[] {
    if (!this.#db) return [];
    return (this.#db.prepare('SELECT * FROM platform_sessions ORDER BY created_at, rowid').all() as unknown as SessionRow[]).map(toProfile);
  }

  get(id: string): PocProfile | undefined {
    if (!this.#db) return undefined;
    const row = this.#db.prepare('SELECT * FROM platform_sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  forBundle(bundleId: string): readonly PocProfile[] {
    return this.list().filter((p) => p.bundleId === bundleId);
  }

  create(input: { bundleId: string | null; platformId: string; label: string; optional: boolean }): PocProfile {
    if (!this.#db) throw new Error('profile store is read-only');
    const now = new Date().toISOString();
    const id = randomUUID();
    const state = { status: 'never_configured', statusReason: null, lastImport: null, sessionSync: EMPTY_SYNC };
    this.#db
      .prepare(
        'INSERT INTO platform_sessions (id, bundle_id, platform_id, label, partition, optional, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.bundleId, input.platformId, input.label, `persist:ps_${randomUUID()}`, input.optional ? 1 : 0, JSON.stringify(state), now, now);
    return this.get(id)!;
  }

  update(id: string, patch: ProfilePatch): PocProfile {
    if (!this.#db) throw new Error('profile store is read-only');
    const existing = this.get(id);
    if (!existing) throw new Error('unknown profile');
    const merged = { ...existing, ...patch };
    const state = { status: merged.status, statusReason: merged.statusReason, lastImport: merged.lastImport, sessionSync: merged.sessionSync };
    this.#db.prepare('UPDATE platform_sessions SET state_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), new Date().toISOString(), id);
    return this.get(id)!;
  }
}

interface BundleRow {
  id: string;
  display_name: string;
  mode: ProductionMode;
  proxy_json: string | null;
  created_at: string;
  updated_at: string;
}

function toBundle(row: BundleRow): AccountBundle {
  const proxy = row.proxy_json ? (JSON.parse(row.proxy_json) as ProxyState) : null;
  return {
    id: row.id,
    displayName: row.display_name,
    mode: row.mode,
    proxy: proxy ? { ...proxy, lastPassedAt: proxy.lastPassedAt ?? null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type BundlePatch = Partial<Pick<AccountBundle, 'displayName' | 'mode' | 'proxy'>>;

export class BundleStore {
  readonly #db: DatabaseSync | null;

  constructor(meta: MetadataDb) {
    this.#db = meta.db;
  }

  list(): readonly AccountBundle[] {
    if (!this.#db) return [];
    return (this.#db.prepare('SELECT * FROM account_bundles ORDER BY created_at, rowid').all() as unknown as BundleRow[]).map(toBundle);
  }

  get(id: string): AccountBundle | undefined {
    if (!this.#db) return undefined;
    const row = this.#db.prepare('SELECT * FROM account_bundles WHERE id = ?').get(id) as unknown as BundleRow | undefined;
    return row ? toBundle(row) : undefined;
  }

  /** Creates a draft bundle (no proxy yet) and one isolated session per platform, in one transaction. */
  create(
    input: { displayName: string; mode: ProductionMode },
    sessions: ReadonlyArray<{ platformId: string; label: string; optional: boolean }>,
    profiles: ProfileStore,
  ): AccountBundle {
    if (!this.#db) throw new Error('bundle store is read-only');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare('INSERT INTO account_bundles (id, display_name, mode, proxy_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
        .run(id, input.displayName, input.mode, now, now);
      for (const s of sessions) profiles.create({ bundleId: id, ...s });
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return this.get(id)!;
  }

  update(id: string, patch: BundlePatch): AccountBundle {
    if (!this.#db) throw new Error('bundle store is read-only');
    const existing = this.get(id);
    if (!existing) throw new Error('unknown bundle');
    const merged = { ...existing, ...patch };
    this.#db
      .prepare('UPDATE account_bundles SET display_name = ?, mode = ?, proxy_json = ?, updated_at = ? WHERE id = ?')
      .run(merged.displayName, merged.mode, merged.proxy ? JSON.stringify(merged.proxy) : null, new Date().toISOString(), id);
    return this.get(id)!;
  }
}
