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

interface SessionRestore {
  at: string;
  state: string;
  count: number;
  error: string | null;
}

interface Profile {
  id: string;
  label: string;
  partition: string;
  status: string;
  statusReason: string | null;
  lastImport: ImportSummary | null;
  sessionRestore: SessionRestore | null;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string } };

interface UgcBridge {
  listProfiles(): Promise<Result<Profile[]>>;
  importCookies(profileId: string): Promise<Result<{ canceled: boolean; profile: Profile }>>;
  checkStatus(profileId: string): Promise<Result<Profile>>;
  openSite(profileId: string, page: string): Promise<Result<{ opened: boolean }>>;
  clearProfile(profileId: string): Promise<Result<Profile>>;
}

const bridge = (window as unknown as { ugc: UgcBridge }).ugc;
const container = document.getElementById('profiles') as HTMLElement;
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

function render(profiles: Profile[]): void {
  container.replaceChildren(
    ...profiles.map((profile) => {
      const card = el('section', undefined, 'profile');
      card.dataset['profileId'] = profile.id;
      card.append(el('h2', profile.label));
      const status = el('p', `Status: ${profile.status}${profile.statusReason ? ` (${profile.statusReason})` : ''}`, 'status');
      status.dataset['status'] = profile.status;
      card.append(status, el('p', `Partition: ${profile.partition}`, 'meta'));
      if (profile.lastImport) card.append(el('pre', describeImport(profile.lastImport)));
      if (profile.sessionRestore) {
        const r = profile.sessionRestore;
        const line = el('p', `Session cookies: ${r.state}, ${r.count}${r.error ? ` (${r.error})` : ''} — ${r.at}`, 'meta restore');
        line.dataset['restoreState'] = r.state;
        card.append(line);
      }

      const actions = el('div', undefined, 'actions');
      const button = (label: string, action: () => Promise<Result<unknown>>): void => {
        const b = el('button', label);
        b.addEventListener('click', () => {
          void action().then((r) => (r.ok ? refresh() : showError(r.error.code)));
        });
        actions.append(b);
      };
      button('Import Cookie-Editor JSON…', () => bridge.importCookies(profile.id));
      button('Check status', () => bridge.checkStatus(profile.id));
      button('Open site', () => bridge.openSite(profile.id, 'home'));
      button('Open strict page', () => bridge.openSite(profile.id, 'strict'));
      button('Interactive login (synthetic)', () => bridge.openSite(profile.id, 'interactive-login'));
      button('Clear', () => bridge.clearProfile(profile.id));
      card.append(actions);
      return card;
    }),
  );
}

async function refresh(): Promise<void> {
  const result = await bridge.listProfiles();
  if (!result.ok) return showError(result.error.code);
  showError(null);
  render(result.data);
}

void refresh();
