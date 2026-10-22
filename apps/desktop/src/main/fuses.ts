import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

let cached: Promise<boolean> | undefined;

/**
 * Reads the running Electron binary's EnableCookieEncryption fuse. When it
 * is off, Chromium writes cookie values to the partition's Cookies database
 * in plaintext.
 */
export function cookieEncryptionFuseEnabled(): Promise<boolean> {
  cached ??= getCurrentFuseWire(process.execPath)
    .then((wire) => wire[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE)
    .catch(() => false);
  return cached;
}
