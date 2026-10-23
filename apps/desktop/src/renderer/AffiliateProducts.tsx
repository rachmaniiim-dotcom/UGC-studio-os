import { useCallback, useEffect, useState } from 'react';
import { bridge, describeError, describeField, type Account, type AffiliateProduct, type AffiliateView, type ShowcaseState } from './bridge.js';
import { Badge } from './Badge.js';

// Affiliate Products (A1): products for one affiliate account by TikTok
// product ID, today's selection, the listing check, and the assisted Showcase
// flow. The app opens pages in this account's own windows; you act with
// TikTok's own controls, and "added" is only ever recorded as confirmed by you
// (from TikTok's Showcase list) or, later, by TikTok's official API.

type Notice = { tone: 'ok' | 'bad' | 'warn'; text: string; fields?: string[] } | null;

const SHOWCASE: Record<ShowcaseState, { label: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  not_requested: { label: 'Not in Showcase', tone: 'muted' },
  in_progress: { label: 'Adding in TikTok…', tone: 'warn' },
  added_seen_by_you: { label: 'Added: TikTok confirmation seen by you', tone: 'ok' },
  added_confirmed_by_tiktok: { label: 'Added: confirmed by TikTok', tone: 'ok' },
  not_eligible: { label: 'Not eligible', tone: 'bad' },
  failed: { label: 'Adding failed', tone: 'bad' },
  removed: { label: 'Removed from Showcase', tone: 'muted' },
};
const LISTING = { unverified: { label: 'Listing not checked', tone: 'warn' }, confirmed: { label: 'Exact listing confirmed', tone: 'ok' }, mismatch: { label: 'Wrong listing', tone: 'bad' } } as const;

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

type Call = (p: Promise<{ ok: true; data: AffiliateView } | { ok: false; error: { code: string; details?: string[] } }>) => Promise<boolean>;

export function AffiliateProducts(props: {
  account: Account | null;
  onBack: () => Promise<void>;
  onCreateVideos: (productRowId: string) => void;
  onLibrary: () => void;
}): React.JSX.Element {
  const { account } = props;
  const [view, setView] = useState<AffiliateView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [text, setText] = useState('');
  const [limit, setLimit] = useState('');

  const apply = (v: AffiliateView): void => {
    setView(v);
    setLimit(String(v.dailyLimit));
  };
  const load = useCallback(async () => {
    if (!account) return;
    const r = await bridge.affiliateView(account.id);
    if (r.ok) apply(r.data);
    else setNotice(errNotice(r.error));
  }, [account]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!account) return <p className="muted">Account not found.</p>;
  const call: Call = async (p) => {
    const r = await p;
    if (!r.ok) {
      setNotice(errNotice(r.error));
      return false;
    }
    setNotice(null);
    apply(r.data);
    return true;
  };
  const kalodata = account.sessions.find((s) => s.platformId === 'kalodata');
  const today = view?.products.filter((p) => p.selectedToday) ?? [];
  const others = view?.products.filter((p) => !p.selectedToday) ?? [];

  return (
    <section className="affiliate" aria-label="Affiliate Products">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Products · {account.displayName}</h2>
          <button type="button" onClick={props.onLibrary}>
            Video library
          </button>
          <p className="muted small">
            Pick today’s products, check each exact TikTok listing, and add them to this account’s Showcase with TikTok’s own controls. Pages open in this account’s
            windows (its proxy and session). Only product IDs are stored; no Kalodata data.
          </p>
        </div>
      </div>
      <NoticeBox notice={notice} testId="affiliate-notice" />
      {view && (
        <>
          <div className="summary" data-testid="affiliate-summary">
            <span>
              <strong>
                {view.selectedToday}/{view.dailyLimit}
              </strong>{' '}
              selected for today
            </span>
            <span>
              <strong>{view.products.filter((p) => p.showcase === 'added_seen_by_you' || p.showcase === 'added_confirmed_by_tiktok').length}</strong> in Showcase
            </span>
            <span>
              <strong>{view.products.length}</strong> products
            </span>
            <label className="inline small">
              Daily limit{' '}
              <input className="target" aria-label="Daily product limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
              {limit !== String(view.dailyLimit) && (
                <button type="button" className="link" onClick={() => void call(bridge.setDailyProducts(account.id, Number(limit)))}>
                  save
                </button>
              )}
            </label>
          </div>

          <section className="card" aria-labelledby="capture-title">
            <h3 id="capture-title">Add products</h3>
            <div className="actions">
              {kalodata && (
                <button type="button" onClick={() => void bridge.openSite(kalodata.id, 'home').then((r) => !r.ok && setNotice(errNotice(r.error)))}>
                  Open Kalodata
                </button>
              )}
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const r = await bridge.captureProductFromResearch(account.id);
                  if (!r.ok) return setNotice(errNotice(r.error));
                  apply(r.data.view);
                  setNotice({ tone: 'ok', text: r.data.outcome === 'added' ? `Product ${r.data.productId} added.` : `Product ${r.data.productId} was already listed.` });
                }}
              >
                Use the product open in Kalodata
              </button>
            </div>
            <p className="muted small">Takes only the product ID from the Kalodata window’s address. Or paste TikTok product links or IDs (one per line):</p>
            <textarea name="product-links" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://www.tiktok.com/view/product/1729…" spellCheck={false} />
            <div className="actions">
              <button
                type="button"
                disabled={text.trim() === ''}
                onClick={async () => {
                  const r = await bridge.addAffiliateProducts(account.id, text);
                  if (!r.ok) return setNotice(errNotice(r.error));
                  apply(r.data.view);
                  const { added, existing, rejected } = r.data.result;
                  setText(rejected.map((x) => x.input).join('\n'));
                  setNotice({
                    tone: rejected.length ? 'warn' : 'ok',
                    text: `${added.length} added, ${existing.length} already listed, ${rejected.length} not recognised${rejected.length ? ` (${rejected.map((x) => `line ${x.line}: ${describeField(x.issue)}`).join('; ')})` : ''}.`,
                  });
                }}
              >
                Add products
              </button>
            </div>
          </section>

          <section className="card" aria-labelledby="today-title">
            <h3 id="today-title">Today’s selection</h3>
            {today.length === 0 ? (
              <p className="muted small">No product selected for today yet.</p>
            ) : (
              <div data-testid="today">
                {today.map((p) => (
                  <ProductCard key={`${p.id}:${p.updatedAt}`} accountId={account.id} p={p} call={call} onNotice={setNotice} onCreateVideos={props.onCreateVideos} />
                ))}
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="all-title">
            <h3 id="all-title">Other products</h3>
            {others.length === 0 ? (
              <p className="muted small">None.</p>
            ) : (
              <div data-testid="others">
                {others.map((p) => (
                  <ProductCard key={`${p.id}:${p.updatedAt}`} accountId={account.id} p={p} call={call} onNotice={setNotice} onCreateVideos={props.onCreateVideos} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function ProductCard(props: { accountId: string; p: AffiliateProduct; call: Call; onNotice: (n: Notice) => void; onCreateVideos: (id: string) => void }): React.JSX.Element {
  const { p, accountId, call } = props;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({
    title: p.facts.title,
    shopName: p.facts.shopName,
    priceIdr: p.facts.priceIdr === null ? '' : String(p.facts.priceIdr),
    commissionPct: p.facts.commissionPct === null ? '' : String(p.facts.commissionPct),
    features: p.facts.features.join('\n'),
    references: p.facts.references.join('\n'),
    notes: p.facts.notes,
  });
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const confirmed = p.listing === 'confirmed';

  return (
    <article className="product-card" data-product-id={p.productId} data-showcase={p.showcase} data-listing={p.listing}>
      <header className="prompt-head">
        <strong>{p.facts.title || 'Untitled product'}</strong>
        <span className="mono small muted">{p.productId}</span>
        <Badge tone={LISTING[p.listing].tone} value={p.listing}>
          {LISTING[p.listing].label}
        </Badge>
        <Badge tone={SHOWCASE[p.showcase].tone} testId="showcase-state" value={p.showcase}>
          {SHOWCASE[p.showcase].label}
        </Badge>
        {p.eligibility !== 'unknown' && <Badge tone={p.eligibility === 'can_promote' ? 'ok' : 'bad'}>{p.eligibility === 'can_promote' ? 'Can promote' : 'Cannot promote'}</Badge>}
      </header>
      <div className="small" data-testid="product-summary">
        {p.summary}
      </div>
      {p.facts.features.length > 0 && (
        <ul className="small features">
          {p.facts.features.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="form-grid product-grid">
          <label className="wide2">
            Title (as on the listing)
            <input name="fact-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <label>
            Shop
            <input name="fact-shop" value={f.shopName} onChange={(e) => setF({ ...f, shopName: e.target.value })} />
          </label>
          <label>
            Price (Rp)
            <input name="fact-price" inputMode="numeric" value={f.priceIdr} onChange={(e) => setF({ ...f, priceIdr: e.target.value })} />
          </label>
          <label>
            Commission (%)
            <input name="fact-commission" inputMode="decimal" value={f.commissionPct} onChange={(e) => setF({ ...f, commissionPct: e.target.value })} />
          </label>
          <label className="wide2">
            Verified features (one per line, checked on the listing)
            <textarea name="fact-features" rows={3} value={f.features} onChange={(e) => setF({ ...f, features: e.target.value })} />
          </label>
          <label className="wide2">
            Sales-driving video links (one per line)
            <textarea name="fact-references" rows={2} value={f.references} onChange={(e) => setF({ ...f, references: e.target.value })} />
          </label>
          <label className="wide2">
            Notes
            <input name="fact-notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={async () => {
                const ok = await call(
                  bridge.updateProductFacts(accountId, p.id, { ...f, features: lines(f.features), references: lines(f.references), priceIdr: f.priceIdr, commissionPct: f.commissionPct }),
                );
                if (ok) setEditing(false);
              }}
            >
              Save details
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={() => props.onCreateVideos(p.id)}>
          Create videos
        </button>
        <button type="button" onClick={() => void call(bridge.selectAffiliateProduct(accountId, p.id, !p.selectedToday))}>
          {p.selectedToday ? 'Remove from today' : 'Select for today'}
        </button>
        <button type="button" onClick={() => void bridge.openProductPage(accountId, p.id).then((r) => !r.ok && props.onNotice(errNotice(r.error)))}>
          Open product
        </button>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)}>
            Edit details
          </button>
        )}
        {!confirmed && (
          <button type="button" onClick={() => void call(bridge.setProductListing(accountId, p.id, 'confirmed'))}>
            This is the exact listing
          </button>
        )}
        {p.listing !== 'mismatch' && (
          <button type="button" className="link" onClick={() => void call(bridge.setProductListing(accountId, p.id, 'mismatch'))}>
            wrong listing
          </button>
        )}
        <select
          aria-label="Can this account promote it?"
          value={p.eligibility}
          onChange={(e) => void call(bridge.setProductEligibility(accountId, p.id, e.target.value as AffiliateProduct['eligibility']))}
        >
          <option value="unknown">Can promote? (not checked)</option>
          <option value="can_promote">Can promote</option>
          <option value="cannot_promote">Cannot promote</option>
        </select>
      </div>
      <div className="showcase-box" data-testid="showcase-box">
        {(p.showcase === 'not_requested' || p.showcase === 'failed' || p.showcase === 'removed') && (
          <div className="actions">
            <button type="button" className="primary" disabled={!confirmed} onClick={() => void call(bridge.openShowcasePage(accountId, p.id))}>
              Add to Showcase
            </button>
            {!confirmed && <span className="small muted">Confirm the exact listing first.</span>}
            <button type="button" className="link" onClick={() => void call(bridge.showcaseAction(accountId, p.id, 'not_eligible'))}>
              not eligible
            </button>
          </div>
        )}
        {p.showcase === 'in_progress' && (
          <>
            <p className="small">
              TikTok’s Showcase page is open in this account’s window and the product link is on your clipboard. Add the product there with TikTok’s controls. When it
              appears in <strong>Showcase Products</strong>, confirm here.
            </p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => void call(bridge.showcaseAction(accountId, p.id, 'confirm_seen'))}>
                TikTok shows it in my Showcase
              </button>
              <button type="button" onClick={() => void call(bridge.openShowcasePage(accountId, p.id))}>
                Open Showcase page again
              </button>
              <button type="button" onClick={() => void call(bridge.showcaseAction(accountId, p.id, 'failed'))}>
                It failed
              </button>
              <button type="button" className="link" onClick={() => void call(bridge.showcaseAction(accountId, p.id, 'not_eligible'))}>
                not eligible
              </button>
            </div>
          </>
        )}
        {(p.showcase === 'added_seen_by_you' || p.showcase === 'added_confirmed_by_tiktok') && (
          <div className="actions">
            <span className="small muted">Since {p.showcaseChangedAt ? new Date(p.showcaseChangedAt).toLocaleString() : '—'}</span>
            <button type="button" className="link" onClick={() => void call(bridge.showcaseAction(accountId, p.id, 'removed'))}>
              removed from Showcase
            </button>
          </div>
        )}
        {p.showcase === 'not_eligible' && (
          <button type="button" className="link" onClick={() => void call(bridge.showcaseAction(accountId, p.id, 'reset'))}>
            reset
          </button>
        )}
      </div>
      <div className="actions">
        <button type="button" className="link danger-text" onClick={() => void call(bridge.removeAffiliateProduct(accountId, p.id))}>
          delete product
        </button>
      </div>
    </article>
  );
}
