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

export type Mode = 'affiliate_ugc' | 'account_growth' | 'flow_pool';

export interface VideoSettings {
  aspectRatio: '9:16' | '16:9' | '1:1';
  durationSeconds: number;
  quality: 'fast' | 'quality';
}

export interface Thresholds {
  outlierThreshold: number;
  windowDays: number;
  recommendedBaseline: number;
  minimumBaseline: number;
  settleDays: number;
  minViews: number;
  staleDays: number;
}

export interface GrowthStrategy {
  niche: string;
  subNiches: string[];
  audience: string;
  region: string;
  language: string;
  desiredFollowers: string;
  followReasons: string[];
  styleConstraints: string;
  dailyConcepts: number;
  dailyVideos: number;
  thresholds: Thresholds;
}

export interface MetricValue {
  value: number;
  exactness: 'exact' | 'rounded';
}

export interface ScoredReference {
  id: string;
  url: string;
  platformVideoId: string;
  creatorHandle: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  metrics: { views: MetricValue | null; likes: MetricValue | null; comments: MetricValue | null; shares: MetricValue | null; observedAt: string | null };
  relevance: 'unrated' | 'relevant' | 'not_relevant';
  pinned: boolean;
  note: string;
  source: string;
  assessment: {
    verdict: 'outlier' | 'not_outlier' | 'unverified' | 'missing_metrics';
    ratio: number | null;
    ageDays: number | null;
    baseline: { level: 'recommended' | 'minimum' | 'insufficient'; sampleSize: number; medianViews: number | null };
    engagementRate: number | null;
    confidence: 'high' | 'medium' | 'low';
    flags: string[];
    reasons: string[];
    shortlisted: boolean;
  };
  explanation: string;
}

export interface GrowthView {
  strategy: GrowthStrategy;
  strategySaved: boolean;
  creators: Array<{ id: string; handle: string; note: string; videoCount: number }>;
  references: ScoredReference[];
  shortlist: string[];
  computedAt: string;
}

export interface ImportResult {
  added: number;
  updated: number;
  rejected: number;
  ignoredColumns: number;
  rows: Array<{ row: number; status: 'added' | 'updated' | 'rejected'; issues: string[] }>;
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
  promptItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VariableKind = 'text' | 'consistency' | 'choice' | 'pool';

export interface TemplateVariable {
  key: string;
  label: string;
  kind: VariableKind;
  required: boolean;
  default: string;
  options: string[];
  help: string;
}

export interface PromptTemplate {
  key: string;
  version: number;
  name: string;
  family: 'asmr' | 'grandma' | 'dance' | 'custom';
  niche: string;
  description: string;
  builtin: boolean;
  sections: Array<{ key: string; title: string; text: string }>;
  variables: TemplateVariable[];
  slots: Array<{ key: string; label: string; options: string[] }>;
  references: { requirement: 'none' | 'optional' | 'required'; kinds: Array<'image' | 'video'>; purpose: 'appearance' | 'motion' | 'style'; flowSupport: 'manual_upload' | 'unsupported'; instructions: string };
  video: VideoSettings;
  caption: { pattern: string; hashtags: string[]; maxLength: number };
}

export interface TemplateConfig {
  values: Record<string, string>;
  pools: Record<string, string[]>;
  count: number;
  video: VideoSettings;
  hashtags: string[];
  referenceAssetIds: string[];
}

export type PromptStatus = 'draft' | 'approved' | 'rejected' | 'queued' | 'generating' | 'video_ready';
export type PromptActionName = 'approve' | 'reject' | 'reopen' | 'queue' | 'unqueue' | 'start_manual' | 'back_to_queue';

export interface PromptItem {
  id: string;
  batchId: string;
  position: number;
  status: PromptStatus;
  axes: Record<string, string>;
  content: { sections: Array<{ key: string; title: string; text: string }>; caption: string };
  rendered: string;
  edited: boolean;
  flags: string[];
  duplicates: number[];
  manualSteps: string[];
  references: Array<{ id: string; name: string; kind: 'image' | 'video'; available: boolean }>;
  handoff: 'provider' | 'manual' | null;
  flowBundleId: string | null;
  jobId: string | null;
  lastError: string | null;
  video: { jobId: string; file: string } | null;
  post: { id: string; postedAt: string; postUrl: string | null } | null;
  updatedAt: string;
}

export type ShowcaseState = 'not_requested' | 'in_progress' | 'added_seen_by_you' | 'added_confirmed_by_tiktok' | 'not_eligible' | 'failed' | 'removed';

export interface ProductFacts {
  title: string;
  shopName: string;
  priceIdr: number | null;
  commissionPct: number | null;
  features: string[];
  references: string[];
  notes: string;
}

export interface AffiliateProduct {
  id: string;
  productId: string;
  productUrl: string;
  source: 'link' | 'research_address';
  facts: ProductFacts;
  summary: string;
  selectedToday: boolean;
  listing: 'unverified' | 'confirmed' | 'mismatch';
  eligibility: 'unknown' | 'can_promote' | 'cannot_promote';
  showcase: ShowcaseState;
  showcaseMethod: 'assisted' | 'api' | null;
  showcaseChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AffiliateView {
  products: AffiliateProduct[];
  today: string;
  dailyLimit: number;
  selectedToday: number;
}

export interface PoolAccount {
  id: string;
  displayName: string;
  settings: { monthlyCredits: number; resetDay: number; creditsPerDownload: number };
  periodStart: string;
  used: number;
  remaining: number;
  downloadsThisPeriod: number;
  proxyConfigured: boolean;
  flowSessionId: string | null;
}

export interface BoardRow {
  bundleId: string;
  displayName: string;
  target: number;
  videosToday: number;
  postedToday: number;
  readyToPost: number;
  queued: number;
  generating: number;
  approved: number;
  drafts: number;
}

export interface PromptBatch {
  id: string;
  templateKey: string;
  templateVersion: number;
  templateName: string;
  providerId: string;
  requested: number;
  shortfall: string | null;
  createdAt: string;
  items: PromptItem[];
}

export interface ReferenceAsset {
  id: string;
  name: string;
  kind: 'image' | 'video';
  bytes: number;
  file: string;
  createdAt: string;
}

export interface StudioView {
  templates: Array<{ template: PromptTemplate; versions: number }>;
  configs: Record<string, { config: TemplateConfig; saved: boolean }>;
  batches: PromptBatch[];
  counts: Record<PromptStatus, number>;
  references: ReferenceAsset[];
  presets: Array<{ id: string; kind: 'character' | 'world' | 'style'; name: string; text: string }>;
  conceptProvider: { id: string; displayName: string; kind: string; remote: boolean };
  videoProvider: { available: boolean; label: string | null; reason: string | null };
  unlinkedVideos: Array<{ jobId: string; source: string; createdAt: string; bytes: number | null }>;
  readyToPost: PromptItem[];
  posted: PromptItem[];
  dailyTarget: number;
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
  growthView(bundleId: string): Promise<Result<GrowthView>>;
  saveGrowthStrategy(bundleId: string, strategy: GrowthStrategy): Promise<Result<GrowthView>>;
  addReferenceCreator(bundleId: string, handle: string, note: string): Promise<Result<GrowthView>>;
  removeReferenceCreator(bundleId: string, creatorId: string): Promise<Result<GrowthView>>;
  addReference(bundleId: string, reference: Record<string, unknown>): Promise<Result<{ outcome: 'added' | 'updated'; view: GrowthView }>>;
  updateReference(bundleId: string, referenceId: string, patch: Record<string, unknown>): Promise<Result<GrowthView>>;
  removeReference(bundleId: string, referenceId: string): Promise<Result<GrowthView>>;
  importReferencesCsvText(bundleId: string, text: string): Promise<Result<{ result: ImportResult; view: GrowthView }>>;
  importReferencesCsvFile(bundleId: string): Promise<Result<{ canceled: boolean; result?: ImportResult; view?: GrowthView }>>;
  studioView(bundleId: string): Promise<Result<StudioView>>;
  saveTemplate(bundleId: string, template: Partial<PromptTemplate>, baseKey: string | null): Promise<Result<{ key: string; view: StudioView }>>;
  duplicateTemplate(bundleId: string, templateKey: string): Promise<Result<{ key: string; view: StudioView }>>;
  saveTemplateConfig(bundleId: string, templateKey: string, config: TemplateConfig): Promise<Result<StudioView>>;
  generatePrompts(bundleId: string, templateKey: string): Promise<Result<{ batchId: string; view: StudioView }>>;
  updatePrompt(bundleId: string, itemId: string, content: PromptItem['content']): Promise<Result<StudioView>>;
  promptAction(bundleId: string, itemId: string, action: PromptActionName): Promise<Result<StudioView>>;
  regeneratePrompt(bundleId: string, itemId: string): Promise<Result<StudioView>>;
  copyPrompt(bundleId: string, itemId: string): Promise<Result<{ copied: boolean }>>;
  generateVideoFromPrompt(bundleId: string, itemId: string): Promise<Result<StudioView>>;
  linkPromptVideo(bundleId: string, itemId: string, jobId: string): Promise<Result<StudioView>>;
  addReferenceAsset(bundleId: string, rightsConfirmed: boolean): Promise<Result<{ canceled: boolean; assetId?: string; view?: StudioView }>>;
  removeReferenceAsset(bundleId: string, assetId: string): Promise<Result<StudioView>>;
  revealReferenceAsset(bundleId: string, assetId: string): Promise<Result<{ shown: boolean }>>;
  savePreset(bundleId: string, kind: string, name: string, text: string): Promise<Result<StudioView>>;
  deletePreset(bundleId: string, presetId: string): Promise<Result<StudioView>>;
  copyCaption(bundleId: string, itemId: string): Promise<Result<{ copied: boolean }>>;
  markPosted(bundleId: string, itemId: string, postUrl: string | null): Promise<Result<StudioView>>;
  undoPosted(bundleId: string, itemId: string): Promise<Result<StudioView>>;
  productionBoard(): Promise<Result<BoardRow[]>>;
  setDailyTarget(bundleId: string, target: number): Promise<Result<BoardRow[]>>;
  flowPool(): Promise<Result<PoolAccount[]>>;
  savePoolSettings(bundleId: string, settings: PoolAccount['settings']): Promise<Result<PoolAccount[]>>;
  setPoolRemaining(bundleId: string, remaining: number): Promise<Result<PoolAccount[]>>;
  takePromptToPool(bundleId: string, itemId: string, poolId: string | null): Promise<Result<{ poolId: string; view: StudioView }>>;
  affiliateView(bundleId: string): Promise<Result<AffiliateView>>;
  addAffiliateProducts(bundleId: string, text: string): Promise<Result<{ result: { added: string[]; existing: string[]; rejected: Array<{ line: number; input: string; issue: string }> }; view: AffiliateView }>>;
  captureProductFromResearch(bundleId: string): Promise<Result<{ productId: string; outcome: 'added' | 'existing'; view: AffiliateView }>>;
  removeAffiliateProduct(bundleId: string, id: string): Promise<Result<AffiliateView>>;
  selectAffiliateProduct(bundleId: string, id: string, selected: boolean): Promise<Result<AffiliateView>>;
  setDailyProducts(bundleId: string, limit: number): Promise<Result<AffiliateView>>;
  updateProductFacts(bundleId: string, id: string, facts: Record<string, unknown>): Promise<Result<AffiliateView>>;
  setProductListing(bundleId: string, id: string, state: AffiliateProduct['listing']): Promise<Result<AffiliateView>>;
  setProductEligibility(bundleId: string, id: string, state: AffiliateProduct['eligibility']): Promise<Result<AffiliateView>>;
  openProductPage(bundleId: string, id: string): Promise<Result<{ opened: boolean }>>;
  openShowcasePage(bundleId: string, id: string): Promise<Result<AffiliateView>>;
  showcaseAction(bundleId: string, id: string, action: 'confirm_seen' | 'not_eligible' | 'failed' | 'removed' | 'reset'): Promise<Result<AffiliateView>>;
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
  flow_pool: 'Flow pool (Google Flow credits only)',
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
  invalid_strategy: ['Some strategy fields are invalid.', 'Fix the fields marked below.'],
  invalid_reference: ['This reference can’t be saved.', 'Fix the fields marked below.'],
  invalid_creator: ['That isn’t a valid TikTok handle or profile link.', 'Use @handle or https://www.tiktok.com/@handle.'],
  unknown_reference: ['That reference no longer exists.', 'Refresh the screen.'],
  invalid_csv: ['The CSV couldn’t be read.', 'Check it has a header row with at least a "url" column (see the template).'],
  source_not_authorized: ['This research source isn’t authorized for automated retrieval.', 'Only sources with a recorded authorization can run.'],
  unknown_template: ['That template no longer exists.', 'Choose another template.'],
  invalid_template: ['The template can’t be saved.', 'Fix the problems listed below.'],
  builtin_read_only: ['Starter templates can’t be changed.', 'Press Duplicate to make your own editable copy.'],
  invalid_template_config: ['Some settings are invalid.', 'Fix the problems listed below.'],
  unknown_prompt: ['That prompt no longer exists.', 'Refresh the screen.'],
  invalid_prompt_edit: ['The edited prompt can’t be saved.', 'Every section needs text (max 4,000 characters each).'],
  prompt_action_not_allowed: ['That step isn’t possible for this prompt’s current status.', 'Refresh and check its status.'],
  prompt_blocked: ['This prompt can’t be approved yet.', 'Edit it to fix the problems listed below.'],
  concept_provider_failed: ['The prompt generator didn’t return usable prompts.', 'Try again; nothing was saved.'],
  unsafe_payload: ['The request would have included account details, so it wasn’t sent.', 'Remove account names or proxy details from the template settings.'],
  unknown_reference_asset: ['That reference file no longer exists.', 'Refresh the screen.'],
  invalid_reference_file: ['That file can’t be used as a reference.', 'Use a JPG, PNG, WEBP, MP4 or MOV file under 200 MB.'],
  rights_not_confirmed: ['Confirm that you own the file or have rights to use it.', 'Tick the confirmation box first.'],
  invalid_preset: ['The preset can’t be saved.', 'Give it a name and a description (max 2,000 characters).'],
  invalid_post_link: ['That isn’t a TikTok video link.', 'Paste the full link of your post (https://www.tiktok.com/@you/video/…) or leave it empty.'],
  invalid_target: ['The daily target must be a whole number from 1 to 50.', 'Enter a number and save again.'],
  not_pool_account: ['That isn’t a Flow pool account.', 'Choose an account created as “Flow pool”.'],
  invalid_pool_settings: ['Some credit settings are invalid.', 'Fix the fields listed below.'],
  invalid_credit_balance: ['That balance isn’t valid.', 'Enter the remaining credits Google Flow shows (a whole number).'],
  no_pool_account_available: ['No Flow pool account can take this prompt.', 'Add a Flow pool account with a proxy and a Google Flow session, or check its remaining credits.'],
  not_affiliate_account: ['Affiliate Products is only for Affiliate UGC accounts.', 'Open it from an affiliate account.'],
  unknown_product: ['That product no longer exists.', 'Refresh the screen.'],
  invalid_product_list: ['Nothing to add.', 'Paste 1–200 TikTok product links or IDs, one per line.'],
  invalid_facts: ['Some product details are invalid.', 'Fix the fields listed below.'],
  invalid_daily_products: ['The daily product limit must be 1–20.', 'Enter a whole number.'],
  daily_selection_full: ['Today’s selection is full.', 'Remove a product from today or raise the daily limit.'],
  listing_not_confirmed: ['Confirm the listing first.', 'Open the product in this account’s TikTok window and press “This is the exact listing”.'],
  showcase_action_not_allowed: ['That step isn’t possible in the product’s current Showcase state.', 'Refresh and check its state.'],
  no_product_in_address: ['No TikTok product ID was found in the Kalodata window’s address.', 'Copy the product’s TikTok link and paste it under “Add products”.'],
  no_research_window: ['This account’s Kalodata window isn’t open.', 'Press “Open Kalodata”, open a product there, then try again.'],
  session_not_configured: ['This account has no session for that platform.', 'Set it up in the account editor.'],
  unknown_video: ['That video can’t be linked.', 'Choose a finished video of this account that isn’t linked to another prompt.'],
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
  invalid_niche: 'Enter the account’s niche.',
  invalid_text: 'One of the text fields is too long or has invalid characters.',
  invalid_list: 'Lists (sub-niches, follow reasons) take up to 20 short items.',
  invalid_daily_targets: 'Daily targets must be whole numbers (concepts 0–50, videos 0–20).',
  invalid_outlier_threshold: 'Outlier threshold must be between 1.5× and 100×.',
  invalid_window: 'Research window must be 7–365 days.',
  invalid_baseline: 'Baselines must be 3–100 videos, and the minimum can’t exceed the recommended.',
  invalid_settle_days: 'Settle age must be 0–30 days.',
  invalid_min_views: 'Minimum views must be a whole number.',
  invalid_stale_days: 'Stale after must be 1–90 days.',
  invalid_url: 'Use the full video link: https://www.tiktok.com/@handle/video/1234…',
  short_link_unsupported: 'Short links (vm.tiktok.com, /t/…) can’t be used. Open the video and copy the full link from the address bar.',
  creator_mismatch: 'The creator doesn’t match the handle in the link.',
  invalid_published_at: 'Publication date must be YYYY-MM-DD.',
  published_in_future: 'Publication date is in the future.',
  invalid_video_duration: 'Duration must be 1–3600 seconds.',
  invalid_views: 'Views: a number like 125000, 125.000 or 1.2M.',
  invalid_likes: 'Likes: a number like 4300 or 4.3K.',
  invalid_comments: 'Comments: a number like 210.',
  invalid_shares: 'Shares: a number like 95.',
  invalid_observed_at: 'Observed date must be YYYY-MM-DD.',
  invalid_relevance: 'Relevance must be unrated, relevant or not_relevant.',
  invalid_note: 'The note is too long (max 1000 characters).',
  empty: 'The CSV is empty.',
  missing_url_column: 'The header row needs a "url" column.',
  too_many_rows: 'Import at most 2000 rows at a time.',
  malformed: 'The CSV has an unclosed quote.',
  too_large: 'The file is larger than 2 MB.',
  invalid_mode: 'Choose a production mode.',
  invalid_template_key: 'The template id is invalid.',
  invalid_template_name: 'Give the template a name (max 80 characters).',
  invalid_template_text: 'Niche is required; the description can be up to 500 characters.',
  invalid_sections: 'Add at least one section; each needs a key, a title and text (max 4,000 characters).',
  invalid_variables: 'Each variable needs a key (lowercase letters, digits, _), a label and a kind.',
  duplicate_key: 'Two sections, variables or slots use the same key.',
  invalid_options: 'Lists need at least one option, and a choice’s default must be one of its options.',
  unknown_placeholder: 'A {{placeholder}} in the text or caption doesn’t match any variable or slot.',
  no_variation: 'Add at least one varying list (kind "pool") so prompts can differ.',
  invalid_reference_spec: 'The reference settings are incomplete.',
  invalid_caption: 'Caption: a pattern, hashtags starting with # and a max length of 20–2,200.',
  invalid_video: 'Video settings are invalid.',
  missing_required_value: 'A required field is empty.',
  value_too_long: 'A value is too long.',
  invalid_choice: 'Pick one of the listed options.',
  pool_empty: 'Every varying list needs at least one option.',
  invalid_count: 'Number of prompts must be 1–20.',
  invalid_hashtags: 'Hashtags start with # and contain no spaces.',
  invalid_reference_assets: 'One of the selected reference files no longer exists.',
  reference_kind_not_allowed: 'This template doesn’t take that kind of reference file.',
  unresolved_placeholder: 'A {{placeholder}} is left in the text.',
  too_long: 'The prompt is longer than 4,000 characters.',
  consistency_missing: 'The character, world or style description was changed or removed; it must appear exactly as configured.',
  reference_missing: 'This template needs a reference file.',
  unsupported_type: 'Use a JPG, PNG, WEBP, MP4 or MOV file.',
  unreadable: 'The file couldn’t be read.',
  content_mismatch: 'The file’s content doesn’t match its extension.',
  reference_too_large: 'Reference files can be up to 200 MB.',
  invalid_title: 'Title: up to 200 characters.',
  invalid_monthly_credits: 'Monthly credits: a whole number, e.g. 1050 for Google AI Pro.',
  invalid_reset_day: 'Reset day: 1–28 (the day of the month your credits renew).',
  invalid_credits_per_download: 'Credits per video: a whole number, e.g. 12 for an 8-second Omni Flash clip.',
  mode_change_not_allowed: 'A Flow pool account can’t be switched to a factory mode (or back): create a new account instead.',
  invalid_shop: 'Shop name: up to 100 characters.',
  invalid_price: 'Price: a whole number of rupiah, e.g. 89000 or 89.000.',
  invalid_commission: 'Commission: a percentage from 0 to 80, e.g. 12 or 12,5.',
  invalid_features: 'Features: up to 20 lines, 200 characters each.',
  invalid_references: 'References: up to 10 full TikTok video links (https://www.tiktok.com/@creator/video/…).',
  invalid_notes: 'Notes: up to 1,000 characters.',
  invalid_product_ref: 'not a TikTok product link or ID',
  not_a_product_link: 'not a TikTok product page link (…/view/product/<id>)',
  invalid_output: 'The generator returned malformed prompts.',
  unavailable: 'The generator is unavailable.',
  refused: 'The generator refused the request.',
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
