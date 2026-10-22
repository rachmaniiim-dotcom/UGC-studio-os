import { session, type Session } from 'electron';
import { hostInDomains, type Logger, type PlatformDefinition } from '@ugc/core';
import type { RuntimeConfig } from './config.js';

const hardened = new WeakSet<Session>();

/**
 * Decides one download for a session: return true to accept it (the handler
 * then sets the save path), false to block. Sessions without a handler block
 * every download.
 */
export type DownloadHandler = (item: Electron.DownloadItem) => boolean;
const downloadHandlers = new WeakMap<Session, DownloadHandler>();

export function setDownloadHandler(ses: Session, handler: DownloadHandler): void {
  downloadHandlers.set(ses, handler);
}

/**
 * Applies the restrictions every profile partition gets: no permissions,
 * no downloads unless a narrow per-session handler accepts one (see
 * downloads.ts), and (synthetic mode only) trust for exactly one test
 * certificate on the synthetic hostnames.
 */
export function hardenSession(ses: Session, config: RuntimeConfig, platform: PlatformDefinition | null, log: Logger): Session {
  if (hardened.has(ses)) return ses;
  hardened.add(ses);

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    log.info('permission_denied', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event, item) => {
    const handler = downloadHandlers.get(ses);
    if (handler && handler(item)) return;
    event.preventDefault();
    log.info('download_blocked');
  });

  const fingerprint = config.siteCertFingerprint;
  // Synthetic runs only: every platform there is a stand-in on the synthetic site's domain.
  if (config.synthetic && fingerprint && platform) {
    const domains = platform.navigationDomains;
    ses.setCertificateVerifyProc((request, callback) => {
      // 0 = trust, -3 = use Chromium's normal verification result.
      const trusted = hostInDomains(request.hostname, domains) && request.certificate.fingerprint === fingerprint;
      callback(trusted ? 0 : -3);
    });
  }
  return ses;
}

export function profileSession(partition: string, config: RuntimeConfig, platform: PlatformDefinition | null, log: Logger): Session {
  return hardenSession(session.fromPartition(partition), config, platform, log);
}
