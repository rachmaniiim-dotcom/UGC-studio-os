import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isSessionStatus, type EntryIssueCode, type FileErrorCode, type SessionStatus } from '@ugc/core';
import type { BrowserLoadIssue } from './electron-cookies.js';

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
}

/**
 * Non-secret state of the profile's session-cookie snapshot (C1). `revision`
 * is the last revision durably written; it only grows and is one of the
 * three copies a restore checks against rollback.
 */
export interface SessionSyncState {
  readonly revision: number;
  /** Session cookies in the last saved snapshot (0 = none saved). */
  readonly savedCount: number;
  readonly savedAt: string | null;
  /** Why the last snapshot could not be sealed, if it couldn't. */
  readonly saveError: string | null;
  readonly restore: SessionRestoreSummary | null;
}

/**
 * Non-secret proxy settings and last test result. The credentials are sealed
 * separately (proxy.ts); only whether they exist is kept here.
 */
export interface ProxyState {
  readonly protocol: 'http' | 'https' | 'socks5';
  readonly host: string;
  readonly port: number;
  readonly hasCredentials: boolean;
  readonly status: 'untested' | 'ok' | 'failed';
  readonly observedIp: string | null;
  readonly endpoint: 'primary' | 'backup' | null;
  readonly testedAt: string | null;
  /** Sanitized error code of the last failed test. */
  readonly error: string | null;
}

export const EMPTY_SYNC: SessionSyncState = { revision: 0, savedCount: 0, savedAt: null, saveError: null, restore: null };

export interface PocProfile {
  readonly id: string;
  readonly label: string;
  /** The platform this profile's single account belongs to (see platforms.ts). */
  readonly platformId: string;
  /** Collision-resistant Electron partition, independent of the label. */
  readonly partition: string;
  readonly status: SessionStatus;
  readonly statusReason: string | null;
  readonly lastImport: ImportSummary | null;
  readonly sessionSync: SessionSyncState;
  /** The profile's dedicated proxy, or null (direct; allowed only in synthetic mode). */
  readonly proxy: ProxyState | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoreFile {
  readonly version: 1;
  readonly profiles: PocProfile[];
}

export const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLATFORM_ID = /^[a-z][a-z0-9-]{1,31}$/;

function newProfile(label: string, platformId: string, now: string): PocProfile {
  return {
    id: randomUUID(),
    label,
    platformId,
    partition: `persist:ps_${randomUUID()}`,
    status: 'never_configured',
    statusReason: null,
    lastImport: null,
    sessionSync: EMPTY_SYNC,
    proxy: null,
    createdAt: now,
    updatedAt: now,
  };
}

function isProfile(value: unknown): value is PocProfile {
  const p = value as PocProfile;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.id === 'string' &&
    PROFILE_ID.test(p.id) &&
    typeof p.partition === 'string' &&
    /^persist:ps_[0-9a-f-]{36}$/.test(p.partition) &&
    isSessionStatus(p.status)
  );
}

/** Fills fields added after a store was written (Gate 1 stores have no platform or sync state). */
function upgrade(p: PocProfile & { sessionRestore?: unknown }): PocProfile {
  const { sessionRestore: _old, ...rest } = p;
  const sync = rest.sessionSync;
  const revision = sync && Number.isSafeInteger(sync.revision) && sync.revision >= 0 ? sync.revision : 0;
  return {
    ...rest,
    platformId: typeof rest.platformId === 'string' && PLATFORM_ID.test(rest.platformId) ? rest.platformId : 'synthetic-poc',
    sessionSync: sync ? { ...EMPTY_SYNC, ...sync, revision } : EMPTY_SYNC,
    proxy: rest.proxy ?? null,
  };
}

export type ProfilePatch = Partial<Pick<PocProfile, 'status' | 'statusReason' | 'lastImport' | 'sessionSync' | 'proxy'>>;

/**
 * Gate 1 stand-in for the SQLite metadata store: a small JSON file with
 * non-secret profile metadata. Replaced by SQLite migrations in Gate 3.
 */
export class ProfileStore {
  readonly #path: string;
  readonly #readOnly: boolean;
  #profiles: PocProfile[];

  /**
   * Seeds two profiles for `platformId` if the store has none for it.
   * `readOnly` never writes (used by the security check) and seeds nothing.
   */
  constructor(path: string, platformId: string | null, options: { readOnly?: boolean } = {}) {
    this.#path = path;
    this.#readOnly = options.readOnly ?? false;
    this.#profiles = this.#load();
    if (!this.#readOnly && platformId && !this.#profiles.some((p) => p.platformId === platformId)) {
      const now = new Date().toISOString();
      const prefix = platformId === 'synthetic-poc' ? 'Synthetic Profile' : 'Profile';
      this.#profiles = [...this.#profiles, newProfile(`${prefix} A`, platformId, now), newProfile(`${prefix} B`, platformId, now)];
      this.#write(this.#profiles);
    }
  }

  #load(): PocProfile[] {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as StoreFile;
      if (parsed.version === 1 && Array.isArray(parsed.profiles) && parsed.profiles.every(isProfile)) {
        return parsed.profiles.map(upgrade);
      }
      throw new Error('profile store has an unexpected shape');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return [];
  }

  #write(profiles: PocProfile[]): void {
    if (this.#readOnly) throw new Error('profile store is read-only');
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, profiles } satisfies StoreFile, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }

  list(): readonly PocProfile[] {
    return this.#profiles;
  }

  get(id: string): PocProfile | undefined {
    return this.#profiles.find((p) => p.id === id);
  }

  update(id: string, patch: ProfilePatch): PocProfile {
    const existing = this.get(id);
    if (!existing) throw new Error('unknown profile');
    const updated: PocProfile = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const next = this.#profiles.map((p) => (p.id === id ? updated : p));
    this.#write(next);
    this.#profiles = next;
    return updated;
  }
}
