import { app, session, type BrowserWindow } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, TemplateProvider, type PlatformDefinition } from '@ugc/core';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import { readRuntimeConfig } from './config.js';
import { attachFlowDownloads } from './downloads.js';
import { GenerationService } from './generation.js';
import { GenerationStore } from './generation-store.js';
import { AffiliateService } from './affiliate.js';
import { AffiliateStudioService } from './affiliate-studio.js';
import { FfmpegRunner } from './ffmpeg.js';
import { configuredFlowSession, FlowPoolService } from './flow-pool.js';
import { GrowthService } from './growth.js';
import { PromptStudioService } from './prompt-studio.js';
import { registerIpc } from './ipc.js';
import { VideoLibrary } from './library.js';
import { SyntheticVideoProvider } from './synthetic-provider.js';
import { resolvePlatforms, SYNTHETIC_PLATFORM_ID } from './platforms.js';
import { BundleStore, MetadataDb, ProfileStore, type PocProfile } from './profiles.js';
import { ProxyService, PUBLIC_DIAGNOSTIC_ENDPOINTS, syntheticDiagnosticEndpoints } from './proxy.js';
import { runSecurityCheck } from './security-check.js';
import { SessionSync } from './session-sync.js';
import { hardenSession, profileSession } from './sessions.js';
import { createMainWindow } from './windows.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = readRuntimeConfig();
const securityCheck = process.argv.includes('--security-check');

if (config.userDataOverride) app.setPath('userData', config.userDataOverride);
if (config.synthetic) {
  // Resolve the synthetic hostnames locally and keep test traffic off any system proxy.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.ugc-poc.test 127.0.0.1');
  app.commandLine.appendSwitch('no-proxy-server');
}
registerAppScheme();

// One process per userData folder: the security check must never read a profile the app is using.
if (!app.requestSingleInstanceLock()) {
  if (securityCheck) process.stdout.write('UGC_SECURITY_CHECK {"result":"error","error":"app_running"}\n');
  app.exit(securityCheck ? 2 : 0);
}

const userData = app.getPath('userData');
const logDir = join(userData, 'logs');
mkdirSync(logDir, { recursive: true });
const log = createLogger((line) => appendFileSync(join(logDir, 'poc.log'), `${line}\n`, { mode: 0o600 }));
const restoreDir = join(userData, 'session-restore');

let mainWindow: BrowserWindow | null = null;
let sessions: ProfileStore | undefined;
let sync: SessionSync | null = null;

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, details) => log.warn('renderer_gone', { reason: details.reason }));
});

if (securityCheck) {
  // Local, read-only leak check (C4). No window, no IPC, no network, no restore.
  void app.whenReady().then(async () => {
    const scanRoots = process.argv.flatMap((arg, i, all) => (all[i - 1] === '--scan' ? [arg] : []));
    const code = await runSecurityCheck({ userData, restoreDir, scanRoots, log });
    app.exit(code);
  });
} else {
  void app.whenReady().then(async () => {
    let platforms: ReadonlyMap<string, PlatformDefinition>;
    try {
      platforms = resolvePlatforms(config);
    } catch (err) {
      // An invalid platform definition would widen or break a cookie scope: refuse to run.
      log.error('platform_definition_invalid', { err });
      app.exit(3);
      return;
    }
    const meta = MetadataDb.open(userData);
    sessions = new ProfileStore(meta, config.seedLegacyProfiles && platforms.has(SYNTHETIC_PLATFORM_ID) ? SYNTHETIC_PLATFORM_ID : null);
    const bundles = new BundleStore(meta);
    hardenSession(session.defaultSession, { ...config, synthetic: false }, null, log);

    const platformOf = (p: PocProfile): PlatformDefinition | undefined => platforms.get(p.platformId);
    const sessionOf = (p: PocProfile) => profileSession(p.partition, config, platformOf(p) ?? null, log);
    // Proxies first: every bundle partition gets its proxy (or the blackhole) before anything can make a request.
    const proxies = new ProxyService({
      dir: join(userData, 'proxy-secrets'),
      bundles,
      sessions,
      config,
      log,
      sessionOf,
      hardenTestSession: (ses) => void hardenSession(ses, config, platforms.values().next().value ?? null, log),
      endpoints: config.synthetic && config.siteOrigin ? syntheticDiagnosticEndpoints(config.siteOrigin) : PUBLIC_DIAGNOSTIC_ENDPOINTS,
    });
    await proxies.start();
    // Then restore sealed session cookies, still before any window or IPC handler exists.
    sync = new SessionSync({ dir: restoreDir, store: sessions, platformOf, log, sessionOf });
    await sync.start();

    // Video generation (Gate 4). Only the synthetic provider exists: automating the real
    // Google Flow website is not approved until its permitted use and feasibility are established.
    const jobs = new GenerationStore(meta);
    const library = new VideoLibrary(userData);
    const generation = new GenerationService({
      bundles,
      jobs,
      library,
      log,
      provider: config.synthetic ? new SyntheticVideoProvider() : null,
      unavailableReason: config.synthetic ? null : 'Automated Google Flow generation is not enabled yet. Generate in the Google Flow window and download the video: it is saved to this account’s library.',
      dailyCap: 3,
      pollIntervalMs: config.synthetic ? 100 : 2000,
      timeoutMs: 20 * 60 * 1000,
      ensureNetworkReady: async () => {
        throw new Error('no network provider configured');
      },
      onJobEnded: (job) => studio.jobEnded(job),
    });
    // Flow session pool (F0): credit ledger for Flow-only Google accounts.
    const flowSessionOf = configuredFlowSession(sessions!);
    const pool = new FlowPoolService(meta, bundles, log, flowSessionOf);
    // Prompt Studio (T1): deterministic template engine, no AI service and no network.
    const studio: PromptStudioService = new PromptStudioService({
      meta,
      bundles,
      jobs,
      generation,
      provider: new TemplateProvider(),
      log,
      userData,
      sensitiveValues: () => bundles.list().flatMap((b) => [b.id, b.displayName, b.proxy?.host ?? '', b.proxy?.observedIp ?? '']),
    });
    // Affiliate Creative Studio (A2): clips produced by hand in Flow, joined with the locally installed FFmpeg.
    const ffmpeg = await FfmpegRunner.locate();
    log.info('ffmpeg_located', { available: ffmpeg !== null });
    const affiliateStudio = new AffiliateStudioService({
      meta,
      bundles,
      jobs,
      library,
      pool,
      log,
      assets: (bundleId) => studio.assets(bundleId),
      ffmpeg: () => ffmpeg,
      flowSessionOf,
    });
    generation.reconcile();
    studio.reconcile();
    // The one download exception: videos the owner downloads in a bundle's Google Flow window.
    const attachDownloads = (p: PocProfile): void => {
      const platform = platformOf(p);
      if (platform) {
        attachFlowDownloads(p, platform, sessionOf(p), {
          library,
          jobs,
          log,
          synthetic: config.synthetic,
          // The oldest prompt or clip taken to this Flow window gets the download.
          claimPrompt: (bundleId) => {
            const prompt = studio.claimManualPrompt(bundleId);
            const clip = affiliateStudio.claimForFlow(bundleId);
            if (prompt && (!clip || prompt.since <= clip.since)) return { itemId: prompt.itemId, targetBundleId: prompt.targetBundleId };
            return clip ? { clipId: clip.clipId, targetBundleId: clip.targetBundleId } : null;
          },
          onEnded: (job) => {
            studio.jobEnded(job);
            const credits = pool.recordDownload(job);
            void affiliateStudio.jobEnded(job, credits).catch((err: unknown) => log.error('affiliate_clip_hook_error', { jobId: job.id, err }));
          },
        });
      }
    };
    for (const p of sessions.list()) attachDownloads(p);

    // The UI, plus read-only playback of this app's own library files (clips and finished videos).
    serveAppProtocol(join(here, '..', 'renderer'), (kind, id) => {
      if (kind === 'job') {
        const job = jobs.get(id);
        return job?.state === 'completed' && job.videoFile ? library.absolute(job.videoFile) : null;
      }
      return affiliateStudio.finalPath(id);
    });
    registerIpc({
      config,
      sessions,
      bundles,
      log,
      mainWindow: () => mainWindow,
      platforms,
      sync,
      proxies,
      userData,
      generation,
      jobs,
      library,
      onSessionCreated: attachDownloads,
      growth: new GrowthService(meta, bundles, log),
      studio,
      affiliate: new AffiliateService(meta, bundles, log),
      pool,
      affiliateStudio,
    });
    mainWindow = createMainWindow(join(here, '..', 'preload', 'preload.cjs'), config.synthetic, log);
    mainWindow.on('closed', () => (mainWindow = null));
    log.info('app_ready', { synthetic: config.synthetic, accounts: bundles.list().length, sessions: sessions.list().length });
  });

  // Before exit: save each session's cookie snapshot one last time, then
  // flush every cookie store so restart sees the same state.
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed || !sessions) return;
    event.preventDefault();
    const all = sessions.list();
    void (sync ? sync.stop() : Promise.resolve())
      .then(() => Promise.allSettled(all.map((p) => profileSession(p.partition, config, null, log).cookies.flushStore())))
      .then(() => {
        flushed = true;
        log.info('cookie_stores_flushed');
        app.quit();
      });
  });

  app.on('window-all-closed', () => app.quit());
}
