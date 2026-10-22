import { app } from 'electron';

/**
 * Gate 1 supports exactly one platform: the local synthetic test site.
 * The importer rejects every cookie outside this domain, so real-site
 * cookies cannot be loaded by this build.
 */
export const POC_PLATFORM = {
  id: 'synthetic-poc',
  allowedCookieDomains: ['ugc-poc.test'],
} as const;

export const SITE_PAGES = {
  home: '/',
  strict: '/strict',
  'interactive-login': '/interactive-login',
} as const;
export type SitePage = keyof typeof SITE_PAGES;

export interface RuntimeConfig {
  /** Synthetic mode: map *.ugc-poc.test to 127.0.0.1 and trust the test site's certificate. */
  readonly synthetic: boolean;
  /** e.g. https://auth.ugc-poc.test:43123 */
  readonly siteOrigin: string | null;
  /** Electron-format certificate fingerprint of the synthetic site ("sha256/..."). */
  readonly siteCertFingerprint: string | null;
  /**
   * Lets an Electron binary without the cookie-encryption fuse import
   * synthetic cookies. Never honored in a packaged build.
   */
  readonly allowUnencryptedSyntheticCookies: boolean;
  readonly userDataOverride: string | null;
}

const SITE_ORIGIN = /^https:\/\/[a-z0-9-]+\.ugc-poc\.test(:\d{1,5})?$/;

/** Development-only switches come from the environment and are ignored when packaged. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dev = !app.isPackaged;
  const synthetic = dev && env['UGC_POC_SYNTHETIC'] === '1';
  const origin = env['UGC_POC_SITE_ORIGIN'] ?? '';
  const fingerprint = env['UGC_POC_SITE_CERT_FP'] ?? '';
  return {
    synthetic,
    siteOrigin: synthetic && SITE_ORIGIN.test(origin) ? origin : null,
    siteCertFingerprint: synthetic && fingerprint.startsWith('sha256/') ? fingerprint : null,
    allowUnencryptedSyntheticCookies: synthetic && env['UGC_POC_ALLOW_UNENCRYPTED_SYNTHETIC'] === '1',
    userDataOverride: dev && env['UGC_POC_USER_DATA'] ? env['UGC_POC_USER_DATA'] : null,
  };
}
