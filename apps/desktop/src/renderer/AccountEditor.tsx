import { useRef, useState } from 'react';
import {
  ACCOUNT_STATUS,
  MODE_LABELS,
  SESSION_STATUS,
  bridge,
  describeError,
  describeField,
  describeImport,
  type Account,
  type AccountSession,
  type Mode,
  type Result,
} from './bridge.js';
import { Badge } from './Badge.js';

type Notice = { tone: 'ok' | 'bad' | 'warn'; text: string; recovery?: string; fields?: string[] } | null;

function noticeFromError(error: { code: string; details?: string[] }): Notice {
  const d = describeError(error.code);
  return { tone: 'bad', text: d.message, recovery: d.recovery, fields: error.details ?? [] };
}

function NoticeLine(props: { notice: Notice; testId: string }): React.JSX.Element | null {
  const n = props.notice;
  if (!n) return null;
  return (
    <div className={`notice ${n.tone}`} role={n.tone === 'bad' ? 'alert' : 'status'} data-testid={props.testId}>
      <span>{n.text}</span>
      {n.recovery && <span className="recovery"> {n.recovery}</span>}
      {n.fields && n.fields.length > 0 && (
        <ul>
          {n.fields.map((f) => (
            <li key={f} data-field-issue={f}>
              {describeField(f)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AccountEditor(props: {
  account: Account | null;
  onSaved: (account: Account) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => Promise<void>;
}): React.JSX.Element {
  const { account } = props;
  return (
    <section className="editor" aria-label={account ? `Edit ${account.displayName}` : 'Add account'}>
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onClose()}>
            ← All accounts
          </button>
          <h2>{account ? account.displayName : 'Add account'}</h2>
          {account && (
            <p className="muted small">
              ID <span className="mono">{account.id}</span> ·{' '}
              <Badge tone={ACCOUNT_STATUS[account.status].tone} testId="editor-account-status" value={account.status}>
                {ACCOUNT_STATUS[account.status].label}
              </Badge>
            </p>
          )}
        </div>
      </div>
      <AccountDetails account={account} onSaved={props.onSaved} />
      <ProxySection account={account} onChanged={props.onRefresh} />
      <section className="card" aria-labelledby="sessions-title">
        <h3 id="sessions-title">3 · Platform sessions</h3>
        {!account ? (
          <p className="muted">Save the account first.</p>
        ) : (
          <>
            <p className="muted small">
              Each platform has its own isolated browser storage and uses this account's proxy. Paste the Cookie-Editor JSON export (Export → JSON) or import the
              file, then Validate &amp; encrypt. Sessions can be set up later. A draft can be saved without them.
            </p>
            <div className="session-grid">
              {account.sessions.map((s) => (
                <SessionCard key={s.id} account={account} session={s} onChanged={props.onRefresh} />
              ))}
            </div>
          </>
        )}
      </section>
      <div className="footer-actions">
        <button type="button" className="primary" onClick={() => void props.onClose()} disabled={!account}>
          Save and close
        </button>
        {!account && <span className="muted small">Enter a name and mode, then Save draft.</span>}
      </div>
    </section>
  );
}

function AccountDetails(props: { account: Account | null; onSaved: (a: Account) => Promise<void> }): React.JSX.Element {
  const { account } = props;
  const [name, setName] = useState(account?.displayName ?? '');
  const [mode, setMode] = useState<Mode | ''>(account?.mode ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    const result = account ? await bridge.updateAccount(account.id, name, mode as Mode) : await bridge.createAccount(name, mode as Mode);
    setBusy(false);
    if (!result.ok) return setNotice(noticeFromError(result.error));
    setNotice({ tone: 'ok', text: account ? 'Changes saved.' : 'Draft saved. Next: add the dedicated proxy.' });
    await props.onSaved(result.data);
  };

  return (
    <section className="card" aria-labelledby="details-title">
      <h3 id="details-title">1 · Account</h3>
      <div className="form-row">
        <label>
          Display name
          <input name="displayName" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="e.g. Skincare ID 01" />
        </label>
        <fieldset>
          <legend>Production mode</legend>
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <label key={m} className="radio">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              {MODE_LABELS[m]}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {account ? 'Save changes' : 'Save draft'}
        </button>
      </div>
      <NoticeLine notice={notice} testId="details-notice" />
    </section>
  );
}

function ProxySection(props: { account: Account | null; onChanged: () => Promise<void> }): React.JSX.Element {
  const { account } = props;
  const saved = account?.proxy ?? null;
  const [protocol, setProtocol] = useState<string>(saved?.protocol ?? 'http');
  const [host, setHost] = useState(saved?.host ?? '');
  const [port, setPort] = useState(saved ? String(saved.port) : '');
  const [username, setUsername] = useState('');
  const [keep, setKeep] = useState(saved?.hasCredentials ?? false);
  // The password is never held in React state; it is read from the field, sent once and cleared.
  const password = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const disabled = !account;

  const save = async (): Promise<void> => {
    if (!account) return;
    const secret = password.current?.value ?? '';
    if (password.current) password.current.value = '';
    const proxy: Record<string, string> = { protocol, host, port };
    if (username) proxy['username'] = username;
    if (secret) proxy['password'] = secret;
    setBusy('save');
    const result = await bridge.setAccountProxy(account.id, proxy, keep && !secret);
    setBusy(null);
    setUsername('');
    if (!result.ok) return setNotice(noticeFromError(result.error));
    setKeep(result.data.proxy?.hasCredentials ?? false);
    setNotice({ tone: 'warn', text: 'Proxy saved. It must pass Test proxy before any website can be opened.' });
    await props.onChanged();
  };

  const test = async (): Promise<void> => {
    if (!account) return;
    setBusy('test');
    setNotice({ tone: 'warn', text: 'Testing the proxy…' });
    const result: Result<Account> = await bridge.testAccountProxy(account.id);
    setBusy(null);
    if (!result.ok) return setNotice(noticeFromError(result.error));
    const p = result.data.proxy;
    if (p?.status === 'ok') setNotice({ tone: 'ok', text: `Proxy works. Public IP seen by websites: ${p.observedIp} (${p.endpoint} check service).` });
    else setNotice(noticeFromError({ code: p?.error ?? 'network_error' }));
    await props.onChanged();
  };

  const status = saved ? saved.status : 'none';
  return (
    <section className="card" aria-labelledby="proxy-title">
      <h3 id="proxy-title">2 · Dedicated proxy</h3>
      {disabled ? (
        <p className="muted">Save the account first.</p>
      ) : (
        <>
          <p className="muted small">
            Required. This account's browser sessions only ever connect through this proxy; if it fails, browsing is blocked. The password is encrypted with
            Windows protection and never shown again.
          </p>
          <div className="form-grid">
            <label>
              Protocol
              <select name="protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5 (no login)</option>
              </select>
            </label>
            <label className="wide">
              Host / IP
              <input name="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="proxy.example.com" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Port
              <input name="port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="8080" autoComplete="off" />
            </label>
            <label>
              Username
              <input
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={saved?.hasCredentials ? 'unchanged' : 'optional'}
              />
            </label>
            <label>
              Password
              <input name="password" type="password" ref={password} autoComplete="new-password" placeholder={saved?.hasCredentials ? '•••••• (saved)' : 'optional'} />
            </label>
          </div>
          {saved?.hasCredentials && (
            <label className="checkbox">
              <input type="checkbox" name="keepCredentials" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              Keep the saved username and password (leave both fields empty)
            </label>
          )}
          <div className="actions">
            <button type="button" className="primary" disabled={busy !== null} onClick={() => void save()}>
              {saved ? 'Save proxy changes' : 'Save proxy'}
            </button>
            <button type="button" disabled={busy !== null || !saved} onClick={() => void test()}>
              {busy === 'test' ? 'Testing…' : 'Test proxy'}
            </button>
          </div>
          <div className="proxy-status" data-testid="proxy-status" data-status={status}>
            <div>
              Connection status:{' '}
              {!saved && <Badge tone="muted">Not set</Badge>}
              {saved?.status === 'untested' && <Badge tone="warn">Not tested in this session</Badge>}
              {saved?.status === 'ok' && <Badge tone="ok">Passed</Badge>}
              {saved?.status === 'failed' && <Badge tone="bad">Failed</Badge>}
              {saved && (
                <span className="muted small">
                  {' '}
                  {saved.protocol.toUpperCase()} {saved.host}:{saved.port}
                  {saved.hasCredentials ? ' · login saved' : ' · no login'}
                </span>
              )}
            </div>
            <div>
              Observed public IP: <strong data-testid="observed-ip">{saved?.status === 'ok' ? saved.observedIp : '—'}</strong>
              {saved?.status === 'ok' && saved.endpoint && <span className="muted small"> (via {saved.endpoint} check service)</span>}
            </div>
          </div>
          <NoticeLine notice={notice} testId="proxy-notice" />
        </>
      )}
    </section>
  );
}

function SessionCard(props: { account: Account; session: AccountSession; onChanged: () => Promise<void> }): React.JSX.Element {
  const { account, session } = props;
  const [pasteKey, setPasteKey] = useState(0);
  const paste = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const status = SESSION_STATUS[session.status] ?? { label: session.status, tone: 'muted' as const };
  const canBrowse = account.proxy !== null;
  const configured = session.status !== 'never_configured';

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      await props.onChanged();
    }
  };

  const importPasted = (): Promise<void> =>
    run(async () => {
      const text = paste.current?.value ?? '';
      // Clear the input immediately: the element is replaced, which also drops its undo history.
      setPasteKey((k) => k + 1);
      if (text.trim().length === 0) return setNotice({ tone: 'bad', text: 'Paste the Cookie-Editor JSON export first.' });
      const result = await bridge.importSessionText(session.id, text);
      if (!result.ok) return setNotice(noticeFromError(result.error));
      setNotice(result.data.lastImport ? describeImport(result.data.lastImport) : null);
    });

  const importFile = (): Promise<void> =>
    run(async () => {
      const result = await bridge.importCookies(session.id);
      if (!result.ok) return setNotice(noticeFromError(result.error));
      if (result.data.canceled) return setNotice(null);
      setNotice(result.data.profile.lastImport ? describeImport(result.data.profile.lastImport) : null);
    });

  const open = (): Promise<void> =>
    run(async () => {
      setNotice({ tone: 'warn', text: 'Checking the proxy and opening the browser…' });
      const result = await bridge.openSite(session.id, 'home');
      setNotice(result.ok ? { tone: 'ok', text: 'Browser opened through this account’s proxy. Confirm below what you see.' } : noticeFromError(result.error));
    });

  const confirm = (observation: 'logged_in' | 'logged_out'): Promise<void> =>
    run(async () => {
      const result = await bridge.confirmStatus(session.id, observation);
      setNotice(result.ok ? null : noticeFromError(result.error));
    });

  const clear = (): Promise<void> =>
    run(async () => {
      setConfirmClear(false);
      const result = await bridge.clearProfile(session.id);
      setNotice(result.ok ? { tone: 'ok', text: 'Session cleared: cookies, site storage and the saved copy were removed.' } : noticeFromError(result.error));
    });

  const sync = session.sessionSync;
  return (
    <article className="session-card" data-platform={session.platformId} data-session-id={session.id} aria-label={`${session.platform.displayName} session`}>
      <header>
        <h4>
          {session.platform.displayName}
          {session.optional && <span className="tag">optional</span>}
        </h4>
        <Badge tone={status.tone} testId="session-status" value={session.status}>
          {status.label}
        </Badge>
      </header>
      {session.platform.automation === 'not_permitted' && (
        <p className="muted small">
          Manual session: the app never sends requests to this site on its own.
          {session.platformId === 'kalodata' ? ' Automated research is not permitted (Kalodata Terms §4.1.8).' : ''}
        </p>
      )}
      <dl className="facts small">
        <dt>Last import</dt>
        <dd>{session.lastImport ? describeImport(session.lastImport).text : '—'}</dd>
        <dt>Session cookies</dt>
        <dd data-testid="sync-line" data-saved-count={sync.savedCount}>
          {sync.saveError ? `not saved (${sync.saveError})` : sync.savedCount > 0 ? `${sync.savedCount} encrypted and saved` : 'none saved'}
          {sync.restore ? ` · last restore ${sync.restore.state}${sync.restore.error ? ` (${sync.restore.error})` : ''}` : ''}
        </dd>
      </dl>
      <label className="paste">
        {configured ? 'Re-import: paste Cookie-Editor JSON' : 'Paste Cookie-Editor JSON'}
        <textarea
          key={pasteKey}
          ref={paste}
          name="cookie-json"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          placeholder='[{"domain": "...", "name": "...", ...}]'
          onDrop={(e) => e.preventDefault()}
        />
      </label>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void importPasted()}>
          Validate &amp; encrypt
        </button>
        <button type="button" disabled={busy} onClick={() => void importFile()}>
          Import JSON file…
        </button>
        <button type="button" disabled={busy || !canBrowse} title={canBrowse ? 'Opens through this account’s proxy' : 'Add and test the proxy first'} onClick={() => void open()}>
          {configured ? 'Open browser' : 'Log in here'}
        </button>
      </div>
      <div className="actions secondary">
        <button type="button" disabled={busy} onClick={() => void confirm('logged_in')}>
          I'm logged in
        </button>
        <button type="button" disabled={busy} onClick={() => void confirm('logged_out')}>
          I'm logged out
        </button>
        {confirmClear ? (
          <>
            <button type="button" className="danger" disabled={busy} onClick={() => void clear()}>
              Confirm clear
            </button>
            <button type="button" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="danger-outline" disabled={busy} onClick={() => setConfirmClear(true)}>
            Clear session
          </button>
        )}
      </div>
      {!canBrowse && <p className="muted small">Browsing is blocked until this account's proxy is set and passes its test.</p>}
      <NoticeLine notice={notice} testId="session-notice" />
    </article>
  );
}
