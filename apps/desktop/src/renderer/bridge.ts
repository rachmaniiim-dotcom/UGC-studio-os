// Typed access to the preload bridge, and plain-language error messages.
// Nothing here stores secrets: pasted JSON and proxy passwords are passed
// straight to the bridge and never kept in state, storage or logs.

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: string[] } };

export interface ImportSummary {
  at: string;
  format: string;
  fileError: string | null;
  examined: number;
  imported: number;
  skipped: number;
  rejected: number;
  reasons: Record<string, number>;
  messages: string[];
  browserLoaded: number;
  browserFailures: Record<string, number>;
}

export interface SessionSync {
  revision: number;
  savedCount: number;
  savedAt: string | null;
  saveError: string | null;
  restore: { at: string; state: string; count: number; error: string | null } | null;
}

export interface PlatformInfo {
  id: string;
  displayName: string;
  statusCheck: 'manual' | 'probe';
  automation: 'permitted' | 'not_permitted';
  pages: string[];
}

export interface Session {
  id: string;
  label: string;
  platformId: string;
  bundleId: string | null;
  optional: boolean;
  partition: string;
  status: string;
  statusReason: string | null;
  lastImport: ImportSummary | null;
  sessionSync: SessionSync;
}

export type AccountSession = Session & { platform: PlatformInfo };

export interface ProxyState {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  hasCredentials: boolean;
  status: 'untested' | 'ok' | 'failed';
  observedIp: string | null;
  endpoint: 'primary' | 'backup' | null;
  testedAt: string | null;
  lastPassedAt: string | null;
  error: string | null;
}

export type Mode = 'affiliate_ugc' | 'account_growth';

export interface VideoSettings {
  aspectRatio: '9:16' | '16:9' | '1:1';
  durationSeconds: number;
  quality: 'fast' | 'quality';
}

export interface GenerationJob {
  id: string;
  bundleId: string;
  source: 'provider' | 'manual_download';
  providerId: string;
  state: 'pending' | 'running' | 'completed' | 'waiting_for_user' | 'failed';
  settings: VideoSettings | null;
  progress: number | null;
  errorCode: string | null;
  needsUser: boolean;
  videoFile: string | null;
  videoBytes: number | null;
  videoSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  displayName: string;
  mode: Mode;
  status: 'draft' | 'proxy_check_needed' | 'operational' | 'attention';
  proxy: ProxyState | null;
  sessions: AccountSession[];
  creative: { prompt: string; settings: VideoSettings } | null;
  generation: {
    provider: { id: string; displayName: string; kind: string } | null;
    unavailableReason: string | null;
    dailyCap: number;
    usedToday: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProxyForm {
  protocol: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

interface UgcBridge {
  listAccounts(): Promise<Result<Account[]>>;
  createAccount(displayName: string, mode: Mode): Promise<Result<Account>>;
  updateAccount(bundleId: string, displayName: string, mode: Mode): Promise<Result<Account>>;
  setAccountProxy(bundleId: string, proxy: Partial<ProxyForm>, keepCredentials: boolean): Promise<Result<Account>>;
  testAccountProxy(bundleId: string): Promise<Result<Account>>;
  importSessionText(profileId: string, text: string): Promise<Result<AccountSession>>;
  saveCreative(bundleId: string, prompt: string, settings: VideoSettings): Promise<Result<Account>>;
  startGeneration(bundleId: string): Promise<Result<GenerationJob>>;
  listGenerations(bundleId: string): Promise<Result<GenerationJob[]>>;
  revealVideo(jobId: string): Promise<Result<{ shown: boolean }>>;
  getPlatform(): Promise<Result<PlatformInfo | null>>;
  listProfiles(): Promise<Result<Session[]>>;
  importCookies(profileId: string): Promise<Result<{ canceled: boolean; profile: Session }>>;
  checkStatus(profileId: string): Promise<Result<Session>>;
  confirmStatus(profileId: string, observation: 'logged_in' | 'logged_out'): Promise<Result<Session>>;
  openSite(profileId: string, page: string): Promise<Result<{ opened: boolean }>>;
  clearProfile(profileId: string): Promise<Result<Session>>;
}

export const bridge = (window as unknown as { ugc: UgcBridge }).ugc;

export const MODE_LABELS: Record<Mode, string> = {
  affiliate_ugc: 'Affiliate UGC',
  account_growth: 'Account Growth (Ternak Akun)',
};

export const ACCOUNT_STATUS: Record<Account['status'], { label: string; tone: 'muted' | 'warn' | 'ok' | 'bad' }> = {
  draft: { label: 'Draft: proxy not validated', tone: 'muted' },
  proxy_check_needed: { label: 'Proxy check needed', tone: 'warn' },
  operational: { label: 'Operational', tone: 'ok' },
  attention: { label: 'Needs attention', tone: 'bad' },
};

export const SESSION_STATUS: Record<string, { label: string; tone: 'muted' | 'warn' | 'ok' | 'bad' }> = {
  never_configured: { label: 'Not set up', tone: 'muted' },
  imported_unverified: { label: 'Imported, not yet confirmed', tone: 'warn' },
  confirmed_by_user: { label: 'Confirmed logged in', tone: 'ok' },
  appears_authenticated: { label: 'Appears logged in', tone: 'ok' },
  expired: { label: 'Expired', tone: 'bad' },
  rejected: { label: 'Rejected by the site', tone: 'bad' },
  locked_unavailable: { label: "Can't be restored", tone: 'bad' },
  network_error: { label: 'Network error', tone: 'bad' },
  waiting_for_user: { label: 'Waiting for you', tone: 'warn' },
};

/** Plain-language message and recovery action for an error code. Never includes input values. */
const MESSAGES: Record<string, [message: string, recovery: string]> = {
  proxy_not_configured: ['This account has no proxy yet, so no website can be opened.', 'Add the dedicated proxy in step 2, then press Test proxy.'],
  proxy_not_ready: ['The proxy has not passed its test, so browsing is blocked. The app never falls back to a direct connection.', 'Check the proxy settings and press Test proxy.'],
  proxy_unreachable: ["Couldn't connect to the proxy.", 'Check the host and port, and that the proxy is online.'],
  proxy_auth_failed: ['The proxy rejected the username or password.', 'Re-enter the credentials, save the proxy and test again.'],
  proxy_tunnel_failed: ['The proxy refused to connect to the test address.', "Check the proxy plan allows HTTPS, or ask the provider."],
  proxy_tls_failed: ["The HTTPS proxy's certificate isn't trusted.", 'Check the protocol (HTTP vs HTTPS) with your provider.'],
  proxy_bypassed: ['The test connection did not go through the proxy.', 'Save the proxy again and re-test. Report this if it persists.'],
  timeout: ['The proxy test timed out.', 'Try again; if it repeats, check the proxy.'],
  endpoint_http_error: ['The IP-check service answered with an error.', 'Try again later.'],
  endpoint_bad_response: ['The IP-check service gave an unexpected answer.', 'Try again later.'],
  endpoint_tls_failed: ['A secure connection to the IP-check service failed through this proxy.', 'The proxy may be intercepting HTTPS; ask the provider.'],
  network_error: ['A network error occurred.', 'Check the connection and try again.'],
  no_endpoint: ['No IP-check service is configured.', 'Report this.'],
  credentials_missing: ['There is no saved password to keep.', 'Enter the proxy password.'],
  invalid_proxy: ['Some proxy settings are invalid.', 'Fix the fields marked below.'],
  invalid_account: ['Some account details are invalid.', 'Fix the fields marked below.'],
  cookie_encryption_disabled: ['Cookie encryption is off in this build, so imports are refused.', 'Run the app through the provided launcher.'],
  protected_key_not_ready: ['Secure storage is still being prepared on this first start.', 'Wait 15 seconds and try again.'],
  protected_storage_unavailable: ["Windows secure storage isn't available, so secrets can't be saved.", 'Make sure you are signed in to Windows normally and restart the app.'],
  file_unreadable: ["The file couldn't be read.", 'Check the file and try again.'],
  invalid_request: ['The input is empty, too large (max 2 MB) or malformed.', 'Paste the Cookie-Editor JSON export again.'],
  automated_check_not_permitted: ['Automated status checks are not permitted for this platform.', 'Open the browser and confirm what you see.'],
  platform_not_active: ['This session is not available in this mode.', 'Restart the app.'],
  unknown_account: ['This account no longer exists.', 'Go back to the account list.'],
  unknown_profile: ['This session no longer exists.', 'Go back to the account list.'],
  invalid_creative: ['Some video settings are invalid.', 'Fix the fields marked below.'],
  not_growth_account: ['Video generation is only available for Account Growth accounts in this milestone.', 'Switch the mode in step 1 if this is a growth account.'],
  no_creative_settings: ['There is no saved prompt yet.', 'Write the prompt and press Save video settings.'],
  no_provider: ['Automated generation is not enabled yet.', 'Generate in the Google Flow window and download the video; it is saved to this account’s library.'],
  job_in_progress: ['A video is already being generated for this account.', 'Wait for it to finish.'],
  daily_cap_reached: ['The daily limit for this account is reached.', 'Try again tomorrow.'],
  unknown_job: ['That video is no longer available.', 'Refresh the list.'],
  untrusted_sender: ['The request was refused.', 'Restart the app.'],
  internal_error: ['Something went wrong.', 'Try again; if it repeats, restart the app.'],
};

const FIELD_MESSAGES: Record<string, string> = {
  invalid_protocol: 'Choose HTTP, HTTPS or SOCKS5.',
  invalid_host: 'Enter a host name or IP address only (no http://, no user:password@).',
  invalid_port: 'Enter a port between 1 and 65535.',
  credentials_incomplete: 'Enter both username and password, or neither.',
  invalid_username: 'The username contains characters that are not allowed (such as ":").',
  invalid_password: 'The password contains characters that are not allowed.',
  socks5_auth_unsupported: 'SOCKS5 with a username and password is not supported. Use your provider’s HTTP or HTTPS endpoint.',
  invalid_display_name: 'Enter a name of 1–64 characters.',
  invalid_prompt: 'Enter a prompt (up to 4,000 characters).',
  invalid_aspect_ratio: 'Choose an aspect ratio.',
  invalid_duration: 'Choose a duration between 2 and 30 seconds.',
  invalid_quality: 'Choose a quality.',
  invalid_mode: 'Choose a production mode.',
};

export function describeError(code: string): { message: string; recovery: string } {
  const [message, recovery] = MESSAGES[code] ?? ['Something went wrong.', 'Try again.'];
  return { message, recovery };
}

export const describeField = (code: string): string => FIELD_MESSAGES[code] ?? code;

const IMPORT_FILE_ERRORS: Record<string, string> = {
  invalid_json: "This isn't valid JSON. Copy the whole export from Cookie-Editor (Export → JSON) and paste it again.",
  unsupported_format: 'This format is not supported. In Cookie-Editor choose Export → JSON (not Netscape or Header String).',
  empty: 'The export is empty.',
  not_utf8: 'The file is not UTF-8 text.',
  file_too_large: 'The export is larger than 2 MB.',
  too_many_cookies: 'The export has too many cookies.',
};

/** One-line, non-secret description of an import result. */
export function describeImport(s: ImportSummary): { tone: 'ok' | 'bad' | 'warn'; text: string } {
  if (s.fileError) return { tone: 'bad', text: IMPORT_FILE_ERRORS[s.fileError] ?? 'The export could not be read.' };
  const outOfScope = s.reasons['domain_out_of_scope'] ?? 0;
  const parts = [`${s.imported} of ${s.examined} cookies imported, ${s.browserLoaded} loaded`];
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.rejected) parts.push(`${s.rejected} rejected`);
  if (outOfScope) parts.push(`${outOfScope} belong to another website. Export from this platform's tab`);
  return { tone: s.browserLoaded > 0 ? (s.rejected ? 'warn' : 'ok') : 'bad', text: parts.join(' · ') };
}

/** What a job's outcome means for the owner. Codes only; never provider text. */
const JOB_OUTCOMES: Record<string, string> = {
  challenge_required: 'A verification or "unusual activity" check appeared. Nothing was bypassed: complete it yourself in the Google Flow window.',
  auth_required: 'Not signed in. Open the Google Flow browser, sign in, then try again.',
  quota_exhausted: 'Out of credits or daily limit for now.',
  rate_limited: 'The provider asked to slow down. Try again later.',
  policy_rejected: 'The prompt or video was refused under the provider’s content rules. Change the prompt.',
  interface_changed: 'The provider’s page changed and the integration needs an update.',
  transient: 'The task stopped (timeout, interruption or temporary error). It was not retried automatically.',
  output_invalid: 'The result was not a valid MP4 and was not saved.',
  cancelled: 'Cancelled.',
};

export const describeJobOutcome = (code: string | null): string => (code ? (JOB_OUTCOMES[code] ?? 'The task stopped.') : '');
