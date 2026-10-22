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

export interface PocProfile {
  readonly id: string;
  readonly label: string;
  /** Collision-resistant Electron partition, independent of the label. */
  readonly partition: string;
  readonly status: SessionStatus;
  readonly statusReason: string | null;
  readonly lastImport: ImportSummary | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoreFile {
  readonly version: 1;
  readonly profiles: PocProfile[];
}

export const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function newProfile(label: string, now: string): PocProfile {
  return {
    id: randomUUID(),
    label,
    partition: `persist:ps_${randomUUID()}`,
    status: 'never_configured',
    statusReason: null,
    lastImport: null,
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

/**
 * Gate 1 stand-in for the SQLite metadata store: a small JSON file with
 * non-secret profile metadata. Replaced by SQLite migrations in Gate 3.
 */
export class ProfileStore {
  readonly #path: string;
  #profiles: PocProfile[];

  constructor(path: string) {
    this.#path = path;
    this.#profiles = this.#load();
  }

  #load(): PocProfile[] {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as StoreFile;
      if (parsed.version === 1 && Array.isArray(parsed.profiles) && parsed.profiles.every(isProfile)) {
        return parsed.profiles;
      }
      throw new Error('profile store has an unexpected shape');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const now = new Date().toISOString();
    const profiles = [newProfile('Synthetic Profile A', now), newProfile('Synthetic Profile B', now)];
    this.#write(profiles);
    return profiles;
  }

  #write(profiles: PocProfile[]): void {
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

  update(id: string, patch: Partial<Pick<PocProfile, 'status' | 'statusReason' | 'lastImport'>>): PocProfile {
    const existing = this.get(id);
    if (!existing) throw new Error('unknown profile');
    const updated: PocProfile = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const next = this.#profiles.map((p) => (p.id === id ? updated : p));
    this.#write(next);
    this.#profiles = next;
    return updated;
  }
}
