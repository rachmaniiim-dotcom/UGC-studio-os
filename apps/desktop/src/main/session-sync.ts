import { safeStorage, type Session } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { writeAtomic } from './atomic.js';
import { join } from 'node:path';
import {
  decodeRevisionRecord,
  decodeSessionRestore,
  encodeRevisionRecord,
  encodeSessionRestore,
  hostInDomains,
  restorableSessionCookies,
  type Logger,
  type NormalizedCookie,
  type PlatformDefinition,
  type RestoreBinding,
} from '@ugc/core';
import { fromElectronSessionCookie, toElectronCookie } from './electron-cookies.js';
import { PROFILE_ID, type PocProfile, type ProfileStore, type SessionRestoreSummary, type SessionSyncState } from './profiles.js';

/**
 * Session-cookie synchronization (C1, replaces the Gate 1 import-time seal).
 *
 * Chromium drops cookies without an expiry when the app exits. For each
 * profile, the app keeps an encrypted snapshot of the *current* in-scope
 * session cookies of the live jar:
 *
 * - Any change to an in-scope cookie (insert, rotation, overwrite, deletion)
 *   schedules a re-seal after a short debounce. The whole set is read from the
 *   jar and sealed as one record, so a snapshot is always one consistent
 *   state, never a merge of events.
 * - An empty set is a state too: the record is removed, so logout or Clear
 *   can't resurrect cookies.
 * - Work per profile is serialized; files are written to a temp file,
 *   fsynced, then renamed over the old one.
 * - Each save increments a revision. It is written to the sealed snapshot,
 *   to a separately sealed revision record, and to the non-secret profile
 *   metadata. A restore refuses a snapshot older than the newest of the other
 *   two (rollback check). Residual threat: someone with this Windows user's
 *   access who restores all three files from the same earlier moment is not
 *   detected (no hardware-backed monotonic counter; see the hardening report).
 *
 * Sealing uses safeStorage (DPAPI-wrapped AES-GCM key on Windows). Cookie
 * values never reach logs, metadata or the renderer; the snapshot digest
 * used to skip unchanged saves lives in memory only.
 */

const CHANGE_DEBOUNCE_MS = 250;
/** Shorter for deletions so a logout is saved quickly, but long enough to let one response's Set-Cookie headers all land. */
const REMOVAL_DEBOUNCE_MS = 50;
const LINUX_UNSAFE_BACKENDS = new Set(['basic_text', 'unknown']);

/** True only when safeStorage is backed by real OS key protection. */
export function protectedStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || !LINUX_UNSAFE_BACKENDS.has(safeStorage.getSelectedStorageBackend());
}

/**
 * On Windows, Chromium creates a new profile's encryption key at startup but
 * writes it (DPAPI-wrapped, in "Local State") about 10 s later or at a
 * graceful quit (measured: 10.3 s). A crash before that loses the key, and
 * everything encrypted with it (snapshots and Chromium's own cookie database)
 * can't be decrypted afterwards. Imports wait for this to be true.
 */
export function osCryptKeyPersisted(userData: string): boolean {
  try {
    const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: unknown } };
    return typeof state.os_crypt?.encrypted_key === 'string' && state.os_crypt.encrypted_key.length > 0;
  } catch {
    return false;
  }
}

export function snapshotPaths(dir: string, profileId: string): { record: string; revision: string } {
  if (!PROFILE_ID.test(profileId)) throw new Error('invalid profile id');
  return { record: join(dir, `${profileId}.sealed`), revision: join(dir, `${profileId}.rev`) };
}


function readOptional(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function digestOf(cookies: readonly NormalizedCookie[]): string {
  const canonical = cookies
    .map((c) => [c.domain, c.hostOnly, c.path, c.name, c.value.reveal(), c.secure, c.httpOnly, c.sameSite])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const bindingOf = (p: PocProfile): RestoreBinding => ({ profileId: p.id, partition: p.partition, platformId: p.platformId });

class RestoreFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Reads, decrypts and validates a profile's snapshot without touching the
 * browser. Returns null when there is nothing to restore; throws
 * RestoreFailure on any problem (missing, undecryptable, rebound, stale).
 */
function readSnapshot(
  dir: string,
  profile: PocProfile,
  cookieDomains: readonly string[],
): { revision: number; cookies: readonly NormalizedCookie[] } | null {
  const paths = snapshotPaths(dir, profile.id);
  const binding = bindingOf(profile);
  let recordBytes: Buffer | null;
  let revisionBytes: Buffer | null;
  try {
    recordBytes = readOptional(paths.record);
    revisionBytes = readOptional(paths.revision);
  } catch {
    throw new RestoreFailure('unreadable');
  }
  const meta = profile.sessionSync;
  if (!recordBytes && !revisionBytes) {
    if (meta.savedCount > 0) throw new RestoreFailure('record_missing');
    return null;
  }
  if (!protectedStorageAvailable()) throw new RestoreFailure('protected_storage_unavailable');
  if (!revisionBytes) throw new RestoreFailure('revision_missing');

  let revisionText: string;
  try {
    revisionText = safeStorage.decryptString(revisionBytes);
  } catch {
    throw new RestoreFailure('revision_decrypt_failed');
  }
  const rev = decodeRevisionRecord(revisionText, binding);
  if (!rev.ok) throw new RestoreFailure(`revision_${rev.code}`);
  if (rev.revision < meta.revision) throw new RestoreFailure('stale_record');
  // The latest saved state is "no session cookies": an older snapshot left behind is never restored.
  if (rev.count === 0) return null;
  if (!recordBytes) throw new RestoreFailure('record_missing');

  let text: string;
  try {
    text = safeStorage.decryptString(recordBytes);
  } catch {
    // Chromium's error text is dropped: only the code is reported.
    throw new RestoreFailure('decrypt_failed');
  }
  const decoded = decodeSessionRestore(text, binding, cookieDomains);
  if (!decoded.ok) throw new RestoreFailure(decoded.code);
  if (decoded.revision < Math.max(rev.revision, meta.revision)) throw new RestoreFailure('stale_record');
  return { revision: decoded.revision, cookies: decoded.cookies };
}

/**
 * For the security check: whether the profile's snapshot would restore, and
 * its cookies (to search files for their values). Never sets cookies or changes files.
 */
export function inspectSnapshot(dir: string, profile: PocProfile, cookieDomains: readonly string[]): { state: string; cookies: readonly NormalizedCookie[] } {
  try {
    const snapshot = readSnapshot(dir, profile, cookieDomains);
    return snapshot ? { state: 'ok', cookies: snapshot.cookies } : { state: 'none', cookies: [] };
  } catch (err) {
    return { state: err instanceof RestoreFailure ? err.code : 'internal_error', cookies: [] };
  }
}

export interface SessionSyncDeps {
  readonly dir: string;
  readonly store: ProfileStore;
  /** The definition for a session's platform; undefined for platforms this run doesn't know (left alone). */
  readonly platformOf: (profile: PocProfile) => PlatformDefinition | undefined;
  readonly log: Logger;
  readonly sessionOf: (profile: PocProfile) => Session;
}

export class SessionSync {
  readonly #deps: SessionSyncDeps;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #timers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  /** SHA-256 of each profile's last sealed snapshot. In memory only. */
  readonly #digests = new Map<string, string>();
  readonly #suspended = new Set<string>();
  readonly #watched = new Set<string>();
  #stopped = false;

  constructor(deps: SessionSyncDeps) {
    this.#deps = deps;
  }

  #profiles(): PocProfile[] {
    return this.#deps.store.list().filter((p) => this.#deps.platformOf(p) !== undefined);
  }

  /** Restores every profile's snapshot, then starts watching its jar. Call before any window or IPC exists. */
  async start(): Promise<void> {
    for (const profile of this.#profiles()) {
      // A confirmation or probe result describes the previous run; after a restart it must be made again.
      if (profile.status === 'confirmed_by_user' || profile.status === 'appears_authenticated') {
        this.#deps.store.update(profile.id, { status: 'imported_unverified', statusReason: 'restarted_unverified' });
      }
      await this.#restoreProfile(this.#deps.store.get(profile.id) ?? profile);
      this.#watch(profile);
    }
  }

  /** Final save of every watched profile, then stop reacting to changes. For graceful shutdown. */
  async stop(): Promise<void> {
    for (const { timer } of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#watched].map((id) => this.#enqueue(id, () => this.#snapshot(id))));
    this.#stopped = true;
  }

  /**
   * Runs `change` (an import or a Clear) inside the profile's queue with
   * change events ignored, then saves the resulting jar once.
   */
  apply<T>(profileId: string, change: () => Promise<T>): Promise<T> {
    return this.#enqueue(profileId, async () => {
      this.#suspended.add(profileId);
      this.#cancel(profileId);
      try {
        return await change();
      } finally {
        this.#suspended.delete(profileId);
        this.#cancel(profileId);
        await this.#snapshot(profileId);
      }
    });
  }

  #enqueue<T>(profileId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(profileId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(
      profileId,
      next.catch(() => undefined),
    );
    return next;
  }

  #cancel(profileId: string): void {
    const pending = this.#timers.get(profileId);
    if (pending) clearTimeout(pending.timer);
    this.#timers.delete(profileId);
  }

  #schedule(profileId: string, delay: number): void {
    const due = Date.now() + delay;
    const pending = this.#timers.get(profileId);
    if (pending && pending.due <= due) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.#timers.delete(profileId);
      void this.#enqueue(profileId, () => this.#snapshot(profileId));
    }, delay);
    this.#timers.set(profileId, { timer, due });
  }

  /** Starts watching a session created after start() (a new bundle's sessions). */
  watch(profile: PocProfile): void {
    this.#digests.set(profile.id, digestOf([]));
    this.#watch(profile);
  }

  #watch(profile: PocProfile): void {
    if (this.#watched.has(profile.id)) return;
    const platform = this.#deps.platformOf(profile);
    if (!platform) return;
    this.#watched.add(profile.id);
    const domains = platform.cookieDomains;
    // The listener never reads cookie.value.
    this.#deps.sessionOf(profile).cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (this.#stopped || this.#suspended.has(profile.id)) return;
      if (!hostInDomains((cookie.domain ?? '').replace(/^\./, ''), domains)) return;
      // Persistent cookies are Chromium's job, but a session cookie can be
      // replaced by a persistent one (or the reverse), so every in-scope change is re-checked.
      this.#schedule(profile.id, removed ? REMOVAL_DEBOUNCE_MS : CHANGE_DEBOUNCE_MS);
    });
  }

  async #snapshot(profileId: string): Promise<void> {
    const profile = this.#deps.store.get(profileId);
    const platform = profile ? this.#deps.platformOf(profile) : undefined;
    if (!profile || !platform) return;
    const domains = platform.cookieDomains;
    let live: NormalizedCookie[];
    try {
      const jar = await this.#deps.sessionOf(profile).cookies.get({});
      live = jar
        .filter((c) => hostInDomains((c.domain ?? '').replace(/^\./, ''), domains))
        .map(fromElectronSessionCookie)
        .filter((c): c is NormalizedCookie => c !== null);
    } catch {
      this.#deps.log.warn('session_snapshot_failed', { profileId, reason: 'jar_unreadable' });
      return;
    }
    const { cookies, dropped } = restorableSessionCookies(live, domains);
    const digest = digestOf(cookies);
    if (digest === this.#digests.get(profileId)) return;
    if (this.#save(profile, cookies, dropped)) this.#digests.set(profileId, digest);
  }

  /** Writes revision n+1. Returns false (and records why) if it could not be sealed. */
  #save(profile: PocProfile, cookies: readonly NormalizedCookie[], dropped: number): boolean {
    const { dir, store, log } = this.#deps;
    const paths = snapshotPaths(dir, profile.id);
    const previous = profile.sessionSync;
    const revision = previous.revision + 1;
    const at = new Date().toISOString();
    let saveError: string | null = null;
    try {
      if (!protectedStorageAvailable()) {
        // Never write plaintext; and never leave an older snapshot that could be restored.
        rmSync(paths.record, { force: true });
        rmSync(paths.revision, { force: true });
        saveError = 'protected_storage_unavailable';
      } else {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const binding = bindingOf(profile);
        const revisionRecord = safeStorage.encryptString(encodeRevisionRecord(binding, revision, cookies.length));
        if (cookies.length > 0) {
          // Snapshot first, then its revision record: a crash in between leaves
          // snapshot n with revision record n-1, which still restores (n >= n-1).
          writeAtomic(paths.record, safeStorage.encryptString(encodeSessionRestore(binding, revision, cookies)));
          writeAtomic(paths.revision, revisionRecord);
        } else {
          // Revision record first: a crash before the delete leaves a stale snapshot that the record overrides.
          writeAtomic(paths.revision, revisionRecord);
          rmSync(paths.record, { force: true });
        }
      }
    } catch {
      saveError = 'write_failed';
    }

    const removedAll = previous.savedCount > 0 && cookies.length === 0 && saveError === null;
    const loggedInStatus = profile.status === 'imported_unverified' || profile.status === 'appears_authenticated' || profile.status === 'confirmed_by_user';
    const sync: SessionSyncState =
      saveError === null
        ? { ...previous, revision, savedCount: cookies.length, savedAt: at, saveError: null }
        : { ...previous, revision: saveError === 'protected_storage_unavailable' ? revision : previous.revision, savedCount: 0, saveError };
    store.update(profile.id, {
      sessionSync: sync,
      ...(removedAll && loggedInStatus ? { status: 'expired' as const, statusReason: 'session_cookies_removed' } : {}),
    });
    if (saveError) {
      log.warn('session_snapshot_not_saved', { profileId: profile.id, reason: saveError, count: cookies.length });
      return saveError === 'protected_storage_unavailable';
    }
    log.info('session_snapshot_saved', { profileId: profile.id, revision, count: cookies.length, dropped });
    return true;
  }

  async #restoreProfile(profile: PocProfile): Promise<void> {
    const { store, log } = this.#deps;
    let summary: SessionRestoreSummary | null;
    let revision = profile.sessionSync.revision;
    try {
      const restored = await this.#restore(profile);
      if (restored === null) {
        this.#digests.set(profile.id, digestOf([]));
        return;
      }
      revision = Math.max(revision, restored.revision);
      this.#digests.set(profile.id, digestOf(restored.cookies));
      summary = { at: new Date().toISOString(), state: 'restored', count: restored.cookies.length, error: null };
      log.info('session_restored', { profileId: profile.id, revision: restored.revision, count: restored.cookies.length });
    } catch (err) {
      const code = err instanceof RestoreFailure ? err.code : 'internal_error';
      this.#digests.set(profile.id, digestOf([]));
      summary = { at: new Date().toISOString(), state: 'failed', count: 0, error: code };
      log.warn('session_restore_failed', { profileId: profile.id, error: code });
    }
    store.update(profile.id, {
      sessionSync: { ...profile.sessionSync, revision, restore: summary },
      ...(summary.state === 'restored'
        ? { status: 'imported_unverified', statusReason: 'session_restored' }
        : { status: 'locked_unavailable', statusReason: 'session_restore_failed' }),
    });
  }

  /** Returns null when there is nothing to restore; throws RestoreFailure on any problem. */
  async #restore(profile: PocProfile): Promise<{ revision: number; cookies: readonly NormalizedCookie[] } | null> {
    const decoded = readSnapshot(this.#deps.dir, profile, this.#deps.platformOf(profile)?.cookieDomains ?? []);
    if (!decoded) return null;
    const ses = this.#deps.sessionOf(profile);
    const set: Array<{ url: string; name: string }> = [];
    for (const cookie of decoded.cookies) {
      const converted = toElectronCookie(cookie);
      try {
        if (!converted.ok) throw new Error(converted.code);
        await ses.cookies.set(converted.details);
        set.push({ url: converted.details.url, name: converted.details.name ?? '' });
      } catch {
        await Promise.allSettled(set.map((c) => ses.cookies.remove(c.url, c.name)));
        throw new RestoreFailure('browser_rejected');
      }
    }
    return { revision: decoded.revision, cookies: decoded.cookies };
  }
}
