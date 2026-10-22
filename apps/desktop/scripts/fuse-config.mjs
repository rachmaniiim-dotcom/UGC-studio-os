// Electron fuse settings. PRODUCTION_FUSES is what the packaging step (not yet
// set up) must apply; DEV_FUSES is the subset safe for an unpackaged dev binary.
import { FuseV1Options, FuseVersion } from '@electron/fuses';

export const DEV_FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.EnableCookieEncryption]: true,
};

export const PRODUCTION_FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};
