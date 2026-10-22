import { app, session, type BrowserWindow } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, type PlatformDefinition } from '@ugc/core';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import { readRuntimeConfig } from './config.js';
import { registerIpc } from './ipc.js';
import { ProxyService, PUBLIC_DIAGNOSTIC_ENDPOINTS, syntheticDiagnosticEndpoints } from './proxy.js';
import { resolvePlatform } from './platforms.js';
import { ProfileStore } from './profiles.js';
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

const logDir = join(app.getPath('userData'), 'logs');
mkdirSync(logDir, { recursive: true });
const log = createLogger((line) => appendFileSync(join(logDir, 'poc.log'), `${line}\n`, { mode: 0o600 }));
const restoreDir = join(app.getPath('userData'), 'session-restore');

let mainWindow: BrowserWindow | null = null;
let store: ProfileStore | undefined;
let platform: PlatformDefinition | null = null;
let sync: SessionSync | null = null;
let proxies: ProxyService | null = null;

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, details) => log.warn('renderer_gone', { reason: details.reason }));
});

if (securityCheck) {
  // Local, read-only leak check (C4). No window, no IPC, no network, no restore.
  void app.whenReady().then(async () => {
    const scanRoots = process.argv.flatMap((arg, i, all) => (all[i - 1] === '--scan' ? [arg] : []));
    const code = await runSecurityCheck({ userData: app.getPath('userData'), restoreDir, scanRoots, log });
    app.exit(code);
  });
} else {
  void app.whenReady().then(async () => {
    try {
      platform = resolvePlatform(config);
    } catch (err) {
      // An invalid platform definition would widen or break the cookie scope: refuse to run.
      log.error('platform_definition_invalid', { err });
      app.exit(3);
      return;
    }
    store = new ProfileStore(join(app.getPath('userData'), 'poc-profiles.json'), platform?.id ?? null);
    hardenSession(session.defaultSession, { ...config, synthetic: false }, null, log);
    if (platform) {
      const active = platform;
      const sessionOf = (p: { partition: string }) => profileSession(p.partition, config, active, log);
      // Proxies first: every partition gets its proxy before anything can make a request from it.
      proxies = new ProxyService({
        dir: join(app.getPath('userData'), 'proxy-secrets'),
        store,
        config,
        platform: active,
        log,
        sessionOf,
        hardenTestSession: (ses) => void hardenSession(ses, config, active, log),
        endpoints: config.synthetic && config.siteOrigin ? syntheticDiagnosticEndpoints(config.siteOrigin) : PUBLIC_DIAGNOSTIC_ENDPOINTS,
      });
      await proxies.start();
      sync = new SessionSync({ dir: restoreDir, store, platform: active, log, sessionOf });
      // Restore sealed session cookies before any window or IPC handler exists.
      await sync.start();
    }
    serveAppProtocol(join(here, '..', 'renderer'));
    registerIpc({ config, store, log, mainWindow: () => mainWindow, platform, sync, proxies, userData: app.getPath('userData') });
    mainWindow = createMainWindow(join(here, '..', 'preload', 'preload.cjs'), config.synthetic, log);
    mainWindow.on('closed', () => (mainWindow = null));
    log.info('app_ready', { synthetic: config.synthetic, platform: platform?.id ?? null, profiles: store.list().length });
  });

  // Before exit: save each profile's session-cookie snapshot one last time, then
  // flush every cookie store so restart sees the same state.
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed || !store) return;
    event.preventDefault();
    const profiles = store.list();
    void (sync ? sync.stop() : Promise.resolve())
      .then(() => Promise.allSettled(profiles.map((p) => profileSession(p.partition, config, platform, log).cookies.flushStore())))
      .then(() => {
        flushed = true;
        log.info('cookie_stores_flushed');
        app.quit();
      });
  });

  app.on('window-all-closed', () => app.quit());
}
