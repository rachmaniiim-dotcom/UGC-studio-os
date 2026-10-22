import { safeStorage, session } from 'electron';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Logger } from '@ugc/core';
import { cookieEncryptionFuseEnabled } from './fuses.js';
import { cookieDomainsFor } from './platforms.js';
import { ProfileStore, type PocProfile } from './profiles.js';
import { readProxyCredentials } from './proxy.js';
import { inspectSnapshot, protectedStorageAvailable } from './session-sync.js';

/**
 * Local security check (C4). Runs inside the Electron main process so it can
 * read the profiles' live cookie values (the needles) without writing them
 * anywhere, then searches files for those values and reports **only**
 * sanitized findings: check names, counts, profile labels and file paths.
 * Never cookie names or values. It sends nothing over the network and
 * writes nothing except a count-only log line.
 *
 * Limits: values shorter than MIN_NEEDLE_BYTES are skipped (too common to
 * mean anything); only raw and URL-encoded forms are searched; compressed
 * files (e.g. git objects) are not searched; JavaScript strings holding the
 * values can't be zeroed, but the needle buffers are, after use.
 */

const MIN_NEEDLE_BYTES = 8;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export interface Finding {
  readonly check: string;
  readonly severity: 'high' | 'medium';
  readonly count: number;
  /** A file path (root label + relative path) or a profile label. Never secret content. */
  readonly where?: string;
  /**
   * For leaked values: which kinds of cookie matched, by non-secret attributes
   * only ("<profile> <domain> <httpOnly|script-readable> <session|persistent>"),
   * with a count. Never names or values.
   */
  readonly matched?: readonly string[];
}

interface Needle {
  readonly bytes: Buffer[];
  readonly profiles: Set<string>;
  /** Non-secret descriptions of the cookies that hold this value. */
  readonly kinds: Set<string>;
}

/** Attributes a finding may show about a cookie: never its name or value. */
function describeCookie(profile: string, c: Electron.Cookie): string {
  const domain = (c.domain ?? '').replace(/^\./, '');
  return `${profile} ${domain} ${c.httpOnly ? 'httpOnly' : 'script-readable'} ${c.session ? 'session' : 'persistent'}`;
}

export interface SecurityCheckOptions {
  readonly userData: string;
  readonly restoreDir: string;
  readonly scanRoots: readonly string[];
  readonly log: Logger;
}

function cookieDatabase(userData: string, partition: string): string | null {
  const base = join(userData, 'Partitions', partition.replace(/^persist:/, ''));
  for (const candidate of [join(base, 'Network', 'Cookies'), join(base, 'Cookies')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Counts plaintext and encrypted rows without selecting any value. */
async function inspectCookieDb(file: string): Promise<{ rows: number; plaintextRows: number; prefixes: Record<string, number> } | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = (db.prepare('SELECT COUNT(*) AS n FROM cookies').get() as { n: number }).n;
      const plaintextRows = (db.prepare("SELECT COUNT(*) AS n FROM cookies WHERE value <> ''").get() as { n: number }).n;
      const prefixes: Record<string, number> = {};
      for (const r of db.prepare('SELECT substr(encrypted_value, 1, 3) AS p, COUNT(*) AS n FROM cookies WHERE length(encrypted_value) > 0 GROUP BY p').all() as Array<{
        p: Uint8Array;
        n: number;
      }>) {
        const prefix = /^v\d\d$/.test(Buffer.from(r.p).toString('latin1')) ? Buffer.from(r.p).toString('latin1') : 'other';
        prefixes[prefix] = (prefixes[prefix] ?? 0) + r.n;
      }
      return { rows, plaintextRows, prefixes };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function addNeedle(needles: Map<string, Needle>, value: string, profile: string, kind: string): boolean {
  if (Buffer.byteLength(value, 'utf8') < MIN_NEEDLE_BYTES) return false;
  const existing = needles.get(value);
  if (existing) {
    existing.profiles.add(profile);
    existing.kinds.add(kind);
    return true;
  }
  const forms = new Set([value, encodeURIComponent(value)]);
  needles.set(value, { bytes: [...forms].map((f) => Buffer.from(f, 'utf8')), profiles: new Set([profile]), kinds: new Set([kind]) });
  return true;
}

function* walk(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

function underSyncedFolder(path: string): boolean {
  const oneDrive = process.env['OneDrive'] ?? process.env['OneDriveConsumer'] ?? process.env['OneDriveCommercial'];
  const p = resolve(path).toLowerCase();
  return (oneDrive !== undefined && p.startsWith(resolve(oneDrive).toLowerCase() + sep)) || /[\\/]onedrive[\\/ -]/i.test(p);
}

export async function runSecurityCheck({ userData, restoreDir, scanRoots, log }: SecurityCheckOptions): Promise<number> {
  const findings: Finding[] = [];
  const add = (f: Finding): void => {
    findings.push(f);
  };

  // Environment.
  const fuse = await cookieEncryptionFuseEnabled();
  if (!fuse) add({ check: 'cookie_encryption_fuse_off', severity: 'high', count: 1 });
  const protectedStorage = protectedStorageAvailable();
  if (!protectedStorage) add({ check: 'protected_storage_unavailable', severity: 'high', count: 1 });
  const roots = [{ label: 'userData', path: userData }, ...scanRoots.map((p, i) => ({ label: `scan${i + 1}`, path: resolve(p) }))];
  for (const root of roots) if (underSyncedFolder(root.path)) add({ check: 'in_cloud_synced_folder', severity: 'medium', count: 1, where: root.label });

  let profiles: readonly PocProfile[] = [];
  try {
    profiles = new ProfileStore(join(userData, 'poc-profiles.json'), null, { readOnly: true }).list();
  } catch {
    add({ check: 'profile_store_unreadable', severity: 'medium', count: 1 });
  }

  // Phase 1: cookie databases, before any partition is opened in this process.
  // Once Chromium opens a partition it locks its Cookies file and Windows
  // refuses reads, so the file bytes are taken now, kept in memory only,
  // searched in phase 3 and zeroed after.
  const preRead = new Map<string, Buffer>();
  const profileReports = [];
  for (const p of profiles) {
    const db = cookieDatabase(userData, p.partition);
    if (db) {
      for (const file of [db, `${db}-journal`]) {
        try {
          preRead.set(resolve(file), readFileSync(file));
        } catch {
          // Missing journal, or unreadable: phase 3 counts it.
        }
      }
    }
    const stats = db ? await inspectCookieDb(db) : null;
    if (stats && stats.plaintextRows > 0) add({ check: 'plaintext_cookie_rows', severity: 'high', count: stats.plaintextRows, where: p.label });
    if (db && !stats) add({ check: 'cookie_db_unreadable', severity: 'medium', count: 1, where: p.label });
    profileReports.push({ label: p.label, platformId: p.platformId, cookieDb: stats, jarCookies: 0, needles: 0, skippedShort: 0, snapshot: 'none' });
  }

  // Phase 2: the values to look for (live jar + sealed snapshot), held in memory only.
  const needles = new Map<string, Needle>();
  for (const [i, p] of profiles.entries()) {
    const report = profileReports[i]!;
    let jar: Electron.Cookie[] = [];
    try {
      jar = await session.fromPartition(p.partition).cookies.get({});
    } catch {
      add({ check: 'jar_unreadable', severity: 'medium', count: 1, where: p.label });
    }
    report.jarCookies = jar.length;
    for (const c of jar) addNeedle(needles, c.value, p.label, describeCookie(p.label, c)) ? report.needles++ : report.skippedShort++;

    const snapshot = protectedStorage ? inspectSnapshot(restoreDir, p, cookieDomainsFor(p.platformId)) : { state: 'not_checked', cookies: [] };
    report.snapshot = snapshot.state;
    if (snapshot.state !== 'none' && snapshot.state !== 'ok' && snapshot.state !== 'not_checked') {
      add({ check: 'snapshot_not_restorable', severity: 'medium', count: 1, where: `${p.label}: ${snapshot.state}` });
    }
    for (const c of snapshot.cookies) {
      const kind = `${p.label} ${c.domain} ${c.httpOnly ? 'httpOnly' : 'script-readable'} session (sealed)`;
      addNeedle(needles, c.value.reveal(), p.label, kind) ? report.needles++ : report.skippedShort++;
    }
  }

  // Proxy credentials are secrets too: search for them like cookie values.
  for (const [i, p] of profiles.entries()) {
    const credentials = protectedStorage ? readProxyCredentials(join(userData, 'proxy-secrets'), p) : null;
    if (!credentials) continue;
    for (const [kind, value] of [['proxy-username', credentials.username], ['proxy-password', credentials.password]] as const) {
      addNeedle(needles, value, p.label, `${p.label} ${kind}`) ? profileReports[i]!.needles++ : profileReports[i]!.skippedShort++;
    }
  }

  // Account boundary: the same secret value in two profiles means one account in two profiles.
  const shared = [...needles.values()].filter((n) => n.profiles.size > 1);
  if (shared.length > 0) add({ check: 'value_shared_between_profiles', severity: 'medium', count: shared.length });

  // Phase 3: search files.
  const scan = { roots: roots.length, files: 0, bytes: 0, unreadable: 0, skippedLarge: 0 };
  // A folder given twice (or nested in another root) is searched once.
  const scanned = new Set<string>();
  for (const root of roots) {
    for (const file of walk(root.path)) {
      const key = resolve(file).toLowerCase();
      if (scanned.has(key)) continue;
      scanned.add(key);
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        scan.unreadable++;
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        scan.skippedLarge++;
        continue;
      }
      let content: Buffer;
      try {
        content = preRead.get(resolve(file)) ?? readFileSync(file);
      } catch {
        scan.unreadable++;
        continue;
      }
      scan.files++;
      scan.bytes += content.length;
      let hits = 0;
      const kinds = new Map<string, number>();
      for (const needle of needles.values()) {
        if (!needle.bytes.some((b) => content.includes(b))) continue;
        hits++;
        for (const kind of needle.kinds) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      if (hits > 0) {
        add({
          check: 'plaintext_secret_in_file',
          severity: 'high',
          count: hits,
          where: `${root.label}/${relative(root.path, file).split(sep).join('/')}`,
          matched: [...kinds].sort().map(([kind, n]) => `${kind} x${n}`),
        });
      }
    }
  }
  for (const needle of needles.values()) for (const b of needle.bytes) b.fill(0);
  needles.clear();
  for (const b of preRead.values()) b.fill(0);
  preRead.clear();

  const high = findings.filter((f) => f.severity === 'high').length;
  const report = {
    tool: 'ugc-security-check',
    version: 1,
    at: new Date().toISOString(),
    result: findings.length === 0 ? 'pass' : 'fail',
    summary: { findings: findings.length, high },
    environment: {
      platform: process.platform,
      cookieEncryptionFuse: fuse ? 'on' : 'off',
      protectedStorage: protectedStorage ? 'available' : 'unavailable',
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    },
    profiles: profileReports,
    scan,
    findings,
  };
  log.info('security_check_completed', { findings: findings.length, high, files: scan.files });
  process.stdout.write(`UGC_SECURITY_CHECK ${JSON.stringify(report)}\n`);
  return findings.length === 0 ? 0 : 1;
}
