import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import {
  BUNDLE_PLATFORMS,
  DEFAULT_MAX_BYTES,
  bundleStatus,
  importCookieEditorExport,
  oversizedFileResult,
  validateAccountInput,
  validateCreativeInput,
  type BundleStatus,
  type CreativeSettings,
  type ImportReport,
  type Logger,
  type PlatformDefinition,
} from '@ugc/core';
import type { RuntimeConfig } from './config.js';
import { replaceCookies, type LoadResult } from './electron-cookies.js';
import { cookieEncryptionFuseEnabled } from './fuses.js';
import { GenerationError, type GenerationService } from './generation.js';
import type { GenerationJob, GenerationStore } from './generation-store.js';
import type { VideoLibrary } from './library.js';
import { SYNTHETIC_PLATFORM_ID } from './platforms.js';
import { PROFILE_ID, type AccountBundle, type BundleStore, type ImportSummary, type PocProfile, type ProfileStore, type ProxyState } from './profiles.js';
import { ProxyError, type ProxyInput, type ProxyService } from './proxy.js';
import { osCryptKeyPersisted, type SessionSync } from './session-sync.js';
import { profileSession } from './sessions.js';
import { probePermitted, probeSession } from './status.js';
import { openSiteWindow } from './windows.js';

export type IpcErrorCode =
  | 'untrusted_sender'
  | 'invalid_request'
  | 'unknown_profile'
  | 'unknown_account'
  | 'invalid_account'
  | 'cookie_encryption_disabled'
  | 'platform_not_active'
  | 'automated_check_not_permitted'
  | 'protected_key_not_ready'
  | 'invalid_proxy'
  | 'credentials_missing'
  | 'proxy_not_configured'
  | 'proxy_not_ready'
  | 'protected_storage_unavailable'
  | 'file_unreadable'
  | 'invalid_creative'
  | 'not_growth_account'
  | 'no_creative_settings'
  | 'no_provider'
  | 'job_in_progress'
  | 'daily_cap_reached'
  | 'unknown_job'
  | 'internal_error';

/** `details` carries sanitized issue codes (e.g. which field is invalid), never input values. */
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
  readonly sessions: ProfileStore;
  readonly bundles: BundleStore;
  readonly log: Logger;
  readonly mainWindow: () => BrowserWindow | null;
  /** Every platform this run can use, by id. */
  readonly platforms: ReadonlyMap<string, PlatformDefinition>;
  readonly sync: SessionSync | null;
  readonly proxies: ProxyService | null;
  readonly userData: string;
  readonly generation: GenerationService;
  readonly jobs: GenerationStore;
  readonly library: VideoLibrary;
  /** Called for each newly created bundle session (e.g. to attach the Flow download policy). */
  readonly onSessionCreated: (profile: PocProfile) => void;
}

/** What the UI may know about a platform. */
export interface PlatformInfo {
  readonly id: string;
  readonly displayName: string;
  readonly statusCheck: 'manual' | 'probe';
  readonly automation: 'permitted' | 'not_permitted';
  readonly pages: readonly string[];
}

/** A platform session as the UI sees it: non-secret state plus its platform's display facts. */
export type SessionView = PocProfile & { readonly platform: PlatformInfo };

/** An Account Bundle as the UI sees it. Proxy credentials are reduced to `hasCredentials`. */
export interface AccountView {
  readonly id: string;
  readonly displayName: string;
  readonly mode: AccountBundle['mode'];
  readonly status: BundleStatus;
  readonly proxy: ProxyState | null;
  readonly sessions: readonly SessionView[];
  /** Saved creative brief (the owner's own text) and video settings, or null. */
  readonly creative: CreativeSettings | null;
  readonly generation: {
    readonly provider: { readonly id: string; readonly displayName: string; readonly kind: string } | null;
    readonly unavailableReason: string | null;
    readonly dailyCap: number;
    readonly usedToday: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

const PROXY_KEYS = ['protocol', 'host', 'port', 'username', 'password'];
const MAX_PASTE_CHARS = DEFAULT_MAX_BYTES;

function requireObject(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new IpcError('invalid_request');
  const actual = Object.keys(payload);
  if (actual.length !== keys.length || !keys.every((k) => Object.hasOwn(payload, k))) throw new IpcError('invalid_request');
  return payload as Record<string, unknown>;
}

function platformInfo(p: PlatformDefinition): PlatformInfo {
  return {
    id: p.id,
    displayName: p.displayName,
    statusCheck: p.statusCheck.kind,
    automation: p.authorization.automation,
    pages: Object.keys(p.pages),
  };
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

export function registerIpc({
  config,
  sessions,
  bundles,
  log,
  mainWindow,
  platforms,
  sync,
  proxies,
  userData,
  generation,
  jobs,
  library,
  onSessionCreated,
}: IpcDeps): void {
  const devTools = config.synthetic;
  const platformOf = (profile: PocProfile): PlatformDefinition | undefined => platforms.get(profile.platformId);
  const sessionOf = (profile: PocProfile) => profileSession(profile.partition, config, platformOf(profile) ?? null, log);
  const fresh = (profile: PocProfile): PocProfile => sessions.get(profile.id) ?? profile;
  // Import and Clear run inside the session's sync queue, so the snapshot sees one consistent jar.
  const applyChange = <T>(profile: PocProfile, change: () => Promise<T>): Promise<T> => (sync ? sync.apply(profile.id, change) : change());

  const requireProfile = (payload: Record<string, unknown>): { profile: PocProfile; platform: PlatformDefinition } => {
    const id = payload['profileId'];
    if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new IpcError('invalid_request');
    const profile = sessions.get(id);
    if (!profile) throw new IpcError('unknown_profile');
    const platform = platformOf(profile);
    // Bundle-less profiles of earlier gates only exist for synthetic test runs.
    if (!platform || (profile.bundleId === null && !config.synthetic)) throw new IpcError('platform_not_active');
    return { profile, platform };
  };

  const requireBundle = (payload: Record<string, unknown>): AccountBundle => {
    const id = payload['bundleId'];
    if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new IpcError('invalid_request');
    const bundle = bundles.get(id);
    if (!bundle) throw new IpcError('unknown_account');
    return bundle;
  };

  const viewOf = (bundle: AccountBundle): AccountView => {
    const own = sessions.forBundle(bundle.id);
    return {
      id: bundle.id,
      displayName: bundle.displayName,
      mode: bundle.mode,
      status: bundleStatus(bundle.proxy, own.filter((s) => s.status !== 'never_configured')),
      proxy: bundle.proxy,
      sessions: own.flatMap((s) => {
        const platform = platformOf(s);
        return platform ? [{ ...s, platform: platformInfo(platform) }] : [];
      }),
      creative: jobs.getCreative(bundle.id),
      generation: {
        provider: generation.provider
          ? { id: generation.provider.id, displayName: generation.provider.displayName, kind: generation.provider.kind }
          : null,
        unavailableReason: generation.unavailableReason,
        dailyCap: generation.dailyCap,
        usedToday: jobs.countToday(bundle.id),
      },
      createdAt: bundle.createdAt,
      updatedAt: bundle.updatedAt,
    };
  };

  // Nothing in a session's partition may reach the network until its bundle's proxy passed a test.
  const requireNetworkReady = async (profile: PocProfile): Promise<void> => {
    if (!proxies) throw new IpcError('proxy_not_configured');
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

  const requireImportAllowed = async (): Promise<void> => {
    if (!(await cookieEncryptionFuseEnabled()) && !config.allowUnencryptedSyntheticCookies) throw new IpcError('cookie_encryption_disabled');
    // On a brand-new profile, wait until the encryption key is on disk (about 10 s after first launch).
    if (config.requirePersistedKey && !osCryptKeyPersisted(userData)) throw new IpcError('protected_key_not_ready');
  };

  /** Validates Cookie-Editor JSON for the session's platform and loads it (file or paste). Zeroes `bytes` afterwards. */
  const importBytes = async (profile: PocProfile, platform: PlatformDefinition, bytes: Buffer): Promise<PocProfile> => {
    try {
      const result = importCookieEditorExport(bytes, { allowedDomains: platform.cookieDomains });
      if (!result.ok) {
        // A failed import leaves the partition's existing cookies and snapshot untouched.
        log.warn('cookie_import_failed', { profileId: profile.id, fileError: result.report.fileError ?? null, reasons: result.report.reasons });
        return sessions.update(profile.id, { lastImport: summarize(result.report, null) });
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
      return sessions.update(profile.id, {
        status: load.loaded > 0 ? 'imported_unverified' : fresh(profile).status,
        statusReason: null,
        lastImport: summarize(result.report, load),
      });
    } finally {
      bytes.fill(0);
    }
  };

  const legacyPlatform = config.synthetic ? (platforms.get(SYNTHETIC_PLATFORM_ID) ?? null) : null;

  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    // ---- Account Bundles (Gate 3) ----

    'accounts:list': async (payload): Promise<AccountView[]> => {
      if (payload !== undefined) throw new IpcError('invalid_request');
      return bundles.list().map(viewOf);
    },

    // Saves a draft: name and mode only. Sessions for every platform are created empty; no proxy yet.
    'accounts:create': async (payload): Promise<AccountView> => {
      const request = requireObject(payload, ['displayName', 'mode']);
      const valid = validateAccountInput({ displayName: request['displayName'], mode: request['mode'] });
      if (!valid.ok) throw new IpcError('invalid_account', valid.issues);
      const specs = BUNDLE_PLATFORMS.flatMap(({ id, optional }) => {
        const platform = platforms.get(id);
        return platform ? [{ platformId: id, label: platform.displayName, optional }] : [];
      });
      const bundle = bundles.create(valid.value, specs, sessions);
      for (const s of sessions.forBundle(bundle.id)) {
        await proxies?.attachSession(s);
        sync?.watch(s);
        onSessionCreated(s);
      }
      log.info('account_created', { bundleId: bundle.id, mode: bundle.mode });
      return viewOf(bundle);
    },

    'accounts:update': async (payload): Promise<AccountView> => {
      const request = requireObject(payload, ['bundleId', 'displayName', 'mode']);
      const bundle = requireBundle(request);
      const valid = validateAccountInput({ displayName: request['displayName'], mode: request['mode'] });
      if (!valid.ok) throw new IpcError('invalid_account', valid.issues);
      return viewOf(bundles.update(bundle.id, valid.value));
    },

    // Sets or replaces the bundle's dedicated proxy. The password is sealed at once and never returned.
    'accounts:set-proxy': async (payload): Promise<AccountView> => {
      const request = requireObject(payload, ['bundleId', 'proxy', 'keepCredentials']);
      const bundle = requireBundle(request);
      const input = request['proxy'];
      const keep = request['keepCredentials'];
      if (typeof input !== 'object' || input === null || Array.isArray(input) || typeof keep !== 'boolean') throw new IpcError('invalid_request');
      const keys = Object.keys(input);
      if (!keys.every((k) => PROXY_KEYS.includes(k)) || !['protocol', 'host', 'port'].every((k) => keys.includes(k))) {
        throw new IpcError('invalid_request');
      }
      return viewOf(await proxyCall(() => proxies!.configure(bundle, input as ProxyInput, keep)));
    },

    'accounts:test-proxy': async (payload): Promise<AccountView> => {
      const bundle = requireBundle(requireObject(payload, ['bundleId']));
      return viewOf(await proxyCall(() => proxies!.test(bundle)));
    },

    // Pasted Cookie-Editor JSON: validated and loaded in the main process; the renderer has already cleared its input.
    'accounts:import-text': async (payload): Promise<SessionView> => {
      const request = requireObject(payload, ['profileId', 'text']);
      const { profile, platform } = requireProfile(request);
      const text = request['text'];
      if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PASTE_CHARS) throw new IpcError('invalid_request');
      await requireImportAllowed();
      const updated = await importBytes(profile, platform, Buffer.from(text, 'utf8'));
      return { ...updated, platform: platformInfo(platform) };
    },

    // ---- Video generation (Gate 4): one job at a time, no bulk, no schedule ----

    'generation:save-settings': async (payload): Promise<AccountView> => {
      const request = requireObject(payload, ['bundleId', 'prompt', 'settings']);
      const bundle = requireBundle(request);
      const valid = validateCreativeInput({ prompt: request['prompt'], settings: request['settings'] });
      if (!valid.ok) throw new IpcError('invalid_creative', valid.issues);
      jobs.saveCreative(bundle.id, valid.value);
      log.info('creative_settings_saved', { bundleId: bundle.id });
      return viewOf(bundles.get(bundle.id)!);
    },

    'generation:start': async (payload): Promise<GenerationJob> => {
      const bundle = requireBundle(requireObject(payload, ['bundleId']));
      try {
        return generation.start(bundle.id);
      } catch (err) {
        if (err instanceof GenerationError) throw new IpcError(err.code);
        throw err;
      }
    },

    'generation:list': async (payload): Promise<readonly GenerationJob[]> => {
      const bundle = requireBundle(requireObject(payload, ['bundleId']));
      return jobs.list(bundle.id);
    },

    // Shows a finished video in Explorer. The app itself never opens or reads the video's content.
    'generation:reveal': async (payload): Promise<{ shown: boolean }> => {
      const request = requireObject(payload, ['jobId']);
      const id = request['jobId'];
      if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new IpcError('invalid_request');
      const job = jobs.get(id);
      if (!job || job.state !== 'completed' || !job.videoFile) throw new IpcError('unknown_job');
      shell.showItemInFolder(library.absolute(job.videoFile));
      return { shown: true };
    },

    // ---- Platform sessions (shared by bundle sessions and the earlier gates' test profiles) ----

    'poc:get-platform': async (payload): Promise<PlatformInfo | null> => {
      if (payload !== undefined) throw new IpcError('invalid_request');
      return legacyPlatform ? platformInfo(legacyPlatform) : null;
    },

    // The bundle-less synthetic test profiles of Gates 1–2 (empty outside synthetic runs).
    'poc:list-profiles': async (payload) => {
      if (payload !== undefined) throw new IpcError('invalid_request');
      return legacyPlatform ? sessions.list().filter((p) => p.bundleId === null && p.platformId === legacyPlatform.id) : [];
    },

    'poc:import-cookies': async (payload): Promise<ImportOutcome> => {
      const { profile, platform } = requireProfile(requireObject(payload, ['profileId']));
      await requireImportAllowed();
      // The main process picks and reads the file: the file is never handed to a renderer.
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
          return { canceled: false, profile: sessions.update(profile.id, { lastImport: summarize(oversizedFileResult().report, null) }) };
        }
        bytes = await readFile(file);
      } catch {
        throw new IpcError('file_unreadable');
      }
      return { canceled: false, profile: await importBytes(profile, platform, bytes) };
    },

    'poc:check-status': async (payload) => {
      const { profile, platform } = requireProfile(requireObject(payload, ['profileId']));
      // Platforms that forbid automation get no app-initiated request, ever (C3).
      if (!probePermitted(platform)) throw new IpcError('automated_check_not_permitted');
      await requireNetworkReady(profile);
      const everImported = (profile.lastImport?.browserLoaded ?? 0) > 0 || profile.sessionSync.savedCount > 0;
      const probe = await probeSession(sessionOf(profile), platform, everImported);
      log.info('session_checked', { profileId: profile.id, status: probe.status, reason: probe.reason });
      return sessions.update(profile.id, { status: probe.status, statusReason: probe.reason });
    },

    // The owner looked at the site in this session's window and reports what they saw.
    'poc:confirm-status': async (payload) => {
      const request = requireObject(payload, ['profileId', 'observation']);
      const { profile } = requireProfile(request);
      const observation = request['observation'];
      if (observation !== 'logged_in' && observation !== 'logged_out') throw new IpcError('invalid_request');
      log.info('session_confirmed_by_user', { profileId: profile.id, observation });
      return sessions.update(
        profile.id,
        observation === 'logged_in'
          ? { status: 'confirmed_by_user', statusReason: 'owner_confirmed' }
          : { status: 'expired', statusReason: 'owner_reported_logged_out' },
      );
    },

    // Open Browser / Log in here: a window on the session's partition, behind its bundle's tested proxy.
    'poc:open-site': async (payload) => {
      const request = requireObject(payload, ['profileId', 'page']);
      const { profile, platform } = requireProfile(request);
      const page = request['page'];
      if (typeof page !== 'string' || !Object.hasOwn(platform.pages, page)) throw new IpcError('invalid_request');
      await requireNetworkReady(profile);
      sessionOf(profile);
      const win = openSiteWindow(profile.partition, `${profile.label} — ${page}`, platform.pages[page]!, platform.navigationDomains, devTools, log);
      proxies?.watchWindow(win.webContents);
      return { opened: true };
    },

    'poc:clear-profile': async (payload) => {
      const { profile } = requireProfile(requireObject(payload, ['profileId']));
      const ses = sessionOf(profile);
      // The sync then saves the empty jar, which deletes the snapshot under a new revision.
      await applyChange(profile, async () => {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.cookies.flushStore();
      });
      log.info('profile_cleared', { profileId: profile.id });
      return sessions.update(profile.id, { status: 'never_configured', statusReason: null, lastImport: null });
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
