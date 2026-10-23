import { ACCOUNT_STATUS, MODE_LABELS, SESSION_STATUS, type Account } from './bridge.js';
import { Badge } from './Badge.js';

export function Dashboard(props: { accounts: Account[]; onAdd: () => void; onEdit: (id: string) => void; onGrowth: (id: string) => void; onStudio: (id: string) => void; onBoard: () => void; onProducts: (id: string) => void; onPool: () => void; onLibrary: (id: string) => void; onQueue: (id: string) => void }): React.JSX.Element {
  const { accounts } = props;
  const counts = {
    total: accounts.length,
    operational: accounts.filter((a) => a.status === 'operational').length,
    attention: accounts.filter((a) => a.status === 'attention' || a.status === 'proxy_check_needed').length,
    draft: accounts.filter((a) => a.status === 'draft').length,
  };
  return (
    <section className="dashboard" aria-label="Accounts">
      <div className="section-head">
        <div>
          <h2>Accounts</h2>
          <p className="muted">
            {counts.total} account{counts.total === 1 ? '' : 's'} · {counts.operational} operational · {counts.attention} need attention · {counts.draft}{' '}
            draft
          </p>
        </div>
        <div className="actions end">
          {accounts.length > 0 && (
            <button type="button" onClick={props.onPool}>
              Flow pool
            </button>
          )}
          {accounts.some((a) => a.mode === 'account_growth') && (
            <button type="button" onClick={props.onBoard}>
              Ternak Akun today
            </button>
          )}
          <button type="button" className="primary" onClick={props.onAdd}>
            + Add account
          </button>
        </div>
      </div>
      {accounts.length === 0 ? (
        <div className="empty">
          <p>No accounts yet.</p>
          <p className="muted">Each account is one TikTok identity with its own dedicated proxy and its own isolated platform sessions.</p>
          <button type="button" className="primary" onClick={props.onAdd}>
            Add your first account
          </button>
        </div>
      ) : (
        <table className="accounts">
          <thead>
            <tr>
              <th>Account</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Proxy</th>
              <th>Sessions</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} data-account-id={a.id}>
                <td>
                  <strong>{a.displayName}</strong>
                  <div className="muted mono small">{a.id.slice(0, 8)}</div>
                </td>
                <td>{MODE_LABELS[a.mode]}</td>
                <td>
                  <Badge tone={ACCOUNT_STATUS[a.status].tone} testId="account-status" value={a.status}>
                    {ACCOUNT_STATUS[a.status].label}
                  </Badge>
                </td>
                <td className="small">
                  {a.proxy ? (
                    <>
                      <div className="mono">
                        {a.proxy.host}:{a.proxy.port}
                      </div>
                      <div className="muted">
                        {a.proxy.status === 'ok' ? `IP ${a.proxy.observedIp}` : a.proxy.status === 'failed' ? 'Test failed' : 'Not tested in this session'}
                      </div>
                    </>
                  ) : (
                    <span className="muted">Not set</span>
                  )}
                </td>
                <td>
                  <div className="chips">
                    {a.sessions.map((s) => (
                      <Badge key={s.id} tone={SESSION_STATUS[s.status]?.tone ?? 'muted'} title={SESSION_STATUS[s.status]?.label ?? s.status}>
                        {s.platform.displayName}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="row-actions">
                  <button type="button" onClick={() => props.onEdit(a.id)}>
                    Open
                  </button>
                  {a.mode === 'affiliate_ugc' && (
                    <>
                      <button type="button" onClick={() => props.onProducts(a.id)}>
                        Products
                      </button>
                      <button type="button" onClick={() => props.onLibrary(a.id)}>
                        Video library
                      </button>
                    </>
                  )}
                  {a.mode === 'account_growth' && (
                    <>
                      <button type="button" className="primary" onClick={() => props.onQueue(a.id)}>
                        Posting queue
                      </button>
                      <button type="button" onClick={() => props.onStudio(a.id)}>
                        Prompt Studio
                      </button>
                      <button type="button" title="Optional advanced research" onClick={() => props.onGrowth(a.id)}>
                        Growth Intelligence
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
