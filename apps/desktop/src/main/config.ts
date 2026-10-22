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
   * Synthetic only: seed the two bundle-less test profiles of Gates 1–2 (the
   * regression suites use them). Account-bundle tests turn it off with
   * UGC_POC_SEED_PROFILES=0. Real runs never seed.
   */
  readonly seedLegacyProfiles: boolean;
  /** Synthetic only: make the synthetic platform manual-status / no-automation, like a real restricted platform. */
  readonly syntheticManualStatus: boolean;
  /**
   * Refuse imports until Chromium has written its encryption key to disk
   * (Windows; see session-sync.ts osCryptKeyPersisted). Always on outside
   * synthetic mode; synthetic runs opt in with UGC_POC_REQUIRE_PERSISTED_KEY=1.
   */
  readonly requirePersistedKey: boolean;
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
    seedLegacyProfiles: synthetic && env['UGC_POC_SEED_PROFILES'] !== '0',
    syntheticManualStatus: synthetic && env['UGC_POC_STATUS_MODE'] === 'manual',
    requirePersistedKey: process.platform === 'win32' && (!synthetic || env['UGC_POC_REQUIRE_PERSISTED_KEY'] === '1'),
  };
}
