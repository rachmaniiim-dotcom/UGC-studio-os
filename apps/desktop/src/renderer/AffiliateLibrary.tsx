import { useCallback, useEffect, useState } from 'react';
import { bridge, type Account, type AffiliateVideoView } from './bridge.js';
import { Badge } from './Badge.js';
import { CLIP_STATUS, errNotice, NoticeBox, PLAN_STATUS, Player } from './AffiliateStudio.js';

// Affiliate Video Library (A2): every video of this account past the plan
// draft, with its product (ID and Showcase state), the Flow account and
// attempts of each clip, the source clips and the finished MP4.

type Notice = Parameters<typeof NoticeBox>[0]['notice'];
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Waiting for review' },
  { key: 'final_approved', label: 'Approved' },
  { key: 'producing', label: 'In production' },
] as const;

export function AffiliateLibrary(props: { account: Account | null; onBack: () => Promise<void>; onOpenProduct: (productRowId: string) => void }): React.JSX.Element {
  const { account } = props;
  const [videos, setVideos] = useState<AffiliateVideoView[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [notice, setNotice] = useState<Notice>(null);
  const load = useCallback(async () => {
    if (!account) return;
    const r = await bridge.affiliateLibrary(account.id);
    if (r.ok) setVideos(r.data.videos);
    else setNotice(errNotice(r.error));
  }, [account]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!account) return <p className="muted">Account not found.</p>;
  const shown = (videos ?? []).filter((v) => filter === 'all' || v.status === filter || (filter === 'producing' && (v.status === 'approved' || v.status === 'stitching')));
  return (
    <section className="alibrary" aria-label="Affiliate Video Library">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Video library · {account.displayName}</h2>
          <p className="muted small">Each finished video with its product, the Flow account behind each clip, the source clips and the joined MP4.</p>
        </div>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <NoticeBox notice={notice} testId="alibrary-notice" />
      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'primary' : ''} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      {videos && shown.length === 0 && <p className="muted">No videos here yet.</p>}
      <div data-testid="library-videos">
        {shown.map((v) => (
          <article key={v.id} className="library-card" data-video-id={v.id} data-status={v.status}>
            <header className="prompt-head">
              <strong>{v.productTitle}</strong>
              <span className="mono small muted">{v.productId}</span>
              <Badge tone={v.showcase.startsWith('added') ? 'ok' : 'warn'}>Showcase: {v.showcase.replace(/_/g, ' ')}</Badge>
              <Badge tone={PLAN_STATUS[v.status].tone} value={v.status}>
                {PLAN_STATUS[v.status].label}
              </Badge>
              <Badge tone="muted">{v.continuity === 'seamless' ? 'Seamless' : 'Comedic cut'}</Badge>
              <span className="small muted">
                #{v.position} · {account.displayName} · {new Date(v.updatedAt).toLocaleString()}
              </span>
            </header>
            <div className="library-media">
              {v.clips.map((c) => (
                <div key={c.id} className="small" data-clip-slot={c.slot}>
                  <div>
                    <strong>Clip {c.slot}</strong> <Badge tone={CLIP_STATUS[c.status].tone}>{CLIP_STATUS[c.status].label}</Badge>
                  </div>
                  <div className="muted">
                    {c.flowName ? `Flow: ${c.flowName}` : 'Flow: —'} · attempts {c.attempts} · {c.credits} credits
                  </div>
                  {c.jobId && (c.status === 'received' || c.status === 'approved') && <Player src={`/media/job/${c.jobId}`} label={`Clip ${c.slot}`} />}
                </div>
              ))}
              <div className="small" data-testid="library-final">
                <strong>Finished video</strong>
                {v.final ? (
                  <>
                    <div className="muted">
                      {v.final.durationSeconds.toFixed(1)} s · {v.final.width}×{v.final.height}
                    </div>
                    <Player src={`/media/final/${v.id}`} label="Finished video" />
                    <button type="button" onClick={() => void bridge.revealFinalVideo(account.id, v.id)}>
                      Show in folder
                    </button>
                  </>
                ) : (
                  <div className="muted">Not joined yet.</div>
                )}
              </div>
            </div>
            {v.reviewNote && <div className="small warn-text">Last rejection: {v.reviewNote.replace(/_/g, ' ')}</div>}
            <div className="actions">
              <button type="button" onClick={() => props.onOpenProduct(v.productRowId)}>
                Open in Create videos
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
