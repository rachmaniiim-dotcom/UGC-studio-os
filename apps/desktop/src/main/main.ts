import { app, session, type BrowserWindow } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@ugc/core';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import { readRuntimeConfig } from './config.js';
import { registerIpc } from './ipc.js';
import { ProfileStore } from './profiles.js';
import { restoreSessionCookies } from './session-restore.js';
import { hardenSession, profileSession } from './sessions.js';
import { createMainWindow } from './windows.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = readRuntimeConfig();

if (config.userDataOverride) app.setPath('userData', config.userDataOverride);
if (config.synthetic) {
  // Resolve the synthetic hostnames locally and keep test traffic off any system proxy.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.ugc-poc.test 127.0.0.1');
  app.commandLine.appendSwitch('no-proxy-server');
}
registerAppScheme();

const logDir = join(app.getPath('userData'), 'logs');
mkdirSync(logDir, { recursive: true });
const log = createLogger((line) => appendFileSync(join(logDir, 'poc.log'), `${line}\n`, { mode: 0o600 }));

let mainWindow: BrowserWindow | null = null;
let store: ProfileStore;

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, details) => log.warn('renderer_gone', { reason: details.reason }));
});

void app.whenReady().then(async () => {
  store = new ProfileStore(join(app.getPath('userData'), 'poc-profiles.json'));
  hardenSession(session.defaultSession, { ...config, synthetic: false }, log);
  const restoreDir = join(app.getPath('userData'), 'session-restore');
  // Restore sealed session cookies before any window or IPC handler exists.
  for (const profile of store.list()) {
    const restored = await restoreSessionCookies(restoreDir, profile, profileSession(profile.partition, config, log), log);
    if (!restored) continue;
    store.update(profile.id, {
      sessionRestore: restored,
      ...(restored.state === 'restored'
        ? { status: 'imported_unverified', statusReason: 'session_restored' }
        : { status: 'locked_unavailable', statusReason: 'session_restore_failed' }),
    });
  }
  serveAppProtocol(join(here, '..', 'renderer'));
  registerIpc({ config, store, log, mainWindow: () => mainWindow, restoreDir });
  mainWindow = createMainWindow(join(here, '..', 'preload', 'preload.cjs'), config.synthetic, log);
  mainWindow.on('closed', () => (mainWindow = null));
  log.info('app_ready', { synthetic: config.synthetic, profiles: store.list().length });
});

// Flush every profile's cookie store before exit so restart sees the same state.
let flushed = false;
app.on('before-quit', (event) => {
  if (flushed || !store) return;
  event.preventDefault();
  void Promise.allSettled(store.list().map((p) => profileSession(p.partition, config, log).cookies.flushStore())).then(() => {
    flushed = true;
    log.info('cookie_stores_flushed');
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
