export * from './cookies/types.js';
export { detectFormat, type Detection } from './cookies/detect.js';
export { importCookieEditorExport, cookieIdentity, isDomainInScope, oversizedFileResult, DEFAULT_MAX_BYTES, DEFAULT_MAX_COOKIES } from './cookies/import.js';
export { SecretValue, REDACTED } from './redaction/secret.js';
export { redactText, redactValue } from './redaction/redact.js';
export { createLogger, type Logger, type LogLevel } from './redaction/logger.js';
export { SESSION_STATUSES, isSessionStatus, type SessionStatus } from './session/status.js';
export {
  RESTORE_PAYLOAD_VERSION,
  REVISION_RECORD_VERSION,
  encodeSessionRestore,
  decodeSessionRestore,
  encodeRevisionRecord,
  decodeRevisionRecord,
  restorableSessionCookies,
  type RestoreBinding,
  type RestoreDecodeError,
  type RestoreDecodeResult,
  type RevisionDecodeResult,
} from './session/restore-payload.js';
export {
  hostInDomains,
  urlInDomains,
  validatePlatformDefinition,
  type AuthorizationConstraints,
  type DefinitionIssue,
  type PlatformDefinition,
  type StatusCheck,
} from './platforms/definition.js';
export {
  assertResearchUse,
  ResearchUseNotAuthorized,
  type ResearchProvider,
  type ResearchProviderDescriptor,
  type ResearchQuery,
  type ResearchUse,
} from './research/provider.js';
