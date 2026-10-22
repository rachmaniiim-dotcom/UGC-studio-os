import { safeStorage, type Session } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeSessionRestore, encodeSessionRestore, restorableSessionCookies, type Logger, type NormalizedCookie } from '@ugc/core';
import { POC_PLATFORM } from './config.js';
import { toElectronCookie } from './electron-cookies.js';
import { PROFILE_ID, type PocProfile, type SessionRestoreSummary } from './profiles.js';

/**
 * Gate 1 hardening prototype for R-10: Chromium drops cookies without an
 * expiry when the app exits, so the imported ones are sealed with the OS
 * protected-storage API (DPAPI-backed on Windows) and set again at startup.
 * Not the Gate 3 vault: one sealed record per profile, written at import
 * time only.
 */

const LINUX_UNSAFE_BACKENDS = new Set(['basic_text', 'unknown']);

/** True only when safeStorage is backed by real OS key protection. */
export function protectedStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || !LINUX_UNSAFE_BACKENDS.has(safeStorage.getSelectedStorageBackend());
}

function sealedPath(dir: string, profileId: string): string {
  if (!PROFILE_ID.test(profileId)) throw new Error('invalid profile id');
  return join(dir, `${profileId}.sealed`);
}

export function removeSealedSession(dir: string, profileId: string): void {
  rmSync(sealedPath(dir, profileId), { force: true });
}

/**
 * Seals the profile's session cookies, replacing any earlier record. Returns
 * null when there is nothing to restore. Never writes plaintext: without
 * protected storage the record is dropped and the summary says so.
 */
export function sealSessionCookies(dir: string, profile: PocProfile, cookies: readonly NormalizedCookie[], log: Logger): SessionRestoreSummary | null {
  const sessionCookies = restorableSessionCookies(cookies);
  const at = new Date().toISOString();
  removeSealedSession(dir, profile.id);
  if (sessionCookies.length === 0) return null;
  if (!protectedStorageAvailable()) {
    log.warn('session_cookies_not_sealed', { profileId: profile.id, reason: 'protected_storage_unavailable' });
    return { at, state: 'not_sealed', count: sessionCookies.length, error: 'protected_storage_unavailable' };
  }
  try {
    const sealed = safeStorage.encryptString(encodeSessionRestore({ profileId: profile.id, partition: profile.partition }, sessionCookies));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = sealedPath(dir, profile.id);
    writeFileSync(`${file}.tmp`, sealed, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {
    rmSync(`${sealedPath(dir, profile.id)}.tmp`, { force: true });
    log.warn('session_cookies_not_sealed', { profileId: profile.id, reason: 'write_failed' });
    return { at, state: 'not_sealed', count: sessionCookies.length, error: 'write_failed' };
  }
  log.info('session_cookies_sealed', { profileId: profile.id, count: sessionCookies.length });
  return { at, state: 'sealed', count: sessionCookies.length, error: null };
}

/**
 * Restores one profile's sealed session cookies into its partition. Returns
 * null when the profile has no record. On any failure nothing from the
 * record is left in the partition and the record is kept for diagnosis
 * (a new import or Clear replaces it).
 */
export async function restoreSessionCookies(dir: string, profile: PocProfile, ses: Session, log: Logger): Promise<SessionRestoreSummary | null> {
  let sealed: Buffer;
  try {
    sealed = readFileSync(sealedPath(dir, profile.id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return fail(profile, 'unreadable', log);
    // A record was sealed earlier but is gone: say so rather than keep a stale "sealed".
    const expected = profile.sessionRestore !== null && profile.sessionRestore.state !== 'not_sealed';
    return expected ? fail(profile, 'record_missing', log) : null;
  }
  if (!protectedStorageAvailable()) return fail(profile, 'protected_storage_unavailable', log);

  let text: string;
  try {
    text = safeStorage.decryptString(sealed);
  } catch {
    // Chromium's error text is dropped: only the code is reported.
    return fail(profile, 'decrypt_failed', log);
  }
  const decoded = decodeSessionRestore(text, { profileId: profile.id, partition: profile.partition }, POC_PLATFORM.allowedCookieDomains);
  if (!decoded.ok) return fail(profile, decoded.code, log);

  const set: Array<{ url: string; name: string }> = [];
  for (const cookie of decoded.cookies) {
    const converted = toElectronCookie(cookie);
    try {
      if (!converted.ok) throw new Error(converted.code);
      await ses.cookies.set(converted.details);
      set.push({ url: converted.details.url, name: converted.details.name ?? '' });
    } catch {
      await Promise.allSettled(set.map((c) => ses.cookies.remove(c.url, c.name)));
      return fail(profile, 'browser_rejected', log);
    }
  }
  log.info('session_cookies_restored', { profileId: profile.id, count: set.length });
  return { at: new Date().toISOString(), state: 'restored', count: set.length, error: null };
}

function fail(profile: PocProfile, error: string, log: Logger): SessionRestoreSummary {
  log.warn('session_restore_failed', { profileId: profile.id, error });
  return { at: new Date().toISOString(), state: 'failed', count: 0, error };
}
