import { BrowserWindow, type WebContents } from 'electron';
import { urlInDomains, type Logger } from '@ugc/core';

function guardNavigation(contents: WebContents, isAllowed: (url: string) => boolean, log: Logger): void {
  const block = (event: { preventDefault(): void }, url: string): void => {
    if (isAllowed(url)) return;
    event.preventDefault();
    log.warn('navigation_blocked', { url });
  };
  contents.on('will-navigate', (event) => block(event, event.url));
  contents.on('will-redirect', (event) => block(event, event.url));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    log.warn('popup_blocked', { url });
    return { action: 'deny' };
  });
}

/** Trusted app UI. The only renderer that gets the preload bridge. */
export function createMainWindow(preloadPath: string, devTools: boolean, log: Logger): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'UGC Production OS — Gate 1 PoC',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools,
      spellcheck: false,
    },
  });
  guardNavigation(win.webContents, (url) => url.startsWith('app://ui/'), log);
  void win.loadURL('app://ui/index.html');
  return win;
}

/**
 * Untrusted third-party content: no preload, no Node, sandboxed, bound to
 * one profile's partition and confined to that platform's navigation domains.
 */
export function openSiteWindow(
  partition: string,
  title: string,
  url: string,
  navigationDomains: readonly string[],
  devTools: boolean,
  log: Logger,
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools,
      spellcheck: false,
    },
  });
  guardNavigation(win.webContents, (target) => urlInDomains(target, navigationDomains), log);
  void win.loadURL(url);
  return win;
}
