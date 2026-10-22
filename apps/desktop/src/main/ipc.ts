import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { DEFAULT_MAX_BYTES, importCookieEditorExport, oversizedFileResult, type ImportReport, type Logger } from '@ugc/core';
import { POC_PLATFORM, SITE_PAGES, type RuntimeConfig, type SitePage } from './config.js';
import { replaceCookies, type LoadResult } from './electron-cookies.js';
import { cookieEncryptionFuseEnabled } from './fuses.js';
import { PROFILE_ID, type ImportSummary, type PocProfile, type ProfileStore } from './profiles.js';
import { profileSession } from './sessions.js';
import { probeSyntheticSession } from './status.js';
import { openSiteWindow } from './windows.js';

export type IpcErrorCode =
  | 'untrusted_sender'
  | 'invalid_request'
  | 'unknown_profile'
  | 'cookie_encryption_disabled'
  | 'site_not_configured'
  | 'file_unreadable'
  | 'internal_error';

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode } };

class IpcError extends Error {
  constructor(readonly code: IpcErrorCode) {
    super(code);
  }
}

export interface IpcDeps {
  readonly config: RuntimeConfig;
  readonly store: ProfileStore;
  readonly log: Logger;
  readonly mainWindow: () => BrowserWindow | null;
}

function requireObject(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new IpcError('invalid_request');
  const actual = Object.keys(payload);
  if (actual.length !== keys.length || !keys.every((k) => Object.hasOwn(payload, k))) throw new IpcError('invalid_request');
  return payload as Record<string, unknown>;
}

function requireProfile(store: ProfileStore, payload: Record<string, unknown>): PocProfile {
  const id = payload['profileId'];
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new IpcError('invalid_request');
  const profile = store.get(id);
  if (!profile) throw new IpcError('unknown_profile');
  return profile;
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

export function registerIpc({ config, store, log, mainWindow }: IpcDeps): void {
  const sessionOf = (profile: PocProfile) => profileSession(profile.partition, config, log);
  const devTools = config.synthetic;

  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    'poc:list-profiles': async (payload) => {
      if (payload !== undefined) throw new IpcError('invalid_request');
      return store.list();
    },

    'poc:import-cookies': async (payload): Promise<ImportOutcome> => {
      const profile = requireProfile(store, requireObject(payload, ['profileId']));
      if (!(await cookieEncryptionFuseEnabled()) && !config.allowUnencryptedSyntheticCookies) {
        throw new IpcError('cookie_encryption_disabled');
      }
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
        const result = importCookieEditorExport(bytes, { allowedDomains: POC_PLATFORM.allowedCookieDomains });
        if (!result.ok) {
          // A failed import leaves the partition's existing cookies untouched.
          log.warn('cookie_import_failed', { profileId: profile.id, fileError: result.report.fileError ?? null, reasons: result.report.reasons });
          return { canceled: false, profile: store.update(profile.id, { lastImport: summarize(result.report, null) }) };
        }
        const load = await replaceCookies(sessionOf(profile), result.cookies);
        log.info('cookie_import_completed', {
          profileId: profile.id,
          imported: result.report.imported,
          skipped: result.report.skipped,
          rejected: result.report.rejected,
          browserLoaded: load.loaded,
          browserFailures: load.failures,
        });
        const updated = store.update(profile.id, {
          status: load.loaded > 0 ? 'imported_unverified' : profile.status,
          statusReason: null,
          lastImport: summarize(result.report, load),
        });
        return { canceled: false, profile: updated };
      } finally {
        bytes.fill(0);
      }
    },

    'poc:check-status': async (payload) => {
      const profile = requireProfile(store, requireObject(payload, ['profileId']));
      if (!config.siteOrigin) throw new IpcError('site_not_configured');
      const everImported = (profile.lastImport?.browserLoaded ?? 0) > 0;
      const probe = await probeSyntheticSession(sessionOf(profile), config.siteOrigin, everImported);
      log.info('session_checked', { profileId: profile.id, status: probe.status, reason: probe.reason });
      return store.update(profile.id, { status: probe.status, statusReason: probe.reason });
    },

    'poc:open-site': async (payload) => {
      const request = requireObject(payload, ['profileId', 'page']);
      const profile = requireProfile(store, request);
      const page = request['page'];
      if (typeof page !== 'string' || !Object.hasOwn(SITE_PAGES, page)) throw new IpcError('invalid_request');
      if (!config.siteOrigin) throw new IpcError('site_not_configured');
      sessionOf(profile);
      openSiteWindow(profile.partition, `${profile.label} — ${page}`, `${config.siteOrigin}${SITE_PAGES[page as SitePage]}`, devTools, log);
      return { opened: true };
    },

    'poc:clear-profile': async (payload) => {
      const profile = requireProfile(store, requireObject(payload, ['profileId']));
      const ses = sessionOf(profile);
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.cookies.flushStore();
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
        if (err instanceof IpcError) return { ok: false, error: { code: err.code } };
        log.error('ipc_handler_failed', { channel, err });
        return { ok: false, error: { code: 'internal_error' } };
      }
    });
  }
}
