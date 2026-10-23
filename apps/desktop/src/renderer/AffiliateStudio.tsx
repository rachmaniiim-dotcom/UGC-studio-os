import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  describeError,
  describeField,
  type Account,
  type AffiliateCreativeConfig,
  type AffiliateStudioView,
  type AffiliateVideoView,
  type ClipView,
  type PoolAccount,
  type VideoPlanStatus,
} from './bridge.js';
import { Badge } from './Badge.js';

// Affiliate Creative Studio (A2): for one product, plans of finished videos
// (Clip A: hook + demonstration; Clip B: comedic payoff + CTA, as a seamless
// continuation or a deliberate cut). You approve a plan before any Flow
// credits are spent, make both clips by hand in Google Flow, and the app
// joins them with your local FFmpeg into one ~16-second video for review.

type Notice = { tone: 'ok' | 'bad' | 'warn'; text: string; fields?: string[] } | null;
type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: string[] } };

export const PLAN_STATUS: Record<VideoPlanStatus, { label: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  draft: { label: 'Plan draft', tone: 'muted' },
  approved: { label: 'Plan approved', tone: 'ok' },
  rejected: { label: 'Plan rejected', tone: 'bad' },
  producing: { label: 'Clips in production', tone: 'warn' },
  stitching: { label: 'Joining clips…', tone: 'warn' },
  review: { label: 'Waiting for your review', tone: 'warn' },
  final_approved: { label: 'Approved video', tone: 'ok' },
};
export const CLIP_STATUS: Record<ClipView['status'], { label: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  waiting: { label: 'Not made yet', tone: 'muted' },
  in_flow: { label: 'In Google Flow', tone: 'warn' },
  received: { label: 'Received', tone: 'ok' },
  unusable: { label: 'Unusable', tone: 'bad' },
  approved: { label: 'Approved clip', tone: 'ok' },
};
const FAILURE_LABELS: Record<string, string> = { refused: 'Flow refused the prompt', render_error: 'Render error', no_output: 'No video came out', other: 'Other' };
const UNUSABLE_LABELS: Record<string, string> = {
  wrong_product: 'Wrong or changed product',
  artifacts: 'Visual artifacts',
  audio: 'Audio problem',
  continuity: 'Continuity problem',
  off_script: 'Off script',
  other: 'Other',
};
const BLOCKING = ['product_block_missing', 'character_missing', 'unresolved_placeholder', 'too_long', 'unverified_claim'];
const POOLS: Array<{ key: keyof AffiliateCreativeConfig; label: string }> = [
  { key: 'characters', label: 'Characters (one per line; add your own)' },
  { key: 'reactors', label: 'Reactors for cut scenes' },
  { key: 'povs', label: 'Camera / POV' },
  { key: 'hooks', label: 'Visual hooks' },
  { key: 'setups', label: 'Comedic setups' },
  { key: 'locations', label: 'Locations' },
  { key: 'punchlines', label: 'Punchline endings' },
];

export const errNotice = (e: { code: string; details?: string[] }): Notice => {
  const d = describeError(e.code);
  return { tone: 'bad', text: `${d.message} ${d.recovery}`, fields: e.details ?? [] };
};

export function NoticeBox(props: { notice: Notice; testId: string }): React.JSX.Element | null {
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

/** Plays a library file through the app's read-only /media/ path. */
export function Player(props: { src: string; label: string }): React.JSX.Element {
  return <video className="player" controls preload="metadata" src={props.src} aria-label={props.label} />;
}

export function AffiliateStudio(props: { account: Account | null; productRowId: string; onBack: () => Promise<void>; onLibrary: () => void }): React.JSX.Element {
  const { account, productRowId } = props;
  const [view, setView] = useState<AffiliateStudioView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [flows, setFlows] = useState<PoolAccount[]>([]);
  const [flowChoice, setFlowChoice] = useState<string>('pool');

  const loadFlows = useCallback(async () => {
    const [p, o] = await Promise.all([bridge.flowPool(), bridge.flowOthers()]);
    const pools = p.ok ? p.data : [];
    const own = o.ok ? o.data : [];
    setFlows([...pools, ...own]);
    // With no pool account, start from the first configured Flow session instead.
    setFlowChoice((c) => (c === 'pool' && pools.length === 0 && own.length > 0 ? own[0]!.id : c));
  }, []);
  const load = useCallback(async () => {
    if (!account) return;
    const r = await bridge.affiliateStudioView(account.id, productRowId);
    if (r.ok) setView(r.data);
    else setNotice(errNotice(r.error));
    await loadFlows();
  }, [account, productRowId, loadFlows]);
  useEffect(() => {
    void load();
  }, [load]);
  // While a clip is in Flow or clips are being joined, refresh until the file arrives.
  const busy = view?.videos.some((v) => v.status === 'stitching' || v.clips.some((c) => c.status === 'in_flow')) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [busy, load]);

  if (!account) return <p className="muted">Account not found.</p>;
  const call = async (p: Promise<Result<AffiliateStudioView>>, ok?: string): Promise<boolean> => {
    const r = await p;
    if (!r.ok) {
      setNotice(errNotice(r.error));
      return false;
    }
    setNotice(ok ? { tone: 'ok', text: ok } : null);
    setView(r.data);
    void loadFlows();
    return true;
  };
  const flowTarget = flowChoice === 'pool' ? null : flowChoice;
  const product = view?.product;

  return (
    <section className="astudio" aria-label="Affiliate Creative Studio">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← Products
          </button>
          <h2>Create videos · {product?.title || 'product'}</h2>
          {product && (
            <p className="small">
              <span className="mono muted">{product.productId}</span> · {product.summary} ·{' '}
              <Badge tone={product.showcase.startsWith('added') ? 'ok' : 'warn'} value={product.showcase}>
                Showcase: {product.showcase.replace(/_/g, ' ')}
              </Badge>
            </p>
          )}
          <p className="muted small">
            Each finished video = Clip A (8 s: hook + demonstration) + Clip B (8 s: comedic payoff + CTA), joined into ~16 s with your local FFmpeg. Nothing is spent
            before you approve a plan; clips are made by you in Google Flow.
          </p>
        </div>
        <button type="button" onClick={props.onLibrary}>
          Video library
        </button>
      </div>
      <NoticeBox notice={notice} testId="astudio-notice" />
      {view && product && (
        <>
          {product.readiness.length > 0 && (
            <div className="notice warn" data-testid="readiness">
              Not ready for plans yet:
              <ul>
                {product.readiness.map((r) => (
                  <li key={r}>{describeField(r)}</li>
                ))}
              </ul>
            </div>
          )}
          {!view.ffmpeg.available && <div className="notice warn">FFmpeg wasn’t found, so clips can’t be checked or joined. Install FFmpeg and restart the app.</div>}
          <Settings accountId={account.id} productRowId={productRowId} view={view} call={call} />
          <section className="card" aria-labelledby="flow-title">
            <h3 id="flow-title">Flow account for the next clip</h3>
            <div className="actions">
              <select aria-label="Flow account" value={flowChoice} onChange={(e) => setFlowChoice(e.target.value)}>
                <option value="pool" disabled={!flows.some((f) => f.pool)}>
                  {flows.some((f) => f.pool) ? 'Flow pool: the account with the most credits' : 'Flow pool (no pool accounts)'}
                </option>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.displayName} ({f.pool ? 'pool' : 'own session'}) · {f.remaining} left
                    {f.settings.dailyCreditLimit !== null ? ` · today ${f.usedToday}/${f.settings.dailyCreditLimit}` : ''}
                  </option>
                ))}
              </select>
              <span className="small muted">
                {flows.length === 0
                  ? 'No Flow account yet: import or confirm a Google Flow session on any account (or add a Flow pool account).'
                  : 'Credits are counted on the Flow account that renders each clip, never on this TikTok account. Limits are set on the Flow pool screen.'}
              </span>
            </div>
          </section>
          <section className="card" aria-labelledby="plans-title">
            <h3 id="plans-title">Plans</h3>
            {view.today && (
              <div className="summary" data-testid="astudio-today">
                <span>
                  <strong>
                    {view.today.startedToday}/{view.limits.videosPerProductPerDay}
                  </strong>{' '}
                  videos started today
                </span>
                <span>
                  <strong>{view.today.attempts}</strong> clip attempts
                </span>
                <span>
                  <strong>{view.today.generationFailed}</strong> failed renders
                </span>
                <span>
                  <strong>{view.today.unusable}</strong> unusable outputs
                </span>
                <span>
                  <strong>{view.today.clipsApproved}</strong> approved clips
                </span>
                <span>
                  <strong>{view.today.finalsApproved}</strong> approved videos
                </span>
              </div>
            )}
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={product.readiness.length > 0}
                onClick={async () => {
                  const r = await bridge.generateVideoPlans(account.id, productRowId);
                  if (!r.ok) return setNotice(errNotice(r.error));
                  setView(r.data.view);
                  const n = r.data.view.videos.filter((v) => v.batchId === r.data.batchId).length;
                  setNotice({ tone: 'ok', text: `${n} plan${n === 1 ? '' : 's'} created as drafts. Review and approve the ones to produce.` });
                }}
              >
                Generate {view.config.count} plans
              </button>
            </div>
            {view.videos.length === 0 && <p className="muted small">No plans yet.</p>}
            {view.videos.map((v) => (
              <PlanCard
                key={`${v.id}:${v.updatedAt}:${v.clips.map((c) => c.updatedAt).join()}`}
                accountId={account.id}
                productRowId={productRowId}
                v={v}
                limits={view.limits}
                flowTarget={flowTarget}
                call={call}
                onNotice={setNotice}
              />
            ))}
          </section>
        </>
      )}
    </section>
  );
}

function Settings(props: { accountId: string; productRowId: string; view: AffiliateStudioView; call: (p: Promise<Result<AffiliateStudioView>>, ok?: string) => Promise<boolean> }): React.JSX.Element {
  const { view } = props;
  const [c, setC] = useState(view.config);
  const [pools, setPools] = useState<Record<string, string>>(Object.fromEntries(POOLS.map((p) => [p.key, (view.config[p.key] as string[]).join('\n')])));
  const [hashtags, setHashtags] = useState(view.config.hashtags.join(' '));
  const [limits, setLimits] = useState({ maxClipAttempts: String(view.limits.maxClipAttempts), videosPerProductPerDay: String(view.limits.videosPerProductPerDay) });
  const [rights, setRights] = useState(false);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <details className="card settings" data-testid="astudio-settings">
      <summary>
        <strong>Creative settings and limits</strong> <span className="muted small">({c.count} plans · continuity: {c.continuity})</span>
      </summary>
      <div className="form-grid production-grid">
        <label>
          Plans per generation
          <input name="plan-count" inputMode="numeric" value={String(c.count)} onChange={(e) => setC({ ...c, count: Number(e.target.value) })} />
        </label>
        <label>
          Clip B continuity
          <select name="continuity" value={c.continuity} onChange={(e) => setC({ ...c, continuity: e.target.value as AffiliateCreativeConfig['continuity'] })}>
            <option value="mixed">Mixed (alternate)</option>
            <option value="seamless">Seamless: Clip B starts from Clip A’s last frame</option>
            <option value="cut">Comedic cut: new angle or reactor</option>
          </select>
        </label>
        <label className="wide2">
          Hashtags
          <input name="hashtags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        </label>
      </div>
      <div className="config-grid">
        {POOLS.map((p) => (
          <label key={p.key}>
            {p.label}
            <textarea name={`pool-${p.key}`} rows={4} value={pools[p.key]} onChange={(e) => setPools({ ...pools, [p.key]: e.target.value })} />
          </label>
        ))}
        <label className="wide">
          Look shared by both clips
          <textarea name="style" rows={2} value={c.style} onChange={(e) => setC({ ...c, style: e.target.value })} />
        </label>
        <label className="wide">
          Avoid
          <textarea name="avoid" rows={2} value={c.avoid} onChange={(e) => setC({ ...c, avoid: e.target.value })} />
        </label>
      </div>
      <h4>Product reference images</h4>
      <p className="muted small">Optional. Uploaded by you in Google Flow as the product ingredient for both clips; kept only on this computer.</p>
      <ul className="ref-list">
        {view.references.map((r) => (
          <li key={r.id}>
            <label className="checkbox">
              <input
                type="checkbox"
                name={`image-${r.name}`}
                checked={c.referenceAssetIds.includes(r.id)}
                onChange={(e) => setC({ ...c, referenceAssetIds: e.target.checked ? [...c.referenceAssetIds, r.id] : c.referenceAssetIds.filter((x) => x !== r.id) })}
              />
              {r.name}
            </label>
          </li>
        ))}
      </ul>
      <label className="checkbox">
        <input type="checkbox" name="image-rights" checked={rights} onChange={(e) => setRights(e.target.checked)} />I have the rights to use this product image (e.g. provided for
        affiliates)
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={!rights}
          onClick={async () => {
            const r = await bridge.addProductImage(props.accountId, true);
            if (r.ok && !r.data.canceled && r.data.assetId) {
              setC({ ...c, referenceAssetIds: [...c.referenceAssetIds, r.data.assetId] });
              setRights(false);
              void props.call(bridge.affiliateStudioView(props.accountId, props.productRowId));
            }
          }}
        >
          Add product image…
        </button>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void props.call(
              bridge.saveAffiliateCreative(props.accountId, props.productRowId, {
                ...c,
                ...(Object.fromEntries(POOLS.map((p) => [p.key, lines(pools[p.key] ?? '')])) as Partial<AffiliateCreativeConfig>),
                hashtags: hashtags.split(/\s+/).filter(Boolean),
              }),
              'Creative settings saved for this account.',
            )
          }
        >
          Save creative settings
        </button>
      </div>
      <h4>Limits for this account</h4>
      <div className="actions">
        <label className="inline">
          Attempts per clip
          <input className="target" name="max-attempts" value={limits.maxClipAttempts} onChange={(e) => setLimits({ ...limits, maxClipAttempts: e.target.value })} />
        </label>
        <label className="inline">
          Videos per product per day
          <input className="target" name="videos-per-product" value={limits.videosPerProductPerDay} onChange={(e) => setLimits({ ...limits, videosPerProductPerDay: e.target.value })} />
        </label>
        <button
          type="button"
          onClick={() =>
            void props.call(
              bridge.setAffiliateLimits(props.accountId, props.productRowId, { maxClipAttempts: Number(limits.maxClipAttempts), videosPerProductPerDay: Number(limits.videosPerProductPerDay) }),
              'Limits saved.',
            )
          }
        >
          Save limits
        </button>
      </div>
    </details>
  );
}

function PlanCard(props: {
  accountId: string;
  productRowId: string;
  v: AffiliateVideoView;
  limits: AffiliateStudioView['limits'];
  flowTarget: string | null;
  call: (p: Promise<Result<AffiliateStudioView>>, ok?: string) => Promise<boolean>;
  onNotice: (n: Notice) => void;
}): React.JSX.Element {
  const { v, accountId, productRowId, call } = props;
  const [editing, setEditing] = useState(false);
  const [a, setA] = useState(v.clipA.sections.map((s) => s.text));
  const [b, setB] = useState(v.clipB.sections.map((s) => s.text));
  const [caption, setCaption] = useState(v.caption);
  const [reason, setReason] = useState('continuity');
  const [redo, setRedo] = useState<'A' | 'B' | 'both'>('B');
  const blocking = v.flags.filter((f) => BLOCKING.includes(f));
  const production = ['approved', 'producing', 'stitching', 'review', 'final_approved'].includes(v.status);
  const bothIn = v.clips.every((c) => c.status === 'received');
  return (
    <article className={`plan-card status-${v.status}`} data-video-id={v.id} data-status={v.status} data-position={v.position}>
      <header className="prompt-head">
        <strong>#{v.position}</strong>
        <Badge tone={PLAN_STATUS[v.status].tone} testId="plan-status" value={v.status}>
          {PLAN_STATUS[v.status].label}
        </Badge>
        <Badge tone="muted" value={v.continuity}>
          {v.continuity === 'seamless' ? 'Seamless Clip B' : 'Comedic cut'}
        </Badge>
        {v.edited && <Badge tone="muted">edited</Badge>}
        {v.flags.map((f) => (
          <Badge key={f} tone={BLOCKING.includes(f) ? 'bad' : 'warn'} value={f}>
            {f === 'near_duplicate' ? `similar to #${v.duplicates.join(', #')}` : f.replace(/_/g, ' ')}
          </Badge>
        ))}
      </header>
      <div className="chips axes">
        {Object.entries(v.axes).map(([k, val]) => (
          <span key={k} className="axis" title={val}>
            {k}: {val.length > 40 ? `${val.slice(0, 40)}…` : val}
          </span>
        ))}
      </div>
      {editing ? (
        <div className="clip-columns">
          {(['A', 'B'] as const).map((slot) => {
            const content = slot === 'A' ? v.clipA : v.clipB;
            const texts = slot === 'A' ? a : b;
            const set = slot === 'A' ? setA : setB;
            return (
              <div key={slot} className="prompt-edit">
                <strong>Clip {slot}</strong>
                {content.sections.map((s, k) => (
                  <label key={s.key}>
                    {s.title}
                    <textarea name={`edit-${slot}-${s.key}`} rows={3} value={texts[k]} onChange={(e) => set(texts.map((x, j) => (j === k ? e.target.value : x)))} />
                  </label>
                ))}
              </div>
            );
          })}
          <label className="wide">
            Caption
            <textarea name="edit-caption" rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={async () => {
                const ok = await call(
                  bridge.updateVideoPlan(accountId, productRowId, v.id, {
                    clipA: v.clipA.sections.map((s, k) => ({ key: s.key, text: a[k]! })),
                    clipB: v.clipB.sections.map((s, k) => ({ key: s.key, text: b[k]! })),
                    caption,
                  }),
                );
                if (ok) setEditing(false);
              }}
            >
              Save edit
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="clip-columns">
            <div>
              <strong className="small">Clip A · 8 s · hook + demonstration</strong>
              <pre className="prompt-text" data-testid="clip-a-text">
                {v.textA}
              </pre>
            </div>
            <div>
              <strong className="small">Clip B · 8 s · payoff + CTA</strong>
              <pre className="prompt-text" data-testid="clip-b-text">
                {v.textB}
              </pre>
            </div>
          </div>
          <div className="small">
            <span className="muted">Caption:</span> {v.caption}
          </div>
        </>
      )}
      {blocking.length > 0 && <p className="small bad-text">Can’t be approved until edited: {blocking.map((f) => describeField(f)).join(' ')}</p>}
      {!editing && v.status === 'draft' && (
        <div className="actions">
          <button type="button" className="primary" disabled={blocking.length > 0} onClick={() => void call(bridge.videoPlanAction(accountId, productRowId, v.id, 'approve'))}>
            Approve plan
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="danger-outline" onClick={() => void call(bridge.videoPlanAction(accountId, productRowId, v.id, 'reject'))}>
            Reject
          </button>
        </div>
      )}
      {!editing && (v.status === 'rejected' || v.status === 'approved') && (
        <div className="actions">
          <button type="button" onClick={() => void call(bridge.videoPlanAction(accountId, productRowId, v.id, 'reopen'))}>
            Back to draft
          </button>
          {v.status === 'approved' && (
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
      )}
      {production && (
        <div className="clip-columns production">
          {v.clips.map((c) => (
            <ClipCard key={c.id} accountId={accountId} productRowId={productRowId} c={c} max={props.limits.maxClipAttempts} flowTarget={props.flowTarget} call={call} onNotice={props.onNotice} />
          ))}
        </div>
      )}
      {v.lastError && (
        <p className="small bad-text" data-testid="stitch-error">
          Joining failed: {describeField(v.lastError.split(':')[0]!)} <span className="mono">{v.lastError}</span>
        </p>
      )}
      {v.status === 'producing' && bothIn && (
        <div className="actions">
          <button type="button" onClick={() => void call(bridge.stitchVideo(accountId, productRowId, v.id))}>
            Join clips again
          </button>
        </div>
      )}
      {v.status === 'stitching' && <p className="small muted">Joining Clip A and Clip B with FFmpeg…</p>}
      {(v.status === 'review' || v.status === 'final_approved') && v.final && (
        <div className="final-box" data-testid="final">
          <Player src={`/media/final/${v.id}`} label={`Finished video #${v.position}`} />
          <div className="small">
            <div>
              <strong>Finished video</strong> · {v.final.durationSeconds.toFixed(1)} s · {v.final.width}×{v.final.height} · {(v.final.bytes / 1024 / 1024).toFixed(1)} MB
            </div>
            {v.status === 'review' ? (
              <div className="actions">
                <button type="button" className="primary" onClick={() => void call(bridge.reviewVideo(accountId, productRowId, v.id, { approve: true }), 'Video approved.')}>
                  Approve video
                </button>
                <select aria-label="Reject reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {Object.entries(UNUSABLE_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <select aria-label="Clip to redo" value={redo} onChange={(e) => setRedo(e.target.value as 'A' | 'B' | 'both')}>
                  <option value="A">Redo Clip A</option>
                  <option value="B">Redo Clip B</option>
                  <option value="both">Redo both</option>
                </select>
                <button type="button" className="danger-outline" onClick={() => void call(bridge.reviewVideo(accountId, productRowId, v.id, { approve: false, reason, redo }))}>
                  Reject video
                </button>
              </div>
            ) : (
              <div className="actions">
                <Badge tone="ok">Approved</Badge>
                <button type="button" onClick={() => void bridge.revealFinalVideo(accountId, v.id)}>
                  Show in folder
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function ClipCard(props: {
  accountId: string;
  productRowId: string;
  c: ClipView;
  max: number;
  flowTarget: string | null;
  call: (p: Promise<Result<AffiliateStudioView>>, ok?: string) => Promise<boolean>;
  onNotice: (n: Notice) => void;
}): React.JSX.Element {
  const { c, accountId, productRowId, call } = props;
  const [failReason, setFailReason] = useState('render_error');
  const [unusable, setUnusable] = useState('artifacts');
  const canSend = c.status === 'waiting' || c.status === 'unusable';
  const importClip = async (): Promise<void> => {
    const r = await bridge.importClip(accountId, productRowId, c.id);
    if (!r.ok) return props.onNotice(errNotice(r.error));
    if (r.data.view) await call(Promise.resolve({ ok: true, data: r.data.view }));
  };
  return (
    <div className="clip-card" data-clip-slot={c.slot} data-clip-status={c.status}>
      <div className="prompt-head">
        <strong>Clip {c.slot}</strong>
        <Badge tone={CLIP_STATUS[c.status].tone} testId="clip-status" value={c.status}>
          {CLIP_STATUS[c.status].label}
        </Badge>
        <span className="small muted">
          attempts {c.attempts}/{props.max} · {c.credits} credits{c.flowName ? ` · Flow: ${c.flowName}` : ''}
        </span>
      </div>
      {c.lastReason && <div className="small warn-text">Last: {c.lastReason.replace(/_/g, ' ')}</div>}
      {c.manualSteps.length > 0 && (c.status === 'waiting' || c.status === 'in_flow' || c.status === 'unusable') && (
        <ul className="manual-steps small">
          {c.manualSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {(c.status === 'received' || c.status === 'approved') && c.jobId && <Player src={`/media/job/${c.jobId}`} label={`Clip ${c.slot}`} />}
      <div className="actions">
        {canSend && (
          <button type="button" className="primary" onClick={() => void call(bridge.handOffClip(accountId, productRowId, c.id, props.flowTarget), `Clip ${c.slot} prompt copied; Flow opened.`)}>
            Send to Flow
          </button>
        )}
        {c.status === 'in_flow' && (
          <>
            <button type="button" onClick={() => void bridge.copyClipPrompt(accountId, c.id)}>
              Copy prompt again
            </button>
            <select aria-label={`Failure reason for Clip ${c.slot}`} value={failReason} onChange={(e) => setFailReason(e.target.value)}>
              {Object.entries(FAILURE_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void call(bridge.clipFailed(accountId, productRowId, c.id, failReason))}>
              Flow failed
            </button>
          </>
        )}
        {(canSend || c.status === 'in_flow') && (
          <button type="button" onClick={() => void importClip()}>
            Import clip file…
          </button>
        )}
        {c.status === 'received' && (
          <>
            {c.slot === 'A' && (
              <button type="button" onClick={() => void bridge.exportLastFrame(accountId, c.id).then((r) => !r.ok && props.onNotice(errNotice(r.error)))}>
                Export last frame
              </button>
            )}
            <select aria-label={`Unusable reason for Clip ${c.slot}`} value={unusable} onChange={(e) => setUnusable(e.target.value)}>
              {Object.entries(UNUSABLE_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button type="button" className="danger-outline" onClick={() => void call(bridge.markClipUnusable(accountId, productRowId, c.id, unusable))}>
              Unusable
            </button>
          </>
        )}
      </div>
    </div>
  );
}
