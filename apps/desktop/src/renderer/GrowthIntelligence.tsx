import { useCallback, useEffect, useState } from 'react';
import { bridge, describeError, describeField, type Account, type GrowthStrategy, type GrowthView, type ImportResult, type ScoredReference } from './bridge.js';
import { Badge } from './Badge.js';

// Growth Intelligence (Gate 5, R1/R2): per-account strategy and thresholds,
// owner-entered research (manual entry, CSV), deterministic outlier scoring
// with confidence and data-quality indicators, and a shortlist. Nothing here
// fetches anything from TikTok: every number comes from the owner or an
// authorized source.

type Notice = { tone: 'ok' | 'bad' | 'warn'; text: string; fields?: string[] } | null;

const VERDICT: Record<ScoredReference['assessment']['verdict'], { label: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  outlier: { label: 'Outlier', tone: 'ok' },
  not_outlier: { label: 'Not an outlier', tone: 'muted' },
  unverified: { label: 'Unverified', tone: 'warn' },
  missing_metrics: { label: 'Missing metrics', tone: 'bad' },
};
const CONFIDENCE_TONE = { high: 'ok', medium: 'warn', low: 'bad' } as const;
const FLAG_LABEL: Record<string, string> = {
  missing_views: 'no views',
  missing_engagement: 'engagement incomplete',
  missing_published_at: 'no date',
  rounded_metrics: 'rounded numbers',
  stale_metrics: 'stale metrics',
  inconsistent_metrics: 'inconsistent',
  too_recent: 'too recent',
  outside_window: 'outside window',
  baseline_includes_rounded: 'baseline rounded',
};

const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const metric = (m: { value: number; exactness: string } | null): string => (m ? `${m.exactness === 'rounded' ? '≈' : ''}${fmt(m.value)}` : '—');
// Re-sends a stored metric so its exactness survives an edit: rounded values go back as "<n>K".
const asInput = (m: { value: number; exactness: string } | null): string => (m ? (m.exactness === 'rounded' ? `${m.value / 1000}K` : String(m.value)) : '');
const today = (): string => new Date().toISOString().slice(0, 10);
const errNotice = (e: { code: string; details?: string[] }): Notice => {
  const d = describeError(e.code);
  return { tone: 'bad', text: `${d.message} ${d.recovery}`, fields: e.details ?? [] };
};

function NoticeBox(props: { notice: Notice; testId: string }): React.JSX.Element | null {
  if (!props.notice) return null;
  return (
    <div className={`notice ${props.notice.tone}`} role={props.notice.tone === 'bad' ? 'alert' : 'status'} data-testid={props.testId}>
      {props.notice.text}
      {props.notice.fields && props.notice.fields.length > 0 && (
        <ul>
          {props.notice.fields.map((f) => (
            <li key={f} data-field-issue={f}>
              {describeField(f)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GrowthIntelligence(props: { account: Account | null; onBack: () => Promise<void> }): React.JSX.Element {
  const { account } = props;
  const [view, setView] = useState<GrowthView | null>(null);
  const [error, setError] = useState<Notice>(null);

  const load = useCallback(async () => {
    if (!account) return;
    const r = await bridge.growthView(account.id);
    if (r.ok) setView(r.data);
    else setError(errNotice(r.error));
  }, [account]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!account) return <p className="muted">Account not found.</p>;
  const refs = view?.references ?? [];
  const byId = new Map(refs.map((r) => [r.id, r]));
  const count = (v: ScoredReference['assessment']['verdict']) => refs.filter((r) => r.assessment.verdict === v).length;

  return (
    <section className="growth" aria-label="Growth Intelligence">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Growth Intelligence · {account.displayName}</h2>
          <p className="muted small">
            Research you enter or import is scored against each creator&apos;s own median. Nothing is fetched from TikTok automatically.
          </p>
        </div>
      </div>
      <NoticeBox notice={error} testId="growth-error" />
      {view && (
        <>
          <div className="summary" data-testid="growth-summary">
            <span>
              <strong>{refs.length}</strong> references
            </span>
            <span>
              <strong>{count('outlier')}</strong> outliers
            </span>
            <span>
              <strong>{count('unverified')}</strong> unverified
            </span>
            <span>
              <strong>{count('missing_metrics')}</strong> missing metrics
            </span>
            <span>
              <strong>{view.shortlist.length}</strong> shortlisted
            </span>
          </div>
          <Shortlist ids={view.shortlist} byId={byId} />
          <StrategyForm key={account.id} bundleId={account.id} view={view} onView={setView} />
          <Creators bundleId={account.id} view={view} onView={setView} />
          <AddReference bundleId={account.id} onView={setView} />
          <CsvImport bundleId={account.id} onView={setView} />
          <ReferencesTable bundleId={account.id} view={view} onView={setView} />
        </>
      )}
    </section>
  );
}

function Shortlist(props: { ids: string[]; byId: Map<string, ScoredReference> }): React.JSX.Element {
  return (
    <section className="card" aria-labelledby="shortlist-title">
      <h3 id="shortlist-title">Shortlist: high-potential creative references</h3>
      {props.ids.length === 0 ? (
        <p className="muted small">No outliers yet. Add references with views for several videos per creator, or pin a reference to keep it for creative analysis.</p>
      ) : (
        <ol className="shortlist" data-testid="shortlist">
          {props.ids.map((id) => {
            const r = props.byId.get(id)!;
            const a = r.assessment;
            return (
              <li key={id} data-reference-id={id} data-verdict={a.verdict}>
                <div className="shortlist-head">
                  <strong>@{r.creatorHandle}</strong>
                  {a.ratio !== null && <span className="ratio">{a.ratio.toFixed(1)}×</span>}
                  <Badge tone={VERDICT[a.verdict].tone}>{a.verdict === 'outlier' ? 'Outlier' : `${VERDICT[a.verdict].label} · pinned`}</Badge>
                  {a.ratio !== null && <Badge tone={CONFIDENCE_TONE[a.confidence]}>{a.confidence} confidence</Badge>}
                </div>
                <div className="small">{r.explanation}</div>
                <div className="muted small mono">{r.url}</div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function StrategyForm(props: { bundleId: string; view: GrowthView; onView: (v: GrowthView) => void }): React.JSX.Element {
  const [s, setS] = useState<GrowthStrategy>(props.view.strategy);
  const [subNiches, setSubNiches] = useState(props.view.strategy.subNiches.join(', '));
  const [reasons, setReasons] = useState(props.view.strategy.followReasons.join('\n'));
  const [notice, setNotice] = useState<Notice>(null);
  const t = s.thresholds;
  const num = (v: string): number => (v.trim() === '' ? NaN : Number(v));
  const setT = (k: keyof GrowthStrategy['thresholds'], v: string) => setS({ ...s, thresholds: { ...t, [k]: num(v) } });

  const save = async (): Promise<void> => {
    const strategy = {
      ...s,
      subNiches: subNiches.split(',').map((x) => x.trim()).filter(Boolean),
      followReasons: reasons.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    const r = await bridge.saveGrowthStrategy(props.bundleId, strategy);
    if (!r.ok) return setNotice(errNotice(r.error));
    setNotice({ tone: 'ok', text: 'Strategy and thresholds saved. Scores were recalculated.' });
    props.onView(r.data);
  };

  return (
    <section className="card" aria-labelledby="strategy-title">
      <h3 id="strategy-title">Account strategy</h3>
      {!props.view.strategySaved && <p className="muted small">Not saved yet. Default thresholds are in use.</p>}
      <div className="form-grid strategy-grid">
        <label>
          Niche
          <input name="niche" value={s.niche} onChange={(e) => setS({ ...s, niche: e.target.value })} placeholder="e.g. home appliances" />
        </label>
        <label className="wide2">
          Sub-niches (comma-separated)
          <input name="subNiches" value={subNiches} onChange={(e) => setSubNiches(e.target.value)} placeholder="kitchen gadgets, cleaning hacks" />
        </label>
        <label className="wide2">
          Target audience
          <input name="audience" value={s.audience} onChange={(e) => setS({ ...s, audience: e.target.value })} placeholder="new homeowners, 22–35" />
        </label>
        <label>
          Region
          <input name="region" value={s.region} onChange={(e) => setS({ ...s, region: e.target.value })} />
        </label>
        <label>
          Content language
          <input name="language" value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })} />
        </label>
        <label className="wide2">
          Desired follower audience
          <input name="desiredFollowers" value={s.desiredFollowers} onChange={(e) => setS({ ...s, desiredFollowers: e.target.value })} />
        </label>
        <label className="wide2">
          Why viewers should follow (one per line)
          <textarea name="followReasons" rows={3} value={reasons} onChange={(e) => setReasons(e.target.value)} />
        </label>
        <label className="wide2">
          Video style and creative constraints
          <textarea name="styleConstraints" rows={3} value={s.styleConstraints} onChange={(e) => setS({ ...s, styleConstraints: e.target.value })} />
        </label>
        <label>
          Daily concepts
          <input name="dailyConcepts" inputMode="numeric" value={String(s.dailyConcepts)} onChange={(e) => setS({ ...s, dailyConcepts: num(e.target.value) })} />
        </label>
        <label>
          Daily videos
          <input name="dailyVideos" inputMode="numeric" value={String(s.dailyVideos)} onChange={(e) => setS({ ...s, dailyVideos: num(e.target.value) })} />
        </label>
      </div>
      <h4>Research thresholds</h4>
      <div className="form-grid threshold-grid">
        <label>
          Outlier threshold (×)
          <input name="outlierThreshold" inputMode="decimal" value={String(t.outlierThreshold)} onChange={(e) => setT('outlierThreshold', e.target.value)} />
        </label>
        <label>
          Research window (days)
          <input name="windowDays" inputMode="numeric" value={String(t.windowDays)} onChange={(e) => setT('windowDays', e.target.value)} />
        </label>
        <label>
          Recommended baseline (videos)
          <input name="recommendedBaseline" inputMode="numeric" value={String(t.recommendedBaseline)} onChange={(e) => setT('recommendedBaseline', e.target.value)} />
        </label>
        <label>
          Minimum baseline (videos)
          <input name="minimumBaseline" inputMode="numeric" value={String(t.minimumBaseline)} onChange={(e) => setT('minimumBaseline', e.target.value)} />
        </label>
        <label>
          Settle age (days)
          <input name="settleDays" inputMode="numeric" value={String(t.settleDays)} onChange={(e) => setT('settleDays', e.target.value)} />
        </label>
        <label>
          Minimum views
          <input name="minViews" inputMode="numeric" value={String(t.minViews)} onChange={(e) => setT('minViews', e.target.value)} />
        </label>
        <label>
          Metrics stale after (days)
          <input name="staleDays" inputMode="numeric" value={String(t.staleDays)} onChange={(e) => setT('staleDays', e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={() => void save()}>
          Save strategy
        </button>
      </div>
      <NoticeBox notice={notice} testId="strategy-notice" />
    </section>
  );
}

function Creators(props: { bundleId: string; view: GrowthView; onView: (v: GrowthView) => void }): React.JSX.Element {
  const [handle, setHandle] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const add = async (): Promise<void> => {
    const r = await bridge.addReferenceCreator(props.bundleId, handle, note);
    if (!r.ok) return setNotice(errNotice(r.error));
    setHandle('');
    setNote('');
    setNotice(null);
    props.onView(r.data);
  };
  return (
    <section className="card" aria-labelledby="creators-title">
      <h3 id="creators-title">Reference creators</h3>
      <div className="form-grid creator-grid">
        <label>
          Handle or profile link
          <input name="creatorHandle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@creator or https://www.tiktok.com/@creator" />
        </label>
        <label className="wide2">
          Note
          <input name="creatorNote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="why this creator is a reference" />
        </label>
        <div className="actions end">
          <button type="button" onClick={() => void add()}>
            Add creator
          </button>
        </div>
      </div>
      <NoticeBox notice={notice} testId="creator-notice" />
      {props.view.creators.length > 0 && (
        <ul className="creators" data-testid="creators">
          {props.view.creators.map((c) => (
            <li key={c.id}>
              <strong>@{c.handle}</strong> <span className="muted small">{c.videoCount} reference video(s){c.note ? ` · ${c.note}` : ''}</span>{' '}
              <button type="button" className="link danger-text" onClick={() => void bridge.removeReferenceCreator(props.bundleId, c.id).then((r) => r.ok && props.onView(r.data))}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const EMPTY_FORM = { url: '', publishedAt: '', views: '', likes: '', comments: '', shares: '', observedAt: '', durationSeconds: '', relevance: 'unrated', note: '', pinned: false };

function AddReference(props: { bundleId: string; onView: (v: GrowthView) => void }): React.JSX.Element {
  const [f, setF] = useState({ ...EMPTY_FORM, observedAt: today() });
  const [notice, setNotice] = useState<Notice>(null);
  const field = (k: keyof typeof EMPTY_FORM, label: string, placeholder = '') => (
    <label>
      {label}
      <input name={`ref-${k}`} value={String(f[k])} placeholder={placeholder} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  const add = async (): Promise<void> => {
    const r = await bridge.addReference(props.bundleId, { ...f, durationSeconds: f.durationSeconds === '' ? undefined : f.durationSeconds });
    if (!r.ok) return setNotice(errNotice(r.error));
    setNotice({ tone: 'ok', text: r.data.outcome === 'added' ? 'Reference added and scored.' : 'This video was already listed: its metrics were updated.' });
    setF({ ...EMPTY_FORM, observedAt: today() });
    props.onView(r.data.view);
  };
  return (
    <section className="card" aria-labelledby="addref-title">
      <h3 id="addref-title">Add a reference video</h3>
      <p className="muted small">
        Copy the full link from the video page and the numbers you see. Numbers like 1.2M or 3,4 jt are stored as rounded. Leave a metric empty if you don’t have it; it won’t be guessed.
      </p>
      <div className="form-grid ref-grid">
        <label className="wide3">
          Video link
          <input name="ref-url" value={f.url} placeholder="https://www.tiktok.com/@creator/video/1234567890123456789" onChange={(e) => setF({ ...f, url: e.target.value })} />
        </label>
        {field('publishedAt', 'Published (YYYY-MM-DD)', '2026-10-01')}
        {field('views', 'Views', '125000 or 1.2M')}
        {field('likes', 'Likes')}
        {field('comments', 'Comments')}
        {field('shares', 'Shares')}
        {field('observedAt', 'Observed on')}
        {field('durationSeconds', 'Duration (s)')}
        <label>
          Relevance
          <select name="ref-relevance" value={f.relevance} onChange={(e) => setF({ ...f, relevance: e.target.value })}>
            <option value="unrated">Unrated</option>
            <option value="relevant">Relevant to niche</option>
            <option value="not_relevant">Not relevant</option>
          </select>
        </label>
        <label className="wide2">
          Note
          <input name="ref-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
        <label className="checkbox">
          <input type="checkbox" name="ref-pinned" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />
          Pin to shortlist
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={() => void add()}>
          Add reference
        </button>
      </div>
      <NoticeBox notice={notice} testId="addref-notice" />
    </section>
  );
}

function CsvImport(props: { bundleId: string; onView: (v: GrowthView) => void }): React.JSX.Element {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const done = (r: ImportResult): void => {
    setResult(r);
    setNotice({ tone: r.rejected ? 'warn' : 'ok', text: `${r.added} added, ${r.updated} updated, ${r.rejected} rejected${r.ignoredColumns ? `, ${r.ignoredColumns} unknown column(s) ignored` : ''}.` });
  };
  const importText = async (): Promise<void> => {
    const r = await bridge.importReferencesCsvText(props.bundleId, text);
    if (!r.ok) return setNotice(errNotice(r.error));
    setText('');
    done(r.data.result);
    props.onView(r.data.view);
  };
  const importFile = async (): Promise<void> => {
    const r = await bridge.importReferencesCsvFile(props.bundleId);
    if (!r.ok) return setNotice(errNotice(r.error));
    if (r.data.canceled || !r.data.result || !r.data.view) return;
    done(r.data.result);
    props.onView(r.data.view);
  };
  return (
    <section className="card" aria-labelledby="csv-title">
      <h3 id="csv-title">Import from CSV</h3>
      <p className="muted small">
        Columns (header row, any order; only <span className="mono">url</span> is required):{' '}
        <span className="mono">url, creator, published_at, views, likes, comments, shares, observed_at, duration_s, relevance, note</span>. Comma or semicolon separated. Re-importing a video updates its metrics.
      </p>
      <textarea name="csv-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="url,published_at,views,likes,comments,shares" spellCheck={false} />
      <div className="actions">
        <button type="button" className="primary" disabled={text.trim() === ''} onClick={() => void importText()}>
          Import pasted CSV
        </button>
        <button type="button" onClick={() => void importFile()}>
          Import CSV file…
        </button>
      </div>
      <NoticeBox notice={notice} testId="csv-notice" />
      {result && result.rejected > 0 && (
        <ul className="small" data-testid="csv-rejections">
          {result.rows
            .filter((r) => r.status === 'rejected')
            .slice(0, 50)
            .map((r) => (
              <li key={r.row}>
                Row {r.row}: {r.issues.map(describeField).join(' ')}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function ReferencesTable(props: { bundleId: string; view: GrowthView; onView: (v: GrowthView) => void }): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const update = async (id: string, patch: Record<string, unknown>): Promise<boolean> => {
    const r = await bridge.updateReference(props.bundleId, id, patch);
    if (!r.ok) {
      setNotice(errNotice(r.error));
      return false;
    }
    setNotice(null);
    props.onView(r.data);
    return true;
  };
  const current = (r: ScoredReference): Record<string, unknown> => ({
    publishedAt: r.publishedAt?.slice(0, 10) ?? '',
    views: asInput(r.metrics.views),
    likes: asInput(r.metrics.likes),
    comments: asInput(r.metrics.comments),
    shares: asInput(r.metrics.shares),
    observedAt: r.metrics.observedAt?.slice(0, 10) ?? '',
    durationSeconds: r.durationSeconds ?? undefined,
    relevance: r.relevance,
    note: r.note,
  });
  return (
    <section className="card" aria-labelledby="refs-title">
      <h3 id="refs-title">All references</h3>
      <NoticeBox notice={notice} testId="refs-notice" />
      {props.view.references.length === 0 ? (
        <p className="muted small">No references yet.</p>
      ) : (
        <table className="refs" data-testid="references">
          <thead>
            <tr>
              <th>Creator / published</th>
              <th>Views</th>
              <th>Engagement</th>
              <th>Creator baseline</th>
              <th>Score</th>
              <th>Data quality</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {props.view.references.map((r) => {
              const a = r.assessment;
              return (
                <tr key={r.id} data-reference-id={r.id} data-verdict={a.verdict} data-confidence={a.confidence}>
                  <td>
                    <strong>@{r.creatorHandle}</strong>
                    <div className="muted small">{r.publishedAt ? `${r.publishedAt.slice(0, 10)} · ${a.ageDays} d` : 'date unknown'}</div>
                  </td>
                  <td>{editing === r.id ? <EditMetrics r={r} initial={current(r)} onSave={async (p) => (await update(r.id, p)) && setEditing(null)} onCancel={() => setEditing(null)} /> : metric(r.metrics.views)}</td>
                  <td className="small">
                    {metric(r.metrics.likes)} / {metric(r.metrics.comments)} / {metric(r.metrics.shares)}
                    {a.engagementRate !== null && <div className="muted">{(a.engagementRate * 100).toFixed(1)}% eng.</div>}
                  </td>
                  <td className="small">
                    {a.baseline.medianViews !== null ? `median ${fmt(a.baseline.medianViews)}` : 'none'}
                    <div className="muted">
                      {a.baseline.sampleSize} video(s) · {a.baseline.level === 'recommended' ? 'recommended' : a.baseline.level === 'minimum' ? 'minimum' : 'insufficient'}
                    </div>
                  </td>
                  <td>
                    <Badge tone={VERDICT[a.verdict].tone} testId="verdict" value={a.verdict}>
                      {a.ratio !== null ? `${a.ratio.toFixed(1)}× · ` : ''}
                      {VERDICT[a.verdict].label}
                    </Badge>
                    {a.ratio !== null && (
                      <div>
                        <Badge tone={CONFIDENCE_TONE[a.confidence]}>{a.confidence}</Badge>
                      </div>
                    )}
                    <div className="small explanation">{r.explanation}</div>
                  </td>
                  <td>
                    <div className="chips">
                      {a.flags.length === 0 ? (
                        <Badge tone="ok">complete</Badge>
                      ) : (
                        a.flags.map((f) => (
                          <Badge key={f} tone={f === 'missing_views' || f === 'inconsistent_metrics' ? 'bad' : 'warn'} value={f}>
                            {FLAG_LABEL[f] ?? f}
                          </Badge>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="row-actions">
                    <select
                      aria-label="Relevance"
                      value={r.relevance}
                      onChange={(e) => void update(r.id, { ...current(r), relevance: e.target.value, pinned: r.pinned })}
                    >
                      <option value="unrated">Unrated</option>
                      <option value="relevant">Relevant</option>
                      <option value="not_relevant">Not relevant</option>
                    </select>
                    <button type="button" onClick={() => void update(r.id, { ...current(r), pinned: !r.pinned })}>
                      {r.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button type="button" onClick={() => setEditing(r.id)}>
                      Edit metrics
                    </button>
                    <button type="button" className="danger-outline" onClick={() => void bridge.removeReference(props.bundleId, r.id).then((x) => x.ok && props.onView(x.data))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EditMetrics(props: { r: ScoredReference; initial: Record<string, unknown>; onSave: (patch: Record<string, unknown>) => Promise<unknown>; onCancel: () => void }): React.JSX.Element {
  const [v, setV] = useState<Record<string, unknown>>({ ...props.initial, observedAt: today() });
  const input = (k: string, label: string) => (
    <label className="tiny">
      {label}
      <input name={`edit-${k}`} value={String(v[k] ?? '')} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="edit-metrics">
      {input('views', 'Views')}
      {input('likes', 'Likes')}
      {input('comments', 'Comments')}
      {input('shares', 'Shares')}
      {input('publishedAt', 'Published')}
      {input('observedAt', 'Observed')}
      <div className="actions">
        <button type="button" className="primary" onClick={() => void props.onSave({ ...v, pinned: props.r.pinned })}>
          Save
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
