import { useCallback, useEffect, useState } from 'react';
import { bridge, describeField, type Account, type FypReference, type QueueImportResult, type PostingQueueView, type QueueItem, type QueueStatus } from './bridge.js';
import { Badge } from './Badge.js';
import { errNotice, NoticeBox, Player } from './AffiliateStudio.js';

// Ternak Akun posting queue (G1). Two ways in, one queue per account:
// finished MP4s the owner drops in, and original AI videos made in Flow from
// FYP references. Captions come from an analysis of each actual video; a
// video the AI can't make out is flagged. Posting happens on TikTok's own
// upload page, opened in this account's window; "posted" is the owner's word.

type Notice = Parameters<typeof NoticeBox>[0]['notice'];
type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const STATUS: Record<QueueStatus, { label: string; tone: Tone }> = {
  analyzing: { label: 'Writing caption…', tone: 'muted' },
  needs_review: { label: 'Check caption', tone: 'warn' },
  ready: { label: 'Ready to post', tone: 'ok' },
  posted: { label: 'Posted (marked by you)', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'muted' },
  analysis_failed: { label: 'No caption yet', tone: 'bad' },
};

const FILTERS: ReadonlyArray<{ key: 'todo' | 'ready' | 'posted' | 'all'; label: string; match: (s: QueueStatus) => boolean }> = [
  { key: 'todo', label: 'To check', match: (s) => s === 'needs_review' || s === 'analysis_failed' || s === 'analyzing' },
  { key: 'ready', label: 'Ready to post', match: (s) => s === 'ready' },
  { key: 'posted', label: 'Posted', match: (s) => s === 'posted' },
  { key: 'all', label: 'All', match: () => true },
];

const importSummary = (r: QueueImportResult): string =>
  `${r.added.length} added${r.duplicates.length ? `, ${r.duplicates.length} already in this queue (${r.duplicates.join(', ')})` : ''}${
    r.rejected.length ? `, ${r.rejected.length} skipped (${r.rejected.map((x) => `${x.name}: ${describeField(x.reason)}`).join('; ')})` : ''
  }.`;

export function PostingQueue(props: { account: Account | null; onBack: () => Promise<void>; onStudio: () => void }): React.JSX.Element {
  const { account } = props;
  const [view, setView] = useState<PostingQueueView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [dragging, setDragging] = useState(false);
  const load = useCallback(async () => {
    if (!account) return;
    const r = await bridge.postingQueue(account.id);
    if (r.ok) setView(r.data);
    else setNotice(errNotice(r.error));
  }, [account]);
  useEffect(() => {
    void load();
  }, [load]);
  const analyzing = (view?.counts.analyzing ?? 0) > 0;
  useEffect(() => {
    if (!analyzing) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [analyzing, load]);

  if (!account) return <p className="muted">Account not found.</p>;
  const afterImport = (r: Awaited<ReturnType<typeof bridge.importDroppedVideos>>): void => {
    if (!r.ok) return setNotice(errNotice(r.error));
    setView(r.data.view);
    setNotice({ tone: r.data.result.rejected.length || r.data.result.duplicates.length ? 'warn' : 'ok', text: `${importSummary(r.data.result)} Captions are being written from each video.` });
  };
  const act = async (p: Promise<{ ok: true; data: PostingQueueView } | { ok: false; error: { code: string; details?: string[] } }>, ok?: string): Promise<boolean> => {
    const r = await p;
    if (!r.ok) {
      setNotice(errNotice(r.error));
      return false;
    }
    setView(r.data);
    setNotice(ok ? { tone: 'ok', text: ok } : null);
    return true;
  };
  const shown = (view?.items ?? []).filter((i) => FILTERS.find((f) => f.key === filter)!.match(i.status));

  return (
    <section className="gqueue" aria-label="Posting queue">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Posting queue · {account.displayName}</h2>
          <p className="muted small">
            Drop finished videos or make new ones from FYP references. Captions are written from each actual video. You post on TikTok’s own upload page; the app
            never posts for you.
          </p>
        </div>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <NoticeBox notice={notice} testId="gq-notice" />
      {view && (
        <>
          <div className="summary" data-testid="gq-summary">
            <span>
              <strong>
                {view.postedToday}/{view.dailyTarget}
              </strong>{' '}
              posted today
            </span>
            <span>
              <strong>{view.counts.ready}</strong> ready to post
            </span>
            <span>
              <strong>{view.counts.needs_review + view.counts.analysis_failed}</strong> to check
            </span>
            {view.counts.analyzing > 0 && (
              <span>
                <strong>{view.counts.analyzing}</strong> writing captions…
              </span>
            )}
          </div>
          <AnalysisBox status={view.analysis} onSaved={load} onNotice={setNotice} failed={view.counts.analysis_failed} onRetry={() => void act(bridge.retryQueueAnalysis(account.id), 'Analyzing again.')} />

          <section
            className={`card dropzone${dragging ? ' dragging' : ''}`}
            aria-labelledby="gq-add-title"
            data-testid="gq-drop"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.mp4'));
              if (files.length === 0) return setNotice({ tone: 'warn', text: 'Drop .mp4 files.' });
              void bridge.importDroppedVideos(account.id, files).then(afterImport);
            }}
          >
            <h3 id="gq-add-title">1. Finished videos</h3>
            <p className="small muted">Drop MP4 files here, or choose them. They’re copied into this account’s library (your originals stay untouched); duplicates are skipped.</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const r = await bridge.chooseQueueVideos(account.id, false);
                  if (r.ok && r.data.canceled) return;
                  if (!r.ok) return setNotice(errNotice(r.error));
                  if (!r.data.canceled) afterImport({ ok: true, data: { result: r.data.result, view: r.data.view } });
                }}
              >
                Choose MP4 files…
              </button>
              <button
                type="button"
                onClick={async () => {
                  const r = await bridge.chooseQueueVideos(account.id, true);
                  if (r.ok && r.data.canceled) return;
                  if (!r.ok) return setNotice(errNotice(r.error));
                  if (!r.data.canceled) afterImport({ ok: true, data: { result: r.data.result, view: r.data.view } });
                }}
              >
                Choose a folder…
              </button>
            </div>
          </section>

          <References accountId={account.id} references={view.references} onNotice={setNotice} onView={setView} onStudio={props.onStudio} />

          <section className="card" aria-labelledby="gq-list-title">
            <h3 id="gq-list-title">3. Queue</h3>
            <div className="filters" role="tablist">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'primary' : ''} onClick={() => setFilter(f.key)}>
                  {f.label} ({view.items.filter((i) => f.match(i.status)).length})
                </button>
              ))}
            </div>
            {shown.length === 0 && <p className="muted small">Nothing here.</p>}
            <div data-testid="gq-items">
              {shown.map((i) => (
                <QueueCard key={`${i.id}:${i.updatedAt}`} accountId={account.id} item={i} act={act} onNotice={setNotice} />
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function AnalysisBox(props: { status: PostingQueueView['analysis']; failed: number; onSaved: () => Promise<void>; onNotice: (n: Notice) => void; onRetry: () => void }): React.JSX.Element {
  const s = props.status;
  const [model, setModel] = useState(s.model === 'synthetic' ? 'gemini-3.8-flash' : s.model);
  const [cost, setCost] = useState(String(s.costPerCallUsd));
  const [budget, setBudget] = useState(String(s.monthlyBudgetUsd));
  const [key, setKey] = useState('');
  return (
    <details className="card settings" data-testid="gq-ai" open={!s.ready}>
      <summary>
        <strong>AI analysis settings</strong>{' '}
        <span className="small muted">
          {s.synthetic ? 'test analyzer (no cost)' : s.keySet ? `${s.model} · key saved` : 'not set up: add a Gemini API key'} · this month ${s.spentThisMonthUsd.toFixed(2)} / ${s.monthlyBudgetUsd.toFixed(2)} (
          {s.callsThisMonth} calls, estimate)
        </span>
        {props.failed > 0 && (
          <button
            type="button"
            className="link"
            onClick={(e) => {
              e.preventDefault();
              props.onRetry();
            }}
          >
            Retry failed ({props.failed})
          </button>
        )}
      </summary>
      <p className="small muted">
        Each video is uploaded to the Gemini API (Google, paid with your key) to write its caption, then deleted there. The key is sealed by Windows and never shown
        again. Costs here are your estimate per call; analysis stops when the monthly budget is reached.
      </p>
      <div className="form-grid">
        <label>
          Model
          <input aria-label="Analysis model" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
        </label>
        <label>
          Cost per analysis (USD)
          <input aria-label="Cost per analysis" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label>
          Monthly budget (USD)
          <input aria-label="Monthly analysis budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label className="wide2">
          Gemini API key {s.keySet ? '(saved; leave empty to keep it)' : ''}
          <input aria-label="Gemini API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            const r = await bridge.saveAnalysisSettings({ model: model.trim(), costPerCallUsd: Number(cost), monthlyBudgetUsd: Number(budget) }, key);
            if (!r.ok) return props.onNotice(errNotice(r.error));
            setKey('');
            props.onNotice({ tone: 'ok', text: 'Analysis settings saved.' });
            await props.onSaved();
          }}
        >
          Save
        </button>
        {s.keySet && (
          <button
            type="button"
            className="link"
            onClick={async () => {
              await bridge.removeAnalysisKey();
              await props.onSaved();
            }}
          >
            remove key
          </button>
        )}
      </div>
    </details>
  );
}

function References(props: { accountId: string; references: FypReference[]; onNotice: (n: Notice) => void; onView: (v: PostingQueueView) => void; onStudio: () => void }): React.JSX.Element {
  const [rights, setRights] = useState(false);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [count, setCount] = useState('3');
  const [busy, setBusy] = useState(false);
  const latest = props.references[0];
  return (
    <section className="card" aria-labelledby="gq-ref-title" data-testid="gq-references">
      <h3 id="gq-ref-title">2. New videos from FYP references</h3>
      <p className="small muted">
        Add 1–5 videos of a format that’s doing well on the FYP (files you saved yourself). The AI breaks down the hook, beats and pacing, then writes original prompts
        in that format, never copies. They go to Prompt Studio’s queue for Flow; finished videos come back here with captions. Or use a template in Prompt Studio.
      </p>
      <label className="inline small">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> These are reference files I may use for analysis
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={!rights}
          onClick={async () => {
            const r = await bridge.addFypReferences(props.accountId, true);
            if (!r.ok) return props.onNotice(errNotice(r.error));
            if (!r.data.canceled) setAssetIds([...assetIds, ...r.data.assetIds].slice(0, 5));
          }}
        >
          Add reference videos… {assetIds.length > 0 ? `(${assetIds.length})` : ''}
        </button>
        <input aria-label="Reference note" className="wide-target" placeholder="optional note: what to keep (e.g. the reveal at the end)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          type="button"
          className="primary"
          disabled={assetIds.length === 0 || busy}
          onClick={async () => {
            setBusy(true);
            props.onNotice({ tone: 'ok', text: 'Analyzing the references…' });
            const r = await bridge.analyzeFypReferences(props.accountId, assetIds, note);
            setBusy(false);
            if (!r.ok) return props.onNotice(errNotice(r.error));
            props.onView(r.data.view);
            setAssetIds([]);
            props.onNotice({ tone: 'ok', text: 'Format analyzed. Choose how many original videos to make.' });
          }}
        >
          Analyze format
        </button>
        <button type="button" className="link" onClick={props.onStudio}>
          or use a template in Prompt Studio
        </button>
      </div>
      {latest && (
        <div className="reference-analysis small" data-testid="gq-analysis">
          <div>
            <strong>Format:</strong> {latest.analysis.format}
          </div>
          <div>
            <strong>Hook:</strong> {latest.analysis.hook}
          </div>
          <div>
            <strong>Beats:</strong> {latest.analysis.structure.join(' → ')}
          </div>
          <div>
            <strong>Pacing:</strong> {latest.analysis.pacing}
          </div>
          <div className="actions">
            <label className="inline">
              Original videos{' '}
              <input aria-label="How many original videos" className="target" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await bridge.makeFypVariations(props.accountId, latest.id, Number(count));
                setBusy(false);
                if (!r.ok) return props.onNotice(errNotice(r.error));
                props.onNotice({ tone: 'ok', text: `${r.data.prompts} original prompts are in Prompt Studio’s queue. Open Prompt Studio to send them to Flow; finished videos land here.` });
              }}
            >
              Write original prompts
            </button>
            <button type="button" onClick={props.onStudio}>
              Open Prompt Studio
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function QueueCard(props: {
  accountId: string;
  item: QueueItem;
  act: (p: ReturnType<typeof bridge.queueItemAction>, ok?: string) => Promise<boolean>;
  onNotice: (n: Notice) => void;
}): React.JSX.Element {
  const { item: i, accountId, act } = props;
  const [caption, setCaption] = useState(i.caption);
  const [tags, setTags] = useState(i.hashtags.join(' '));
  const [note, setNote] = useState(i.note);
  const [link, setLink] = useState('');
  const changed = caption !== i.caption || tags !== i.hashtags.join(' ');
  const editable = i.status !== 'posted' && i.status !== 'analyzing';
  return (
    <article className="queue-card" data-status={i.status} data-source={i.source} data-name={i.originalName}>
      <div className="queue-media">
        <Player src={`/media/job/${i.jobId}`} label={i.originalName} />
      </div>
      <div className="queue-body">
        <header className="prompt-head">
          <Badge tone={STATUS[i.status].tone} value={i.status} testId="gq-status">
            {STATUS[i.status].label}
          </Badge>
          <Badge tone="muted">{i.source === 'ready_made' ? 'Ready-made' : 'AI-generated'}</Badge>
          <span className="small muted mono">{i.originalName}</span>
        </header>
        {i.flags.length > 0 && (
          <ul className="small warn-text" data-testid="gq-flags">
            {i.flags.map((f) => (
              <li key={f} data-flag={f}>
                {describeField(f)}
              </li>
            ))}
          </ul>
        )}
        {i.analysisError && <div className="small warn-text">{describeField(i.analysisError)}</div>}
        {i.summary && <div className="small muted">AI saw: {i.summary}</div>}
        {editable ? (
          <>
            <textarea aria-label="Caption" rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} />
            <input aria-label="Hashtags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#hashtags" />
          </>
        ) : (
          <div className="small" data-testid="gq-caption">
            {i.caption} <span className="muted">{i.hashtags.join(' ')}</span>
          </div>
        )}
        <div className="actions">
          {editable && changed && (
            <button type="button" className="primary" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'caption', { caption, hashtags: tags.split(/\s+/).filter(Boolean) }), 'Caption saved.')}>
              Save caption
            </button>
          )}
          {i.status === 'needs_review' && !changed && i.caption && (
            <button type="button" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'approve'))}>
              Caption is fine
            </button>
          )}
          {i.status === 'ready' && (
            <>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const r = await bridge.openTikTokUpload(accountId, i.id);
                  props.onNotice(
                    r.ok
                      ? { tone: 'ok', text: 'TikTok’s upload page is open in this account’s window. Drag the video in from the folder that opened, paste the caption (it’s copied), switch on the AI-generated label if it applies, and post. Then press “I posted it”.' }
                      : errNotice(r.error),
                  );
                }}
              >
                Post on TikTok…
              </button>
              <input aria-label="Post link (optional)" className="wide-target" placeholder="post link (optional)" value={link} onChange={(e) => setLink(e.target.value)} />
              <button type="button" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'posted', { postUrl: link.trim() }), 'Marked as posted.')}>
                I posted it
              </button>
            </>
          )}
          {i.status === 'posted' && (
            <button type="button" className="link" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'undo_posted'))}>
              undo posted
            </button>
          )}
          {(i.status === 'needs_review' || i.status === 'analysis_failed' || i.status === 'ready') && (
            <>
              <input aria-label="Note for the AI" className="wide-target" placeholder="note for the AI (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'reanalyze', { note }), 'Writing the caption again.')}>
                Write caption again
              </button>
            </>
          )}
          {editable && i.status !== 'rejected' && (
            <button type="button" className="link" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'reject'))}>
              reject
            </button>
          )}
          {i.status === 'rejected' && (
            <button type="button" className="link" onClick={() => void act(bridge.queueItemAction(accountId, i.id, 'restore'))}>
              restore
            </button>
          )}
        </div>
        {i.status === 'posted' && (
          <div className="small muted">
            Posted (marked by you) {i.postedAt ? new Date(i.postedAt).toLocaleString() : ''} {i.postUrl ? `· ${i.postUrl}` : ''}
          </div>
        )}
      </div>
    </article>
  );
}
