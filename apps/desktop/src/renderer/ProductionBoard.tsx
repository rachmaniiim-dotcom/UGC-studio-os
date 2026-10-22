import { useCallback, useEffect, useState } from 'react';
import { bridge, describeError, type BoardRow } from './bridge.js';

// Ternak Akun today (T2): each growth account's production against its daily
// target, from this app's own records only: videos that reached the account's
// library today and posts the owner marked as posted. The app never publishes.

export function ProductionBoard(props: { onBack: () => Promise<void>; onStudio: (id: string) => void }): React.JSX.Element {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const apply = (data: BoardRow[]): void => {
    setRows(data);
    setTargets(Object.fromEntries(data.map((r) => [r.bundleId, String(r.target)])));
  };
  const load = useCallback(async () => {
    const r = await bridge.productionBoard();
    if (r.ok) apply(r.data);
    else setError(describeError(r.error.code).message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const totals = (rows ?? []).reduce(
    (t, r) => ({ target: t.target + r.target, videos: t.videos + r.videosToday, posted: t.posted + r.postedToday, ready: t.ready + r.readyToPost }),
    { target: 0, videos: 0, posted: 0, ready: 0 },
  );

  return (
    <section className="board" aria-label="Ternak Akun today">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Ternak Akun · today</h2>
          <p className="muted small">
            Counted from this app only: videos that arrived in each account’s library today, and posts you marked as posted. The app does not publish to TikTok.
          </p>
        </div>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      {rows && rows.length === 0 && <p className="muted">No Account Growth accounts yet.</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="summary" data-testid="board-summary">
            <span>
              <strong>
                {totals.videos}/{totals.target}
              </strong>{' '}
              videos today
            </span>
            <span>
              <strong>{totals.posted}</strong> posted today
            </span>
            <span>
              <strong>{totals.ready}</strong> ready to post
            </span>
          </div>
          <table className="accounts board-table" data-testid="board">
            <thead>
              <tr>
                <th>Account</th>
                <th>Videos today</th>
                <th>Posted today</th>
                <th>Ready to post</th>
                <th>Queued</th>
                <th>Generating</th>
                <th>To review</th>
                <th>Daily target</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = Math.min(100, Math.round((r.videosToday / r.target) * 100));
                return (
                  <tr key={r.bundleId} data-account-id={r.bundleId}>
                    <td>
                      <strong>{r.displayName}</strong>
                    </td>
                    <td data-testid="videos-today">
                      {r.videosToday}/{r.target}
                      <div className="progress" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                    <td data-testid="posted-today">{r.postedToday}</td>
                    <td data-testid="ready-to-post">{r.readyToPost}</td>
                    <td>{r.queued}</td>
                    <td>{r.generating}</td>
                    <td className="small">
                      {r.drafts} draft · {r.approved} approved
                    </td>
                    <td>
                      <input
                        className="target"
                        aria-label={`Daily target for ${r.displayName}`}
                        inputMode="numeric"
                        value={targets[r.bundleId] ?? ''}
                        onChange={(e) => setTargets({ ...targets, [r.bundleId]: e.target.value })}
                      />
                      {targets[r.bundleId] !== String(r.target) && (
                        <button
                          type="button"
                          className="link"
                          onClick={async () => {
                            const x = await bridge.setDailyTarget(r.bundleId, Number(targets[r.bundleId]));
                            if (x.ok) {
                              setError(null);
                              apply(x.data);
                            } else setError(`${describeError(x.error.code).message} ${describeError(x.error.code).recovery}`);
                          }}
                        >
                          save
                        </button>
                      )}
                    </td>
                    <td>
                      <button type="button" onClick={() => props.onStudio(r.bundleId)}>
                        Open Prompt Studio
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
