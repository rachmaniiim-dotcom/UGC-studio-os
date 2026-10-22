import { session, type Session } from 'electron';
import { isDomainInScope, type Logger } from '@ugc/core';
import { POC_PLATFORM, type RuntimeConfig } from './config.js';

const hardened = new WeakSet<Session>();

/**
 * Applies the restrictions every profile partition gets: no permissions,
 * no downloads, and (synthetic mode only) trust for exactly one test
 * certificate on the synthetic hostnames.
 */
export function hardenSession(ses: Session, config: RuntimeConfig, log: Logger): Session {
  if (hardened.has(ses)) return ses;
  hardened.add(ses);

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    log.info('permission_denied', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => {
    event.preventDefault();
    log.info('download_blocked');
  });

  const fingerprint = config.siteCertFingerprint;
  if (config.synthetic && fingerprint) {
    ses.setCertificateVerifyProc((request, callback) => {
      // 0 = trust, -3 = use Chromium's normal verification result.
      const trusted =
        isDomainInScope(request.hostname, POC_PLATFORM.allowedCookieDomains) && request.certificate.fingerprint === fingerprint;
      callback(trusted ? 0 : -3);
    });
  }
  return ses;
}

export function profileSession(partition: string, config: RuntimeConfig, log: Logger): Session {
  return hardenSession(session.fromPartition(partition), config, log);
}

export function isAllowedSiteUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && isDomainInScope(url.hostname, POC_PLATFORM.allowedCookieDomains);
  } catch {
    return false;
  }
}
