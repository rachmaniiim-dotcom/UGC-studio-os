import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import {
  DEFAULT_MAX_BYTES,
  importCookieEditorExport,
  oversizedFileResult,
  type ImportReport,
  type Logger,
  type PlatformDefinition,
} from '@ugc/core';
import type { RuntimeConfig } from './config.js';
import { replaceCookies, type LoadResult } from './electron-cookies.js';
import { cookieEncryptionFuseEnabled } from './fuses.js';
import { PROFILE_ID, type ImportSummary, type PocProfile, type ProfileStore } from './profiles.js';
import { ProxyError, type ProxyService } from './proxy.js';
import { osCryptKeyPersisted, type SessionSync } from './session-sync.js';
import { profileSession } from './sessions.js';
import { probePermitted, probeSession } from './status.js';
import { openSiteWindow } from './windows.js';

export type IpcErrorCode =
  | 'untrusted_sender'
  | 'invalid_request'
  | 'unknown_profile'
  | 'cookie_encryption_disabled'
  | 'platform_not_active'
  | 'automated_check_not_permitted'
  | 'protected_key_not_ready'
  | 'invalid_proxy'
  | 'proxy_required'
  | 'proxy_not_configured'
  | 'proxy_not_ready'
  | 'protected_storage_unavailable'
  | 'file_unreadable'
  | 'internal_error';

/** `details` carries sanitized issue codes (e.g. which proxy field is invalid), never input values. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode; details?: readonly string[] } };

class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    readonly details: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface IpcDeps {
  readonly config: RuntimeConfig;
  readonly store: ProfileStore;
  readonly log: Logger;
  readonly mainWindow: () => BrowserWindow | null;
  /** This run's platform; null when none is configured (every profile call then fails). */
  readonly platform: PlatformDefinition | null;
  readonly sync: SessionSync | null;
  readonly proxies: ProxyService | null;
  readonly userData: string;
}

/** What the UI may know about the platform. */
export interface PlatformInfo {
  readonly id: string;
  readonly displayName: string;
  readonly statusCheck: 'manual' | 'probe';
  readonly automation: 'permitted' | 'not_permitted';
  readonly pages: readonly string[];
}

function requireObject(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new IpcError('invalid_request');
  const actual = Object.keys(payload);
  if (actual.length !== keys.length || !keys.every((k) => Object.hasOwn(payload, k))) throw new IpcError('invalid_request');
  return payload as Record<string, unknown>;
}

function requireProfile(
  store: ProfileStore,
  platform: PlatformDefinition | null,
  payload: Record<string, unknown>,
): { profile: PocProfile; platform: PlatformDefinition } {
  const id = payload['profileId'];
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new IpcError('invalid_request');
  const profile = store.get(id);
  if (!profile) throw new IpcError('unknown_profile');
  if (!platform || profile.platformId !== platform.id) throw new IpcError('platform_not_active');
  return { profile, platform };
}

function summarize(report: ImportReport, load: LoadResult | null): ImportSummary {
  return {
    at: new Date().toISOString(),
    format: report.format,
    fileError: report.fileError ?? null,
    examined: report.examined,
    imported: report.imported,
    skipped: report.skipped,
    rejected: report.rejected,
    reasons: report.reasons,
    messages: report.messages,
    browserLoaded: load?.loaded ?? 0,
    browserFailures: load?.failures ?? {},
  };
}

export interface ImportOutcome {
  readonly canceled: boolean;
  readonly profile: PocProfile;
}

export function registerIpc({ config, store, log, mainWindow, platform, sync, proxies, userData }: IpcDeps): void {
  const sessionOf = (profile: PocProfile) => profileSession(profile.partition, config, platform, log);
  const devTools = config.synthetic;
  const fresh = (profile: PocProfile): PocProfile => store.get(profile.id) ?? profile;
  // Import and Clear run inside the profile's sync queue, so the snapshot sees one consistent jar.
  const applyChange = <T>(profile: PocProfile, change: () => Promise<T>): Promise<T> => (sync ? sync.apply(profile.id, change) : change());
  // Nothing in a profile's partition may reach the network until its proxy (if required) passed a test.
  const requireNetworkReady = async (profile: PocProfile): Promise<void> => {
    if (!proxies) {
      if (!config.synthetic) throw new IpcError('proxy_not_configured');
      return;
    }
    try {
      await proxies.ensureReady(profile);
    } catch (err) {
      if (err instanceof ProxyError) throw new IpcError(err.code as IpcErrorCode);
      throw err;
    }
  };
  const proxyCall = async <T>(run: () => Promise<T>): Promise<T> => {
    if (!proxies) throw new IpcError('platform_not_active');
    try {
      return await run();
    } catch (err) {
      if (err instanceof ProxyError) throw new IpcError(err.code as IpcErrorCode, err.details);
      throw err;
    }
  };

  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    'poc:get-platform': async (payload): Promise<PlatformInfo | null> => {
      if (payload !== undefined) throw new IpcError('invalid_request');
      if (!platform) return null;
      return {
        id: platform.id,
        displayName: platform.displayName,
        statusCheck: platform.statusCheck.kind,
        automation: platform.authorization.automation,
        pages: Object.keys(platform.pages),
      };
    },

    'poc:list-profiles': async (payload) => {
      if (payload !== undefined) throw new IpcError('invalid_request');
      return platform ? store.list().filter((p) => p.platformId === platform.id) : [];
    },

    'poc:import-cookies': async (payload): Promise<ImportOutcome> => {
      const { profile, platform: active } = requireProfile(store, platform, requireObject(payload, ['profileId']));
      if (!(await cookieEncryptionFuseEnabled()) && !config.allowUnencryptedSyntheticCookies) {
        throw new IpcError('cookie_encryption_disabled');
      }
      // On a brand-new profile, wait until the encryption key is on disk (about 10 s after first launch).
      if (config.requirePersistedKey && !osCryptKeyPersisted(userData)) throw new IpcError('protected_key_not_ready');
      // The main process picks and reads the file: cookie JSON never passes through a renderer.
      const win = mainWindow();
      const options = {
        title: `Import Cookie-Editor JSON into ${profile.label}`,
        properties: ['openFile' as const],
        filters: [{ name: 'Cookie-Editor JSON', extensions: ['json'] }],
      };
      const pick = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const file = pick.filePaths[0];
      if (pick.canceled || !file) return { canceled: true, profile };

      let bytes: Buffer;
      try {
        if ((await stat(file)).size > DEFAULT_MAX_BYTES) {
          return { canceled: false, profile: store.update(profile.id, { lastImport: summarize(oversizedFileResult().report, null) }) };
        }
        bytes = await readFile(file);
      } catch {
        throw new IpcError('file_unreadable');
      }

      try {
        const result = importCookieEditorExport(bytes, { allowedDomains: active.cookieDomains });
        if (!result.ok) {
          // A failed import leaves the partition's existing cookies untouched.
          log.warn('cookie_import_failed', { profileId: profile.id, fileError: result.report.fileError ?? null, reasons: result.report.reasons });
          return { canceled: false, profile: store.update(profile.id, { lastImport: summarize(result.report, null) }) };
        }
        const load = await applyChange(profile, () => replaceCookies(sessionOf(profile), result.cookies));
        log.info('cookie_import_completed', {
          profileId: profile.id,
          imported: result.report.imported,
          skipped: result.report.skipped,
          rejected: result.report.rejected,
          browserLoaded: load.loaded,
          browserFailures: load.failures,
        });
        const updated = store.update(profile.id, {
          status: load.loaded > 0 ? 'imported_unverified' : fresh(profile).status,
          statusReason: null,
          lastImport: summarize(result.report, load),
        });
        return { canceled: false, profile: updated };
      } finally {
        bytes.fill(0);
      }
    },

    'poc:check-status': async (payload) => {
      const { profile, platform: active } = requireProfile(store, platform, requireObject(payload, ['profileId']));
      // Platforms that forbid automation get no app-initiated request, ever (C3).
      if (!probePermitted(active)) throw new IpcError('automated_check_not_permitted');
      await requireNetworkReady(profile);
      const everImported = (profile.lastImport?.browserLoaded ?? 0) > 0 || profile.sessionSync.savedCount > 0;
      const probe = await probeSession(sessionOf(profile), active, everImported);
      log.info('session_checked', { profileId: profile.id, status: probe.status, reason: probe.reason });
      return store.update(profile.id, { status: probe.status, statusReason: probe.reason });
    },

    // The owner looked at the site in this profile's window and reports what they saw.
    'poc:confirm-status': async (payload) => {
      const request = requireObject(payload, ['profileId', 'observation']);
      const { profile } = requireProfile(store, platform, request);
      const observation = request['observation'];
      if (observation !== 'logged_in' && observation !== 'logged_out') throw new IpcError('invalid_request');
      log.info('session_confirmed_by_user', { profileId: profile.id, observation });
      return store.update(
        profile.id,
        observation === 'logged_in'
          ? { status: 'confirmed_by_user', statusReason: 'owner_confirmed' }
          : { status: 'expired', statusReason: 'owner_reported_logged_out' },
      );
    },

    'poc:open-site': async (payload) => {
      const request = requireObject(payload, ['profileId', 'page']);
      const { profile, platform: active } = requireProfile(store, platform, request);
      const page = request['page'];
      if (typeof page !== 'string' || !Object.hasOwn(active.pages, page)) throw new IpcError('invalid_request');
      await requireNetworkReady(profile);
      sessionOf(profile);
      const win = openSiteWindow(profile.partition, `${profile.label} — ${page}`, active.pages[page]!, active.navigationDomains, devTools, log);
      proxies?.watchWindow(win.webContents);
      return { opened: true };
    },

    // Sets, replaces or (synthetic only) removes the profile's dedicated proxy. The password is sealed at once and never returned.
    'poc:set-proxy': async (payload) => {
      const request = requireObject(payload, ['profileId', 'proxy']);
      const { profile } = requireProfile(store, platform, request);
      const input = request['proxy'];
      if (input !== null) {
        if (typeof input !== 'object' || Array.isArray(input)) throw new IpcError('invalid_request');
        const keys = Object.keys(input);
        const allowed = ['protocol', 'host', 'port', 'username', 'password'];
        if (!keys.every((k) => allowed.includes(k)) || !['protocol', 'host', 'port'].every((k) => keys.includes(k))) {
          throw new IpcError('invalid_request');
        }
      }
      return proxyCall(() => proxies!.configure(profile, input as Parameters<ProxyService['configure']>[1]));
    },

    'poc:test-proxy': async (payload) => {
      const { profile } = requireProfile(store, platform, requireObject(payload, ['profileId']));
      return proxyCall(() => proxies!.test(profile));
    },

    'poc:clear-profile': async (payload) => {
      const { profile } = requireProfile(store, platform, requireObject(payload, ['profileId']));
      const ses = sessionOf(profile);
      // The sync then saves the empty jar, which deletes the snapshot under a new revision.
      await applyChange(profile, async () => {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.cookies.flushStore();
      });
      log.info('profile_cleared', { profileId: profile.id });
      return store.update(profile.id, { status: 'never_configured', statusReason: null, lastImport: null });
    },
  };

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const win = mainWindow();
    const frame = event.senderFrame;
    return (
      win !== null &&
      event.sender.id === win.webContents.id &&
      frame !== null &&
      frame === event.sender.mainFrame &&
      frame.url.startsWith('app://ui/')
    );
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event)) {
        log.warn('ipc_untrusted_sender', { channel });
        return { ok: false, error: { code: 'untrusted_sender' } };
      }
      if (args.length > 1) return { ok: false, error: { code: 'invalid_request' } };
      try {
        return { ok: true, data: await handler(args[0]) };
      } catch (err) {
        if (err instanceof IpcError) return { ok: false, error: { code: err.code, ...(err.details.length ? { details: err.details } : {}) } };
        log.error('ipc_handler_failed', { channel, err });
        return { ok: false, error: { code: 'internal_error' } };
      }
    });
  }
}
