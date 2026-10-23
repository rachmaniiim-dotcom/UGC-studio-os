import { BrowserWindow as Windows, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  bundleStatus,
  importCookieEditorExport,
  oversizedFileResult,
  platformsForMode,
  PROMPT_ACTIONS,
  SHOWCASE_PAGE_URL,
  urlInDomains,
  validateAccountInput,
  validateCreativeInput,
  type BundleStatus,
  type CreativeSettings,
  type ImportReport,
  type Logger,
  type PlatformDefinition,
  type PromptAction,
} from '@ugc/core';
import type { RuntimeConfig } from './config.js';
import { replaceCookies, type LoadResult } from './electron-cookies.js';
import { cookieEncryptionFuseEnabled } from './fuses.js';
import { GenerationError, type GenerationService } from './generation.js';
import { AffiliateError, type AffiliateService } from './affiliate.js';
import { AffiliateStudioError, type AffiliateStudioService } from './affiliate-studio.js';
import { PoolError, type FlowPoolService } from './flow-pool.js';
import { GrowthError, type GrowthService } from './growth.js';
import { StudioError, type PromptStudioService } from './prompt-studio.js';
import { downloadListingImage, readOpenListing } from './listing-reader.js';
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
  | 'invalid_strategy'
  | 'invalid_reference'
  | 'invalid_creator'
  | 'unknown_reference'
  | 'invalid_csv'
  | 'source_not_authorized'
  | 'unknown_template'
  | 'invalid_template'
  | 'builtin_read_only'
  | 'invalid_template_config'
  | 'unknown_prompt'
  | 'invalid_prompt_edit'
  | 'prompt_action_not_allowed'
  | 'prompt_blocked'
  | 'concept_provider_failed'
  | 'unsafe_payload'
  | 'unknown_reference_asset'
  | 'invalid_reference_file'
  | 'rights_not_confirmed'
  | 'invalid_preset'
  | 'unknown_video'
  | 'invalid_post_link'
  | 'invalid_target'
  | 'not_affiliate_account'
  | 'unknown_product'
  | 'invalid_product_list'
  | 'invalid_facts'
  | 'invalid_daily_products'
  | 'daily_selection_full'
  | 'listing_not_confirmed'
  | 'showcase_action_not_allowed'
  | 'no_product_in_address'
  | 'no_research_window'
  | 'listing_unreadable'
  | 'session_not_configured'
  | 'not_pool_account'
  | 'invalid_pool_settings'
  | 'invalid_credit_balance'
  | 'no_pool_account_available'
  | 'flow_budget_exhausted'
  | 'product_not_ready'
  | 'invalid_creative_config'
  | 'unknown_clip'
  | 'invalid_plan_edit'
  | 'plan_blocked'
  | 'plan_action_not_allowed'
  | 'clip_action_not_allowed'
  | 'attempt_limit_reached'
  | 'product_daily_limit_reached'
  | 'not_a_flow_account'
  | 'ffmpeg_missing'
  | 'invalid_clip_file'
  | 'stitch_failed'
  | 'invalid_limits'
  | 'invalid_reason'
  | 'nothing_to_send'
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
  readonly growth: GrowthService;
  readonly studio: PromptStudioService;
  readonly affiliate: AffiliateService;
  readonly pool: FlowPoolService;
  readonly affiliateStudio: AffiliateStudioService;
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

const TEMPLATE_KEY = /^(builtin|custom)-[a-z0-9-]{1,40}$/;
const PROMPT_ACTION_NAMES: readonly string[] = Object.keys(PROMPT_ACTIONS);

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
  growth,
  studio,
  affiliate,
  pool,
  affiliateStudio,
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

  const aStudioCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (err) {
      if (err instanceof AffiliateStudioError) throw new IpcError(err.code as IpcErrorCode, err.details);
      if (err instanceof PoolError) throw new IpcError(err.code, err.details);
      throw err;
    }
  };
  const aStudioCallAsync = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AffiliateStudioError) throw new IpcError(err.code as IpcErrorCode, err.details);
      throw err;
    }
  };

  const poolCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (err) {
      if (err instanceof PoolError) throw new IpcError(err.code, err.details);
      throw err;
    }
  };

  const affiliateCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (err) {
      if (err instanceof AffiliateError) throw new IpcError(err.code, err.details);
      throw err;
    }
  };
  const bundleProfile = (bundleId: string, platformId: string): PocProfile => {
    const profile = sessions.list().find((p) => p.bundleId === bundleId && p.platformId === platformId);
    if (!profile || !platformOf(profile)) throw new IpcError('session_not_configured');
    return profile;
  };
  /**
   * Opens a URL of a real platform in the account's window for that platform. In synthetic runs
   * the same path is opened on the platform's synthetic stand-in host instead.
   */
  const openInAccount = async (bundleId: string, platformId: string, realUrl: string, label: string): Promise<BrowserWindow> => {
    const profile = bundleProfile(bundleId, platformId);
    const platform = platformOf(profile)!;
    let url = realUrl;
    if (!urlInDomains(realUrl, platform.navigationDomains)) {
      const real = new URL(realUrl);
      url = `${new URL(platform.pages['home']!).origin}${real.pathname}${real.search}`;
    }
    await requireNetworkReady(profile);
    sessionOf(profile);
    const win = openSiteWindow(profile.partition, `${profile.label} — ${label}`, url, platform.navigationDomains, devTools, log);
    proxies?.watchWindow(win.webContents);
    return win;
  };

  const studioError = (err: unknown): never => {
    if (err instanceof StudioError) throw new IpcError(err.code, err.details);
    throw err;
  };
  const studioCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (err) {
      return studioError(err);
    }
  };
  const studioCallAsync = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      return studioError(err);
    }
  };
  const requireId = (request: Record<string, unknown>, field: string): string => {
    const id = request[field];
    if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new IpcError('invalid_request');
    return id;
  };
  const requireTemplateKey = (request: Record<string, unknown>): string => {
    const key = request['templateKey'];
    if (typeof key !== 'string' || !TEMPLATE_KEY.test(key)) throw new IpcError('invalid_request');
    return key;
  };

  const growthCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (err) {
      if (err instanceof GrowthError) throw new IpcError(err.code, err.details);
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
      const specs = platformsForMode(valid.value.mode).flatMap(({ id, optional }) => {
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
      // A Flow pool account has different sessions (Google Flow only), so it can't switch to or from a factory mode.
      if (valid.value.mode !== bundle.mode && (valid.value.mode === 'flow_pool' || bundle.mode === 'flow_pool')) throw new IpcError('invalid_account', ['mode_change_not_allowed']);
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

    // ---- Growth Intelligence (Gate 5, R1/R2): owner-entered research, deterministic scoring ----

    'growth:view': async (payload) => growthCall(() => growth.view(requireBundle(requireObject(payload, ['bundleId'])).id)),

    'growth:save-strategy': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'strategy']);
      const bundle = requireBundle(request);
      return growthCall(() => {
        growth.saveStrategy(bundle.id, request['strategy']);
        return growth.view(bundle.id);
      });
    },

    'growth:add-creator': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'handle', 'note']);
      const bundle = requireBundle(request);
      if (typeof request['handle'] !== 'string' || typeof request['note'] !== 'string') throw new IpcError('invalid_request');
      return growthCall(() => {
        growth.addCreator(bundle.id, request['handle'] as string, request['note'] as string);
        return growth.view(bundle.id);
      });
    },

    'growth:remove-creator': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'creatorId']);
      const bundle = requireBundle(request);
      if (typeof request['creatorId'] !== 'string' || !PROFILE_ID.test(request['creatorId'])) throw new IpcError('invalid_request');
      return growthCall(() => {
        growth.removeCreator(bundle.id, request['creatorId'] as string);
        return growth.view(bundle.id);
      });
    },

    'growth:add-reference': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'reference']);
      const bundle = requireBundle(request);
      const reference = request['reference'];
      if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) throw new IpcError('invalid_request');
      return growthCall(() => {
        const outcome = growth.addReference(bundle.id, reference as Record<string, unknown>);
        return { outcome, view: growth.view(bundle.id) };
      });
    },

    'growth:update-reference': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'referenceId', 'patch']);
      const bundle = requireBundle(request);
      const patch = request['patch'];
      if (typeof request['referenceId'] !== 'string' || !PROFILE_ID.test(request['referenceId']) || typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new IpcError('invalid_request');
      }
      return growthCall(() => {
        growth.updateReference(bundle.id, request['referenceId'] as string, patch as Record<string, unknown>);
        return growth.view(bundle.id);
      });
    },

    'growth:remove-reference': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'referenceId']);
      const bundle = requireBundle(request);
      if (typeof request['referenceId'] !== 'string' || !PROFILE_ID.test(request['referenceId'])) throw new IpcError('invalid_request');
      return growthCall(() => {
        growth.removeReference(bundle.id, request['referenceId'] as string);
        return growth.view(bundle.id);
      });
    },

    'growth:import-csv-text': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'text']);
      const bundle = requireBundle(request);
      const text = request['text'];
      if (typeof text !== 'string' || text.length > DEFAULT_MAX_BYTES) throw new IpcError('invalid_request');
      return growthCall(() => ({ result: growth.importCsv(bundle.id, text), view: growth.view(bundle.id) }));
    },

    // The main process picks and reads the CSV file (2 MB cap), like the cookie import.
    'growth:import-csv-file': async (payload) => {
      const bundle = requireBundle(requireObject(payload, ['bundleId']));
      const win = mainWindow();
      const options = { title: 'Import reference videos (CSV)', properties: ['openFile' as const], filters: [{ name: 'CSV', extensions: ['csv'] }] };
      const pick = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const file = pick.filePaths[0];
      if (pick.canceled || !file) return { canceled: true };
      let text: string;
      try {
        if ((await stat(file)).size > DEFAULT_MAX_BYTES) throw new IpcError('invalid_csv', ['too_large']);
        text = (await readFile(file)).toString('utf8');
      } catch (err) {
        if (err instanceof IpcError) throw err;
        throw new IpcError('file_unreadable');
      }
      return growthCall(() => ({ canceled: false, result: growth.importCsv(bundle.id, text), view: growth.view(bundle.id) }));
    },

    // ---- Prompt Studio (T1, Ternak Akun): templates → configuration → prompt batches → queue ----

    'studio:view': async (payload) => studioCall(() => studio.view(requireBundle(requireObject(payload, ['bundleId'])).id)),

    'studio:save-template': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'template', 'baseKey']);
      const bundle = requireBundle(request);
      const baseKey = request['baseKey'];
      if (baseKey !== null && (typeof baseKey !== 'string' || !TEMPLATE_KEY.test(baseKey))) throw new IpcError('invalid_request');
      return studioCall(() => {
        const saved = studio.saveTemplate(request['template'], baseKey as string | null);
        return { key: saved.key, view: studio.view(bundle.id) };
      });
    },

    'studio:duplicate-template': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'templateKey']);
      const bundle = requireBundle(request);
      const key = requireTemplateKey(request);
      return studioCall(() => {
        const copy = studio.duplicateTemplate(key);
        return { key: copy.key, view: studio.view(bundle.id) };
      });
    },

    'studio:save-config': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'templateKey', 'config']);
      const bundle = requireBundle(request);
      const key = requireTemplateKey(request);
      return studioCall(() => {
        studio.saveConfig(bundle.id, key, request['config']);
        return studio.view(bundle.id);
      });
    },

    'studio:generate': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'templateKey']);
      const bundle = requireBundle(request);
      const key = requireTemplateKey(request);
      return studioCallAsync(async () => {
        const batch = await studio.generate(bundle.id, key);
        return { batchId: batch.id, view: studio.view(bundle.id) };
      });
    },

    'studio:update-prompt': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId', 'content']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      return studioCall(() => {
        studio.updateItem(bundle.id, itemId, request['content']);
        return studio.view(bundle.id);
      });
    },

    'studio:prompt-action': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId', 'action']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      const action = request['action'];
      if (typeof action !== 'string' || !PROMPT_ACTION_NAMES.includes(action)) throw new IpcError('invalid_request');
      return studioCall(() => {
        studio.act(bundle.id, itemId, action as PromptAction);
        return studio.view(bundle.id);
      });
    },

    'studio:regenerate-prompt': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      return studioCallAsync(async () => {
        await studio.regenerate(bundle.id, itemId);
        return studio.view(bundle.id);
      });
    },

    // Copies the prompt for pasting into Google Flow by hand. The app never types into Flow.
    'studio:copy-prompt': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      return studioCall(() => {
        clipboard.writeText(studio.copyText(bundle.id, itemId));
        return { copied: true };
      });
    },

    'studio:generate-video': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      return studioCall(() => {
        try {
          studio.generateVideo(bundle.id, itemId);
        } catch (err) {
          if (err instanceof GenerationError) throw new IpcError(err.code);
          throw err;
        }
        return studio.view(bundle.id);
      });
    },

    'studio:link-video': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId', 'jobId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      const jobId = requireId(request, 'jobId');
      return studioCall(() => {
        studio.linkVideo(bundle.id, itemId, jobId);
        return studio.view(bundle.id);
      });
    },

    // The main process picks the file; the owner must have confirmed they own it or have rights to it.
    'studio:add-reference': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'rightsConfirmed']);
      const bundle = requireBundle(request);
      if (request['rightsConfirmed'] !== true) throw new IpcError('rights_not_confirmed');
      const win = mainWindow();
      const options = {
        title: 'Add a reference file you own or have rights to',
        properties: ['openFile' as const],
        filters: [{ name: 'Images and videos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov'] }],
      };
      const pick = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const file = pick.filePaths[0];
      if (pick.canceled || !file) return { canceled: true };
      return studioCallAsync(async () => {
        const asset = await studio.addReference(bundle.id, file, true);
        return { canceled: false, assetId: asset.id, view: studio.view(bundle.id) };
      });
    },

    'studio:remove-reference': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'assetId']);
      const bundle = requireBundle(request);
      const assetId = requireId(request, 'assetId');
      return studioCallAsync(async () => {
        await studio.removeReference(bundle.id, assetId);
        return studio.view(bundle.id);
      });
    },

    'studio:reveal-reference': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'assetId']);
      const bundle = requireBundle(request);
      const assetId = requireId(request, 'assetId');
      return studioCall(() => {
        shell.showItemInFolder(studio.referencePath(bundle.id, assetId));
        return { shown: true };
      });
    },

    'studio:copy-caption': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      return studioCall(() => {
        clipboard.writeText(studio.captionText(bundle.id, itemId));
        return { copied: true };
      });
    },

    // Records a post the owner made by hand on TikTok. The app never publishes.
    'studio:mark-posted': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId', 'postUrl']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      const postUrl = request['postUrl'];
      if (postUrl !== null && (typeof postUrl !== 'string' || postUrl.length > 500)) throw new IpcError('invalid_request');
      return studioCall(() => {
        studio.markPosted(bundle.id, itemId, postUrl as string | null);
        return studio.view(bundle.id);
      });
    },

    'studio:undo-posted': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      return studioCall(() => {
        studio.undoPosted(bundle.id, itemId);
        return studio.view(bundle.id);
      });
    },

    'studio:board': async () => studioCall(() => studio.board()),

    'studio:set-target': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'target']);
      const bundle = requireBundle(request);
      return studioCall(() => {
        studio.setDailyTarget(bundle.id, request['target']);
        return studio.board();
      });
    },

    'studio:save-preset': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'kind', 'name', 'text']);
      const bundle = requireBundle(request);
      return studioCall(() => {
        studio.savePreset(request['kind'], request['name'], request['text']);
        return studio.view(bundle.id);
      });
    },

    'studio:delete-preset': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'presetId']);
      const bundle = requireBundle(request);
      const presetId = requireId(request, 'presetId');
      return studioCall(() => {
        studio.deletePreset(presetId);
        return studio.view(bundle.id);
      });
    },

    // ---- Flow session pool (F0): Flow-only Google accounts supplying generation credits ----

    'pool:list': async () => poolCall(() => pool.list()),

    // Accounts' own Flow sessions that have used credits (next to the pool).
    'pool:others': async () => poolCall(() => pool.others()),

    'pool:save-settings': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'settings']);
      const bundle = requireBundle(request);
      return poolCall(() => {
        pool.saveSettings(bundle.id, request['settings']);
        return pool.list();
      });
    },

    'pool:set-remaining': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'remaining']);
      const bundle = requireBundle(request);
      return poolCall(() => {
        pool.setRemaining(bundle.id, request['remaining']);
        return pool.list();
      });
    },

    // Takes a queued prompt to a Flow pool account: prompt on the clipboard, that account's Flow window
    // opened (its own proxy). The owner generates and downloads there; the video comes back to this account.
    'studio:take-to-pool': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'itemId', 'poolId']);
      const bundle = requireBundle(request);
      const itemId = requireId(request, 'itemId');
      const poolId = request['poolId'] === null ? null : requireId(request, 'poolId');
      const target = poolCall(() => (poolId ? pool.account(poolId) : pool.pick()));
      const profile = bundleProfile(target.id, 'google-flow');
      await requireNetworkReady(profile);
      const text = studioCall(() => studio.takeToPool(bundle.id, itemId, target.id));
      clipboard.writeText(text);
      await openInAccount(target.id, 'google-flow', platformOf(profile)!.pages['home']!, 'Flow');
      return { poolId: target.id, view: studio.view(bundle.id) };
    },

    // ---- Affiliate Creative Studio (A2): Clip A/B plans, manual Flow clips, FFmpeg stitching, review ----

    'astudio:view': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId']);
      const bundle = requireBundle(request);
      return aStudioCall(() => affiliateStudio.view(bundle.id, requireId(request, 'productRowId')));
    },

    'astudio:save-config': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'config']);
      const bundle = requireBundle(request);
      return aStudioCall(() => {
        affiliateStudio.saveConfig(bundle.id, request['config']);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    'astudio:set-limits': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'limits']);
      const bundle = requireBundle(request);
      return aStudioCall(() => {
        affiliateStudio.setLimits(bundle.id, request['limits']);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    'astudio:generate': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId']);
      const bundle = requireBundle(request);
      const productRowId = requireId(request, 'productRowId');
      return aStudioCall(() => {
        const batchId = affiliateStudio.generate(bundle.id, productRowId);
        return { batchId, view: affiliateStudio.view(bundle.id, productRowId) };
      });
    },

    'astudio:update-plan': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'videoId', 'edit']);
      const bundle = requireBundle(request);
      return aStudioCall(() => {
        affiliateStudio.updatePlan(bundle.id, requireId(request, 'videoId'), request['edit']);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    'astudio:plan-action': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'videoId', 'action']);
      const bundle = requireBundle(request);
      const action = request['action'];
      if (action !== 'approve' && action !== 'reject' && action !== 'reopen') throw new IpcError('invalid_request');
      return aStudioCall(() => {
        affiliateStudio.planAction(bundle.id, requireId(request, 'videoId'), action);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    // Takes a clip to a Flow account (pool by credits, or a named Flow account): prompt on the
    // clipboard, that account's Flow window opened behind its own proxy. Generation is the owner's.
    'astudio:hand-off': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'clipId', 'flowBundleId']);
      const bundle = requireBundle(request);
      const clipId = requireId(request, 'clipId');
      const flowBundleId = request['flowBundleId'] === null ? null : requireId(request, 'flowBundleId');
      const target = flowBundleId ?? poolCall(() => pool.pick()).id;
      await requireNetworkReady(bundleProfile(target, 'google-flow'));
      const { text, flowBundleId: used } = aStudioCall(() => affiliateStudio.handOff(bundle.id, clipId, target));
      clipboard.writeText(text);
      const profile = bundleProfile(used, 'google-flow');
      await openInAccount(used, 'google-flow', platformOf(profile)!.pages['home']!, 'Flow');
      return aStudioCall(() => affiliateStudio.view(bundle.id, requireId(request, 'productRowId')));
    },

    // A3: plans the day's videos for the product and approves the clean ones, in one click.
    'astudio:make-videos': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId']);
      const bundle = requireBundle(request);
      const productRowId = requireId(request, 'productRowId');
      return aStudioCall(() => ({ ...affiliateStudio.makeVideos(bundle.id, productRowId), view: affiliateStudio.view(bundle.id, productRowId) }));
    },

    'astudio:approve-all': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId']);
      const bundle = requireBundle(request);
      const productRowId = requireId(request, 'productRowId');
      return aStudioCall(() => ({ ...affiliateStudio.approveAll(bundle.id, productRowId), view: affiliateStudio.view(bundle.id, productRowId) }));
    },

    // A3: the next clip in order goes to Flow (same checks as a single hand-off).
    'astudio:send-next': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'flowBundleId']);
      const bundle = requireBundle(request);
      const productRowId = requireId(request, 'productRowId');
      const flowBundleId = request['flowBundleId'] === null ? null : requireId(request, 'flowBundleId');
      const clipId = aStudioCall(() => affiliateStudio.nextClip(bundle.id, productRowId));
      const target = flowBundleId ?? poolCall(() => pool.pick()).id;
      await requireNetworkReady(bundleProfile(target, 'google-flow'));
      const { text, flowBundleId: used } = aStudioCall(() => affiliateStudio.handOff(bundle.id, clipId, target));
      clipboard.writeText(text);
      const profile = bundleProfile(used, 'google-flow');
      await openInAccount(used, 'google-flow', platformOf(profile)!.pages['home']!, 'Flow');
      return { clipId, view: aStudioCall(() => affiliateStudio.view(bundle.id, productRowId)) };
    },

    'astudio:copy-clip': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'clipId']);
      const bundle = requireBundle(request);
      return aStudioCall(() => {
        clipboard.writeText(affiliateStudio.clipText(bundle.id, requireId(request, 'clipId')));
        return { copied: true };
      });
    },

    'astudio:clip-failed': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'clipId', 'reason']);
      const bundle = requireBundle(request);
      if (typeof request['reason'] !== 'string') throw new IpcError('invalid_request');
      return aStudioCall(() => {
        affiliateStudio.clipFailed(bundle.id, requireId(request, 'clipId'), request['reason'] as string);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    'astudio:mark-unusable': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'clipId', 'reason']);
      const bundle = requireBundle(request);
      if (typeof request['reason'] !== 'string') throw new IpcError('invalid_request');
      return aStudioCall(() => {
        affiliateStudio.markUnusable(bundle.id, requireId(request, 'clipId'), request['reason'] as string);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    // The main process picks the clip file (MP4); it is validated and copied into the account library.
    'astudio:import-clip': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'clipId']);
      const bundle = requireBundle(request);
      const clipId = requireId(request, 'clipId');
      const win = mainWindow();
      const options = { title: 'Import a clip downloaded from Google Flow', properties: ['openFile' as const], filters: [{ name: 'MP4 video', extensions: ['mp4'] }] };
      const pick = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const file = pick.filePaths[0];
      if (pick.canceled || !file) return { canceled: true };
      await aStudioCallAsync(() => affiliateStudio.importClip(bundle.id, clipId, file));
      return { canceled: false, view: aStudioCall(() => affiliateStudio.view(bundle.id, requireId(request, 'productRowId'))) };
    },

    'astudio:export-frame': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'clipId']);
      const bundle = requireBundle(request);
      const png = await aStudioCallAsync(() => affiliateStudio.exportLastFrame(bundle.id, requireId(request, 'clipId')));
      shell.showItemInFolder(png);
      return { exported: true };
    },

    'astudio:stitch': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'videoId']);
      const bundle = requireBundle(request);
      await aStudioCallAsync(() => affiliateStudio.stitch(bundle.id, requireId(request, 'videoId')));
      return aStudioCall(() => affiliateStudio.view(bundle.id, requireId(request, 'productRowId')));
    },

    'astudio:review': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'productRowId', 'videoId', 'decision']);
      const bundle = requireBundle(request);
      const d = request['decision'] as Record<string, unknown> | null;
      if (typeof d !== 'object' || d === null || typeof d['approve'] !== 'boolean') throw new IpcError('invalid_request');
      const decision = d['approve'] ? { approve: true as const } : { approve: false as const, reason: String(d['reason']), redo: String(d['redo']) as 'A' | 'B' | 'both' };
      return aStudioCall(() => {
        affiliateStudio.review(bundle.id, requireId(request, 'videoId'), decision);
        return affiliateStudio.view(bundle.id, requireId(request, 'productRowId'));
      });
    },

    'astudio:library': async (payload) => {
      const bundle = requireBundle(requireObject(payload, ['bundleId']));
      return aStudioCall(() => affiliateStudio.library(bundle.id));
    },

    'astudio:reveal-final': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'videoId']);
      requireBundle(request);
      const path = affiliateStudio.finalPath(requireId(request, 'videoId'));
      if (!path) throw new IpcError('unknown_video');
      shell.showItemInFolder(path);
      return { shown: true };
    },

    // Product reference image (rights confirmed by the owner), kept locally; uploaded in Flow by hand.
    'astudio:add-image': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'rightsConfirmed']);
      const bundle = requireBundle(request);
      if (request['rightsConfirmed'] !== true) throw new IpcError('rights_not_confirmed');
      if (bundle.mode !== 'affiliate_ugc') throw new IpcError('not_affiliate_account');
      const win = mainWindow();
      const options = { title: 'Add a product image you have the rights to use', properties: ['openFile' as const], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] };
      const pick = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const file = pick.filePaths[0];
      if (pick.canceled || !file) return { canceled: true };
      const asset = await studioCallAsync(() => studio.addReference(bundle.id, file, true));
      return { canceled: false, assetId: asset.id };
    },

    // ---- Affiliate Products (A1): product IDs, today's selection, assisted Showcase ----

    'affiliate:view': async (payload) => affiliateCall(() => affiliate.view(requireBundle(requireObject(payload, ['bundleId'])).id)),

    'affiliate:add-text': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'text']);
      const bundle = requireBundle(request);
      if (typeof request['text'] !== 'string') throw new IpcError('invalid_request');
      return affiliateCall(() => ({ result: affiliate.addFromText(bundle.id, request['text'] as string), view: affiliate.view(bundle.id) }));
    },

    // Reads only the address of the account's open research (Kalodata) window, never its page.
    'affiliate:capture-from-research': async (payload) => {
      const bundle = requireBundle(requireObject(payload, ['bundleId']));
      const profile = bundleProfile(bundle.id, 'kalodata');
      const ses = sessionOf(profile);
      const open = Windows.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.session === ses && w.isVisible());
      const focused = open.find((w) => w.isFocused()) ?? open.at(-1);
      if (!focused) throw new IpcError('no_research_window');
      const address = focused.webContents.getURL();
      return affiliateCall(() => ({ ...affiliate.addFromAddress(bundle.id, address), view: affiliate.view(bundle.id) }));
    },

    'affiliate:remove': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      return affiliateCall(() => {
        affiliate.remove(bundle.id, id);
        return affiliate.view(bundle.id);
      });
    },

    'affiliate:select': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id', 'selected']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      if (typeof request['selected'] !== 'boolean') throw new IpcError('invalid_request');
      return affiliateCall(() => {
        affiliate.select(bundle.id, id, request['selected'] as boolean);
        return affiliate.view(bundle.id);
      });
    },

    'affiliate:set-limit': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'limit']);
      const bundle = requireBundle(request);
      return affiliateCall(() => {
        affiliate.setDailyLimit(bundle.id, request['limit']);
        return affiliate.view(bundle.id);
      });
    },

    'affiliate:update-facts': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id', 'facts']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      return affiliateCall(() => {
        affiliate.updateFacts(bundle.id, id, request['facts']);
        return affiliate.view(bundle.id);
      });
    },

    'affiliate:set-listing': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id', 'state']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      return affiliateCall(() => {
        affiliate.setListing(bundle.id, id, request['state']);
        return affiliate.view(bundle.id);
      });
    },

    'affiliate:set-eligibility': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id', 'state']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      return affiliateCall(() => {
        affiliate.setEligibility(bundle.id, id, request['state']);
        return affiliate.view(bundle.id);
      });
    },

    // Opens the product's TikTok page in this account's own TikTok window (its proxy and session).
    'affiliate:open-product': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      const { url } = affiliateCall(() => affiliate.productUrl(bundle.id, id));
      await openInAccount(bundle.id, 'tiktok', url, 'product');
      return { opened: true };
    },

    // A3: opens the product's listing in this account's TikTok window (its proxy, its login) and reads
    // the title, shop, price, description, feature lines and, if asked, the main photo from that page.
    // Nothing is clicked; a security check stays on screen for the owner, and reading resumes after it.
    'affiliate:autofill': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id', 'usePhoto']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      const usePhoto = request['usePhoto'] === true;
      const { productId, url } = affiliateCall(() => affiliate.productUrl(bundle.id, id));
      const profile = bundleProfile(bundle.id, 'tiktok');
      const win = await openInAccount(bundle.id, 'tiktok', url, 'product');
      const read = await readOpenListing(win, productId);
      if (!read.ok) throw new IpcError('listing_unreadable', [read.issue]);
      let imageAssetId: string | null = null;
      if (usePhoto && read.value.imageUrl) {
        const file = await downloadListingImage(sessionOf(profile), read.value.imageUrl, join(userData, 'tmp')).catch(() => null);
        if (file) {
          try {
            imageAssetId = (await studio.addReference(bundle.id, file, true)).id;
          } catch {
            imageAssetId = null;
          } finally {
            await rm(file, { force: true });
          }
        }
      }
      affiliateCall(() => affiliate.applyListing(bundle.id, id, read.value, imageAssetId));
      return { view: affiliate.view(bundle.id), found: read.found, features: read.value.features.length, photo: imageAssetId !== null };
    },

    // Assisted Showcase: opens TikTok's own Showcase page in this account's window, with the product
    // link on the clipboard. The owner adds it with TikTok's controls; nothing is clicked for them.
    'affiliate:open-showcase': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      const { url } = affiliateCall(() => affiliate.productUrl(bundle.id, id));
      const profile = bundleProfile(bundle.id, 'tiktok');
      await requireNetworkReady(profile);
      affiliateCall(() => affiliate.showcase(bundle.id, id, 'start'));
      clipboard.writeText(url);
      await openInAccount(bundle.id, 'tiktok', SHOWCASE_PAGE_URL, 'Showcase');
      return affiliate.view(bundle.id);
    },

    'affiliate:showcase': async (payload) => {
      const request = requireObject(payload, ['bundleId', 'id', 'action']);
      const bundle = requireBundle(request);
      const id = requireId(request, 'id');
      const action = request['action'];
      if (action !== 'confirm_seen' && action !== 'not_eligible' && action !== 'failed' && action !== 'removed' && action !== 'reset') throw new IpcError('invalid_request');
      return affiliateCall(() => {
        affiliate.showcase(bundle.id, id, action);
        return affiliate.view(bundle.id);
      });
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
