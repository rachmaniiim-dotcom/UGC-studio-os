/**
 * A platform definition says which cookies belong to a platform account and
 * where that account's isolated browser may go. Definitions are reviewed
 * source data, validated at startup; there is deliberately no user-editable
 * definition file, because widening a domain list widens where real cookies
 * can be loaded and sent.
 */

/** How the app may learn whether a session is logged in. */
export type StatusCheck =
  /** The owner looks at the site and says so. The app sends nothing. */
  | { readonly kind: 'manual' }
  /** The app requests `path` on `origin` with the profile's cookies. Requires automation: 'permitted'. */
  | { readonly kind: 'probe'; readonly path: string };

export interface AuthorizationConstraints {
  /** Whether the app may send any request to the platform on its own (probes, keep-alives, extraction). */
  readonly automation: 'permitted' | 'not_permitted';
  /** Whether platform data may be sent to AI/ML services. */
  readonly aiDataUse: 'permitted' | 'not_permitted';
  /** Why: terms clause, written permission reference, or "synthetic test site". */
  readonly basis: string;
}

export interface PlatformDefinition {
  readonly id: string;
  readonly displayName: string;
  /**
   * Registrable domains whose cookies make up one account's session. A
   * platform may need several (e.g. a separate login domain); cookies outside
   * them are rejected at import and never restored.
   */
  readonly cookieDomains: readonly string[];
  /** Hosts the profile's windows may navigate to. Must cover every cookie domain. */
  readonly navigationDomains: readonly string[];
  /** Pages the owner can open, by name. Absolute https URLs inside navigationDomains. */
  readonly pages: Readonly<Record<string, string>>;
  readonly statusCheck: StatusCheck;
  readonly authorization: AuthorizationConstraints;
  /** One profile holds exactly one account of this platform. */
  readonly accountBoundary: 'one_account_per_profile';
}

export type DefinitionIssue =
  | 'invalid_id'
  | 'invalid_display_name'
  | 'invalid_domain'
  | 'no_cookie_domains'
  | 'cookie_domain_not_navigable'
  | 'invalid_page'
  | 'no_pages'
  | 'probe_without_automation_permission'
  | 'invalid_probe_path'
  | 'invalid_authorization'
  | 'invalid_account_boundary';

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const DOMAIN_LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
// At least two labels: a bare TLD ("com", "test") can never be a cookie or navigation scope.
const DOMAIN = new RegExp(`^${DOMAIN_LABEL}(\\.${DOMAIN_LABEL})+$`);
const PAGE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PROBE_PATH = /^\/[A-Za-z0-9/_-]{0,128}$/;

/** True if `host` equals or is a subdomain of one of `domains`. */
export function hostInDomains(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** True for an https URL (any port) whose host is inside `domains`. */
export function urlInDomains(raw: string, domains: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && hostInDomains(url.hostname, domains);
  } catch {
    return false;
  }
}

/** Returns every problem with `def`; an empty list means it is valid. */
export function validatePlatformDefinition(def: PlatformDefinition): DefinitionIssue[] {
  const issues = new Set<DefinitionIssue>();
  if (!ID.test(def.id)) issues.add('invalid_id');
  if (typeof def.displayName !== 'string' || def.displayName.trim().length === 0 || def.displayName.length > 64) {
    issues.add('invalid_display_name');
  }
  const domainsOk = (list: readonly string[]): boolean => Array.isArray(list) && list.every((d) => typeof d === 'string' && DOMAIN.test(d));
  if (!domainsOk(def.cookieDomains) || !domainsOk(def.navigationDomains)) issues.add('invalid_domain');
  if (!Array.isArray(def.cookieDomains) || def.cookieDomains.length === 0) issues.add('no_cookie_domains');
  else if (Array.isArray(def.navigationDomains) && !def.cookieDomains.every((d) => hostInDomains(d, def.navigationDomains))) {
    issues.add('cookie_domain_not_navigable');
  }

  const pages = Object.entries(def.pages ?? {});
  if (pages.length === 0) issues.add('no_pages');
  for (const [name, url] of pages) {
    if (!PAGE_NAME.test(name) || typeof url !== 'string' || !urlInDomains(url, def.navigationDomains ?? [])) issues.add('invalid_page');
  }

  const auth = def.authorization;
  const levels = ['permitted', 'not_permitted'];
  if (!auth || !levels.includes(auth.automation) || !levels.includes(auth.aiDataUse) || typeof auth.basis !== 'string' || auth.basis.trim() === '') {
    issues.add('invalid_authorization');
  }
  if (def.statusCheck?.kind === 'probe') {
    if (auth?.automation !== 'permitted') issues.add('probe_without_automation_permission');
    if (!PROBE_PATH.test(def.statusCheck.path)) issues.add('invalid_probe_path');
  } else if (def.statusCheck?.kind !== 'manual') {
    issues.add('invalid_probe_path');
  }
  if (def.accountBoundary !== 'one_account_per_profile') issues.add('invalid_account_boundary');
  return [...issues];
}
