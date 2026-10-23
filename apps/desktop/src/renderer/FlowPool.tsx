import { useCallback, useEffect, useState } from 'react';
import { bridge, describeError, describeField, type PoolAccount } from './bridge.js';
import { Badge } from './Badge.js';

// Flow pool (F0): Flow-only Google accounts supplying generation credits to
// both factories. Each has its own proxy and Google Flow session. Credits are
// this app's estimate (allowance minus videos downloaded since the reset);
// Google Flow's own counter is authoritative, so you can correct it here.

type Notice = { tone: 'ok' | 'bad'; text: string; fields?: string[] } | null;

export function FlowPool(props: { onBack: () => Promise<void>; onEdit: (id: string) => void }): React.JSX.Element {
  const [rows, setRows] = useState<PoolAccount[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const load = useCallback(async () => {
    const r = await bridge.flowPool();
    if (r.ok) setRows(r.data);
    else setNotice({ tone: 'bad', text: describeError(r.error.code).message });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const totals = (rows ?? []).reduce((t, a) => ({ remaining: t.remaining + Math.max(0, a.remaining), monthly: t.monthly + a.settings.monthlyCredits }), { remaining: 0, monthly: 0 });

  return (
    <section className="pool" aria-label="Flow pool">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Flow pool</h2>
          <p className="muted small">
            Google accounts used only for Flow credits. Add one with <strong>+ Add account</strong> and the mode “Flow pool”, then give it its proxy and Google Flow
            session. Prompt Studio sends a prompt to the account with the most credits left; the video you download there goes to the prompt’s account.
          </p>
        </div>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {notice && (
        <div className={`notice ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="pool-notice">
          {notice.text}
          {notice.fields && (
            <ul>
              {notice.fields.map((f) => (
                <li key={f} data-field-issue={f}>
                  {describeField(f)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {rows && rows.length === 0 && <p className="muted">No Flow pool accounts yet.</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="summary" data-testid="pool-summary">
            <span>
              <strong>{rows.length}</strong> pool account{rows.length === 1 ? '' : 's'}
            </span>
            <span>
              <strong>
                {totals.remaining.toLocaleString()} / {totals.monthly.toLocaleString()}
              </strong>{' '}
              credits left (estimate)
            </span>
          </div>
          <table className="accounts" data-testid="pool">
            <thead>
              <tr>
                <th>Account</th>
                <th>Credits left</th>
                <th>Videos this period</th>
                <th>Monthly / reset day / per video</th>
                <th>Correct balance</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <PoolRow key={`${a.id}:${a.used}:${a.settings.monthlyCredits}`} a={a} onRows={setRows} onNotice={setNotice} onEdit={props.onEdit} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function PoolRow(props: { a: PoolAccount; onRows: (r: PoolAccount[]) => void; onNotice: (n: Notice) => void; onEdit: (id: string) => void }): React.JSX.Element {
  const { a } = props;
  const [s, setS] = useState({ monthlyCredits: String(a.settings.monthlyCredits), resetDay: String(a.settings.resetDay), creditsPerDownload: String(a.settings.creditsPerDownload) });
  const [balance, setBalance] = useState('');
  const changed = s.monthlyCredits !== String(a.settings.monthlyCredits) || s.resetDay !== String(a.settings.resetDay) || s.creditsPerDownload !== String(a.settings.creditsPerDownload);
  const handle = (r: Awaited<ReturnType<typeof bridge.flowPool>>): void => {
    if (r.ok) {
      props.onNotice(null);
      props.onRows(r.data);
    } else {
      const d = describeError(r.error.code);
      props.onNotice({ tone: 'bad', text: `${d.message} ${d.recovery}`, fields: r.error.details ?? [] });
    }
  };
  const videosLeft = Math.max(0, Math.floor(a.remaining / a.settings.creditsPerDownload));
  return (
    <tr data-account-id={a.id}>
      <td>
        <strong>{a.displayName}</strong>
        <div>
          {!a.proxyConfigured && <Badge tone="warn">no proxy</Badge>}
          {!a.flowSessionId && <Badge tone="warn">no Flow session</Badge>}
        </div>
      </td>
      <td data-testid="pool-remaining">
        {a.remaining.toLocaleString()} <span className="muted small">(~{videosLeft} videos)</span>
      </td>
      <td>{a.downloadsThisPeriod}</td>
      <td>
        <span className="inline-inputs">
          <input aria-label={`Monthly credits for ${a.displayName}`} className="target wide-target" value={s.monthlyCredits} onChange={(e) => setS({ ...s, monthlyCredits: e.target.value })} />
          <input aria-label={`Reset day for ${a.displayName}`} className="target" value={s.resetDay} onChange={(e) => setS({ ...s, resetDay: e.target.value })} />
          <input aria-label={`Credits per video for ${a.displayName}`} className="target" value={s.creditsPerDownload} onChange={(e) => setS({ ...s, creditsPerDownload: e.target.value })} />
          {changed && (
            <button
              type="button"
              className="link"
              onClick={async () =>
                handle(await bridge.savePoolSettings(a.id, { monthlyCredits: Number(s.monthlyCredits), resetDay: Number(s.resetDay), creditsPerDownload: Number(s.creditsPerDownload) }))
              }
            >
              save
            </button>
          )}
        </span>
      </td>
      <td>
        <span className="inline-inputs">
          <input aria-label={`Remaining credits shown in Flow for ${a.displayName}`} className="target wide-target" placeholder="as in Flow" value={balance} onChange={(e) => setBalance(e.target.value)} />
          {balance.trim() !== '' && (
            <button
              type="button"
              className="link"
              onClick={async () => {
                handle(await bridge.setPoolRemaining(a.id, Number(balance)));
                setBalance('');
              }}
            >
              set
            </button>
          )}
        </span>
      </td>
      <td className="row-actions">
        {a.flowSessionId && (
          <button type="button" onClick={() => void bridge.openSite(a.flowSessionId!, 'home').then((r) => !r.ok && props.onNotice({ tone: 'bad', text: describeError(r.error.code).message }))}>
            Open Flow
          </button>
        )}
        <button type="button" onClick={() => props.onEdit(a.id)}>
          Proxy & session
        </button>
      </td>
    </tr>
  );
}
