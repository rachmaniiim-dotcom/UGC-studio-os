interface ImportSummary {
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

interface SessionSync {
  revision: number;
  savedCount: number;
  savedAt: string | null;
  saveError: string | null;
  restore: { at: string; state: string; count: number; error: string | null } | null;
}

interface PlatformInfo {
  id: string;
  displayName: string;
  statusCheck: 'manual' | 'probe';
  automation: 'permitted' | 'not_permitted';
  pages: string[];
}

interface Profile {
  id: string;
  label: string;
  partition: string;
  status: string;
  statusReason: string | null;
  lastImport: ImportSummary | null;
  platformId: string;
  sessionSync: SessionSync;
  proxy: null | {
    protocol: string;
    host: string;
    port: number;
    hasCredentials: boolean;
    status: string;
    observedIp: string | null;
    endpoint: string | null;
    error: string | null;
  };
}

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string } };

interface UgcBridge {
  getPlatform(): Promise<Result<PlatformInfo | null>>;
  listProfiles(): Promise<Result<Profile[]>>;
  importCookies(profileId: string): Promise<Result<{ canceled: boolean; profile: Profile }>>;
  checkStatus(profileId: string): Promise<Result<Profile>>;
  confirmStatus(profileId: string, observation: 'logged_in' | 'logged_out'): Promise<Result<Profile>>;
  openSite(profileId: string, page: string): Promise<Result<{ opened: boolean }>>;
  clearProfile(profileId: string): Promise<Result<Profile>>;
  testProxy(profileId: string): Promise<Result<Profile>>;
}

const bridge = (window as unknown as { ugc: UgcBridge }).ugc;
const container = document.getElementById('profiles') as HTMLElement;
const platformLine = document.getElementById('platform') as HTMLElement;
const errorBox = document.getElementById('error') as HTMLElement;

function showError(code: string | null): void {
  errorBox.hidden = code === null;
  errorBox.textContent = code ? `Request failed: ${code}` : '';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function describeImport(summary: ImportSummary): string {
  const lines = [
    `Last import ${summary.at} — format: ${summary.format}${summary.fileError ? `, file error: ${summary.fileError}` : ''}`,
    `examined ${summary.examined}, imported ${summary.imported}, skipped ${summary.skipped}, rejected ${summary.rejected}`,
    `loaded into browser: ${summary.browserLoaded}`,
  ];
  const reasons = Object.entries(summary.reasons).map(([k, v]) => `${k}: ${v}`);
  if (reasons.length) lines.push(`reasons — ${reasons.join(', ')}`);
  const failures = Object.entries(summary.browserFailures).map(([k, v]) => `${k}: ${v}`);
  if (failures.length) lines.push(`browser load issues — ${failures.join(', ')}`);
  return [...lines, ...summary.messages].join('\n');
}

const PAGE_LABELS: Record<string, string> = {
  home: 'Open site',
  strict: 'Open strict page',
  'interactive-login': 'Interactive login (synthetic)',
};

function describeSync(sync: SessionSync): string {
  const saved = sync.saveError
    ? `not saved (${sync.saveError})`
    : sync.savedCount > 0
      ? `${sync.savedCount} saved, revision ${sync.revision}`
      : `none saved, revision ${sync.revision}`;
  const r = sync.restore;
  const restore = r ? ` · last restore: ${r.state}, ${r.count}${r.error ? ` (${r.error})` : ''}` : '';
  return `Session cookies: ${saved}${restore}`;
}

function render(platform: PlatformInfo, profiles: Profile[]): void {
  container.replaceChildren(
    ...profiles.map((profile) => {
      const card = el('section', undefined, 'profile');
      card.dataset['profileId'] = profile.id;
      card.append(el('h2', profile.label));
      const status = el('p', `Status: ${profile.status}${profile.statusReason ? ` (${profile.statusReason})` : ''}`, 'status');
      status.dataset['status'] = profile.status;
      card.append(status, el('p', `Partition: ${profile.partition}`, 'meta'));
      if (profile.lastImport) card.append(el('pre', describeImport(profile.lastImport)));
      const sync = el('p', describeSync(profile.sessionSync), 'meta sync');
      sync.dataset['revision'] = String(profile.sessionSync.revision);
      sync.dataset['savedCount'] = String(profile.sessionSync.savedCount);
      sync.dataset['restoreState'] = profile.sessionSync.restore?.state ?? 'none';
      card.append(sync);
      const proxy = profile.proxy;
      const proxyText = proxy
        ? `Proxy: ${proxy.protocol}://${proxy.host}:${proxy.port}${proxy.hasCredentials ? ' (credentials set)' : ''} · ${proxy.status}` +
          (proxy.observedIp ? ` · public IP ${proxy.observedIp} (${proxy.endpoint})` : '') +
          (proxy.error ? ` · ${proxy.error}` : '')
        : 'Proxy: none';
      const proxyLine = el('p', proxyText, 'meta proxy');
      proxyLine.dataset['proxyStatus'] = proxy?.status ?? 'none';
      card.append(proxyLine);

      const actions = el('div', undefined, 'actions');
      const button = (label: string, action: () => Promise<Result<unknown>>): void => {
        const b = el('button', label);
        b.addEventListener('click', () => {
          void action().then((r) => (r.ok ? refresh() : showError(r.error.code)));
        });
        actions.append(b);
      };
      button('Import Cookie-Editor JSON…', () => bridge.importCookies(profile.id));
      if (profile.proxy) button('Test proxy', () => bridge.testProxy(profile.id));
      // Automated checks only where the platform permits them; otherwise the owner says what they see.
      if (platform.statusCheck === 'probe') button('Check status', () => bridge.checkStatus(profile.id));
      button('I see I am logged in', () => bridge.confirmStatus(profile.id, 'logged_in'));
      button('I see I am logged out', () => bridge.confirmStatus(profile.id, 'logged_out'));
      for (const page of platform.pages) {
        if (page === 'rotate' || page === 'logout' || page === 'basic-auth') continue; // synthetic test endpoints, driven by tests only
        button(PAGE_LABELS[page] ?? `Open ${page}`, () => bridge.openSite(profile.id, page));
      }
      button('Clear', () => bridge.clearProfile(profile.id));
      card.append(actions);
      return card;
    }),
  );
}

async function refresh(): Promise<void> {
  const platform = await bridge.getPlatform();
  if (!platform.ok) return showError(platform.error.code);
  if (!platform.data) {
    platformLine.textContent = 'No platform configured.';
    container.replaceChildren();
    return;
  }
  const p = platform.data;
  platformLine.textContent = `Platform: ${p.displayName} — status ${p.statusCheck === 'manual' ? 'confirmed by you (no automated checks)' : 'checked automatically'}`;
  platformLine.dataset['statusCheck'] = p.statusCheck;
  const result = await bridge.listProfiles();
  if (!result.ok) return showError(result.error.code);
  showError(null);
  render(p, result.data);
}

void refresh();
