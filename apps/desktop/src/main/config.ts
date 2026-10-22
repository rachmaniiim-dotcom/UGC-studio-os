import { app } from 'electron';

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
  /**
   * The platform this run's profiles belong to (see platforms.ts). Synthetic
   * mode always uses the synthetic site; otherwise an unpackaged build reads
   * UGC_PLATFORM. Null means no platform: the app opens with no profiles.
   */
  readonly platformId: string | null;
  /** Synthetic only: make the synthetic platform manual-status / no-automation, like a real restricted platform. */
  readonly syntheticManualStatus: boolean;
  /**
   * Refuse imports until Chromium has written its encryption key to disk
   * (Windows; see session-sync.ts osCryptKeyPersisted). Always on outside
   * synthetic mode; synthetic runs opt in with UGC_POC_REQUIRE_PERSISTED_KEY=1.
   */
  readonly requirePersistedKey: boolean;
}

const PLATFORM_ID = /^[a-z][a-z0-9-]{1,31}$/;
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
    platformId: synthetic ? 'synthetic-poc' : dev && PLATFORM_ID.test(env['UGC_PLATFORM'] ?? '') ? (env['UGC_PLATFORM'] as string) : null,
    syntheticManualStatus: synthetic && env['UGC_POC_STATUS_MODE'] === 'manual',
    requirePersistedKey: process.platform === 'win32' && (!synthetic || env['UGC_POC_REQUIRE_PERSISTED_KEY'] === '1'),
  };
}
