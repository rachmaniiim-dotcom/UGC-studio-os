import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  describeError,
  describeField,
  type Account,
  type PromptActionName,
  type PromptItem,
  type PromptStatus,
  type PromptTemplate,
  type StudioView,
  type TemplateConfig,
} from './bridge.js';
import { Badge } from './Badge.js';
import { TemplateEditor } from './TemplateEditor.js';

// Prompt Studio (T1, Ternak Akun): choose a template, set the account's
// character/world/style and variations, generate distinct Google Flow
// prompts, review and edit them, approve, and queue them for production.
// Prompt approval and video production are separate: a prompt only becomes
// "video ready" when a real video file is linked to it.

type Notice = { tone: 'ok' | 'bad' | 'warn'; text: string; fields?: string[] } | null;

export const STATUS_LABEL: Record<PromptStatus, { label: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  draft: { label: 'Draft', tone: 'muted' },
  approved: { label: 'Approved prompt', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  queued: { label: 'Queued for generation', tone: 'warn' },
  generating: { label: 'Generating', tone: 'warn' },
  video_ready: { label: 'Video ready', tone: 'ok' },
};
const FLAG_LABEL: Record<string, string> = {
  unresolved_placeholder: 'leftover {{placeholder}}',
  too_long: 'too long',
  consistency_missing: 'character/world changed',
  reference_missing: 'reference file missing',
  near_duplicate: 'near-duplicate',
};
const BLOCKING = ['unresolved_placeholder', 'too_long', 'consistency_missing', 'reference_missing'];
const FILTERS: Array<{ key: 'all' | PromptStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'approved', label: 'Approved' },
  { key: 'queued', label: 'Queued' },
  { key: 'generating', label: 'Generating' },
  { key: 'video_ready', label: 'Video ready' },
  { key: 'rejected', label: 'Rejected' },
];

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

export function PromptStudio(props: { account: Account | null; onBack: () => Promise<void> }): React.JSX.Element {
  const { account } = props;
  const [view, setView] = useState<StudioView | null>(null);
  const [selected, setSelected] = useState<string>('builtin-asmr');
  const [editing, setEditing] = useState<{ template: PromptTemplate; baseKey: string | null } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    if (!account) return;
    const r = await bridge.studioView(account.id);
    if (r.ok) setView(r.data);
    else setNotice(errNotice(r.error));
  }, [account]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a provider job runs, refresh until it finishes.
  const busy = view?.batches.some((b) => b.items.some((i) => i.status === 'generating' && i.handoff === 'provider')) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 700);
    return () => clearInterval(t);
  }, [busy, load]);

  if (!account) return <p className="muted">Account not found.</p>;
  const template = view?.templates.find((t) => t.template.key === selected)?.template ?? view?.templates[0]?.template;

  return (
    <section className="studio" aria-label="Prompt Studio">
      <div className="section-head">
        <div>
          <button type="button" className="link" onClick={() => void props.onBack()}>
            ← All accounts
          </button>
          <h2>Prompt Studio · {account.displayName}</h2>
          <p className="muted small">
            Ternak Akun: generate complete Google Flow prompts from a template, review them, then queue them for production. Approving a prompt does not make a video;
            videos are made in Google Flow (by hand) and linked back here.
          </p>
        </div>
      </div>
      <NoticeBox notice={notice} testId="studio-error" />
      {view && (
        <>
          <div className="summary" data-testid="studio-summary">
            {(['draft', 'approved', 'queued', 'generating', 'video_ready', 'rejected'] as PromptStatus[]).map((s) => (
              <span key={s} data-status={s}>
                <strong>{view.counts[s]}</strong> {STATUS_LABEL[s].label.toLowerCase()}
              </span>
            ))}
          </div>
          {editing ? (
            <TemplateEditor
              bundleId={account.id}
              template={editing.template}
              baseKey={editing.baseKey}
              onSaved={(key, v) => {
                setView(v);
                setSelected(key);
                setEditing(null);
                setNotice({ tone: 'ok', text: 'Template saved as a new version.' });
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <TemplatePicker
              bundleId={account.id}
              view={view}
              selected={template?.key ?? ''}
              onSelect={setSelected}
              onEdit={(t) => setEditing({ template: t, baseKey: t.key })}
              onView={(v, key) => {
                setView(v);
                if (key) setSelected(key);
              }}
              onNotice={setNotice}
            />
          )}
          {template && !editing && (
            <ConfigForm key={`${template.key}:${template.version}`} bundleId={account.id} template={template} view={view} onView={setView} />
          )}
          <PromptList bundleId={account.id} view={view} onView={setView} />
          <ReadyToPost bundleId={account.id} view={view} onView={setView} />
        </>
      )}
    </section>
  );
}

function TemplatePicker(props: {
  bundleId: string;
  view: StudioView;
  selected: string;
  onSelect: (key: string) => void;
  onEdit: (t: PromptTemplate) => void;
  onView: (v: StudioView, key?: string) => void;
  onNotice: (n: Notice) => void;
}): React.JSX.Element {
  return (
    <section className="card" aria-labelledby="templates-title">
      <h3 id="templates-title">1. Template</h3>
      <div className="template-grid" data-testid="templates">
        {props.view.templates.map(({ template: t, versions }) => (
          <div key={t.key} className={`template-card${t.key === props.selected ? ' selected' : ''}`} data-template-key={t.key}>
            <div className="template-head">
              <strong>{t.name}</strong>
              <Badge tone={t.builtin ? 'muted' : 'ok'}>{t.builtin ? 'Starter' : `My template · v${t.version}${versions > 1 ? ` (${versions} versions)` : ''}`}</Badge>
            </div>
            <div className="muted small">{t.description}</div>
            <div className="muted small">
              {t.references.requirement === 'none' ? 'No reference files' : `${t.references.requirement === 'required' ? 'Requires' : 'Optional'} ${t.references.kinds.join('/')} reference`}
              {t.references.flowSupport === 'unsupported' ? ' (manual action: no verified Flow control)' : ''}
            </div>
            <div className="actions">
              <button type="button" className={t.key === props.selected ? 'primary' : ''} onClick={() => props.onSelect(t.key)}>
                {t.key === props.selected ? 'Selected' : 'Use'}
              </button>
              <button
                type="button"
                onClick={async () => {
                  const r = await bridge.duplicateTemplate(props.bundleId, t.key);
                  if (!r.ok) return props.onNotice(errNotice(r.error));
                  props.onView(r.data.view, r.data.key);
                  props.onNotice({ tone: 'ok', text: `Copied “${t.name}” to your templates. Edit it to make it yours.` });
                }}
              >
                Duplicate
              </button>
              {!t.builtin && (
                <button type="button" onClick={() => props.onEdit(t)}>
                  Edit
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const PRESET_KIND: Record<string, 'character' | 'world' | 'style'> = { character: 'character', hands: 'character', world: 'world', style: 'style' };

function ConfigForm(props: { bundleId: string; template: PromptTemplate; view: StudioView; onView: (v: StudioView) => void }): React.JSX.Element {
  const { template: t, view } = props;
  const stored = view.configs[t.key]!;
  const [c, setC] = useState<TemplateConfig>(stored.config);
  const [pools, setPools] = useState<Record<string, string>>(Object.fromEntries(Object.entries(stored.config.pools).map(([k, v]) => [k, v.join('\n')])));
  const [hashtags, setHashtags] = useState(stored.config.hashtags.join(' '));
  const [rights, setRights] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const build = (): TemplateConfig => ({
    ...c,
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.split('\n').map((x) => x.trim()).filter(Boolean)])),
    hashtags: hashtags.split(/\s+/).filter(Boolean),
  });
  const save = async (): Promise<boolean> => {
    const r = await bridge.saveTemplateConfig(props.bundleId, t.key, build());
    if (!r.ok) {
      setNotice(errNotice(r.error));
      return false;
    }
    props.onView(r.data);
    return true;
  };
  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      if (!(await save())) return;
      const r = await bridge.generatePrompts(props.bundleId, t.key);
      if (!r.ok) return setNotice(errNotice(r.error));
      props.onView(r.data.view);
      const batch = r.data.view.batches.find((b) => b.id === r.data.batchId)!;
      setNotice(
        batch.shortfall
          ? { tone: 'warn', text: `${batch.items.length} of ${batch.requested} prompts generated: the varying lists don’t allow more distinct combinations. Add options to get more.` }
          : { tone: 'ok', text: `${batch.items.length} prompts generated as drafts. Review them below.` },
      );
    } finally {
      setBusy(false);
    }
  };
  const setValue = (k: string, v: string) => setC({ ...c, values: { ...c.values, [k]: v } });
  const refs = view.references.filter((r) => t.references.kinds.includes(r.kind));

  return (
    <section className="card" aria-labelledby="config-title">
      <h3 id="config-title">2. Settings for this account · {t.name}</h3>
      {!stored.saved && <p className="muted small">Not saved for this account yet: starter values shown.</p>}
      <div className="config-grid">
        {t.variables.map((v) => {
          if (v.kind === 'consistency') {
            const kind = PRESET_KIND[v.key] ?? 'character';
            return (
              <ConsistencyField
                key={v.key}
                bundleId={props.bundleId}
                label={v.label}
                help={v.help}
                name={`var-${v.key}`}
                value={c.values[v.key] ?? ''}
                presets={view.presets.filter((p) => p.kind === kind)}
                kind={kind}
                onChange={(x) => setValue(v.key, x)}
                onView={props.onView}
              />
            );
          }
          if (v.kind === 'pool') {
            const lines = (pools[v.key] ?? '').split('\n').filter((x) => x.trim()).length;
            return (
              <label key={v.key} className="wide">
                {v.label} · varies per prompt ({lines} option{lines === 1 ? '' : 's'}, one per line)
                <textarea name={`pool-${v.key}`} rows={Math.min(8, Math.max(3, lines))} value={pools[v.key] ?? ''} onChange={(e) => setPools({ ...pools, [v.key]: e.target.value })} />
                <span className="muted small">{v.help}</span>
              </label>
            );
          }
          if (v.kind === 'choice') {
            return (
              <label key={v.key}>
                {v.label}
                <select name={`var-${v.key}`} value={c.values[v.key] ?? v.default} onChange={(e) => setValue(v.key, e.target.value)}>
                  {v.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            );
          }
          return (
            <label key={v.key} className="wide">
              {v.label}
              <input name={`var-${v.key}`} value={c.values[v.key] ?? ''} onChange={(e) => setValue(v.key, e.target.value)} />
              <span className="muted small">{v.help}</span>
            </label>
          );
        })}
      </div>
      <div className="form-grid production-grid">
        <label>
          Number of prompts
          <input name="count" inputMode="numeric" value={Number.isNaN(c.count) ? '' : String(c.count)} onChange={(e) => setC({ ...c, count: e.target.value.trim() === '' ? NaN : Number(e.target.value) })} />
        </label>
        <label>
          Aspect ratio
          <select name="aspectRatio" value={c.video.aspectRatio} onChange={(e) => setC({ ...c, video: { ...c.video, aspectRatio: e.target.value as TemplateConfig['video']['aspectRatio'] } })}>
            <option value="9:16">9:16 (vertical)</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>
        <label>
          Duration (s)
          <input name="durationSeconds" inputMode="numeric" value={String(c.video.durationSeconds)} onChange={(e) => setC({ ...c, video: { ...c.video, durationSeconds: Number(e.target.value) } })} />
        </label>
        <label className="wide2">
          Hashtags
          <input name="hashtags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        </label>
      </div>
      {t.references.requirement !== 'none' && (
        <div className="references" data-testid="references">
          <h4>Reference files ({t.references.requirement})</h4>
          <p className="muted small">
            {t.references.instructions} Files stay on this computer and are never sent to a prompt generator.
            {t.references.flowSupport === 'unsupported' ? ' Prompts using them are marked as needing manual action.' : ' Upload them in Google Flow by hand.'}
          </p>
          {refs.length > 0 && (
            <ul className="ref-list">
              {refs.map((r) => (
                <li key={r.id}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      name={`ref-${r.name}`}
                      checked={c.referenceAssetIds.includes(r.id)}
                      onChange={(e) =>
                        setC({ ...c, referenceAssetIds: e.target.checked ? [...c.referenceAssetIds, r.id] : c.referenceAssetIds.filter((x) => x !== r.id) })
                      }
                    />
                    {r.name} <span className="muted small">({r.kind}, {(r.bytes / 1024).toFixed(0)} KB)</span>
                  </label>{' '}
                  <button type="button" className="link" onClick={() => void bridge.revealReferenceAsset(props.bundleId, r.id)}>
                    show
                  </button>{' '}
                  <button
                    type="button"
                    className="link danger-text"
                    onClick={async () => {
                      const x = await bridge.removeReferenceAsset(props.bundleId, r.id);
                      if (x.ok) {
                        setC({ ...c, referenceAssetIds: c.referenceAssetIds.filter((id) => id !== r.id) });
                        props.onView(x.data);
                      }
                    }}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="checkbox">
            <input type="checkbox" name="rights" checked={rights} onChange={(e) => setRights(e.target.checked)} />I own this file or have the rights to use it
          </label>
          <div className="actions">
            <button
              type="button"
              disabled={!rights}
              onClick={async () => {
                const r = await bridge.addReferenceAsset(props.bundleId, rights);
                if (!r.ok) return setNotice(errNotice(r.error));
                if (r.data.canceled || !r.data.view) return;
                props.onView(r.data.view);
                setC({ ...c, referenceAssetIds: [...c.referenceAssetIds, r.data.assetId!] });
                setRights(false);
              }}
            >
              Add reference file…
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          onClick={async () => {
            if (await save()) setNotice({ tone: 'ok', text: 'Settings saved for this account.' });
          }}
        >
          Save settings
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void generate()}>
          Generate {Number.isNaN(c.count) ? '' : c.count} prompts
        </button>
      </div>
      <NoticeBox notice={notice} testId="config-notice" />
    </section>
  );
}

function ConsistencyField(props: {
  bundleId: string;
  label: string;
  help: string;
  name: string;
  value: string;
  kind: 'character' | 'world' | 'style';
  presets: StudioView['presets'];
  onChange: (v: string) => void;
  onView: (v: StudioView) => void;
}): React.JSX.Element {
  const [presetName, setPresetName] = useState('');
  return (
    <div className="wide consistency">
      <label>
        {props.label} · included word for word in every prompt
        <textarea name={props.name} rows={4} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      </label>
      <div className="preset-row small">
        {props.presets.length > 0 && (
          <select aria-label={`Load saved ${props.kind}`} value="" onChange={(e) => e.target.value && props.onChange(props.presets.find((p) => p.id === e.target.value)!.text)}>
            <option value="">Load saved {props.kind}…</option>
            {props.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input aria-label={`Name for this ${props.kind}`} placeholder={`Save as ${props.kind} named…`} value={presetName} onChange={(e) => setPresetName(e.target.value)} />
        <button
          type="button"
          disabled={presetName.trim() === ''}
          onClick={async () => {
            const r = await bridge.savePreset(props.bundleId, props.kind, presetName, props.value);
            if (r.ok) {
              setPresetName('');
              props.onView(r.data);
            }
          }}
        >
          Save {props.kind}
        </button>
        <span className="muted">{props.help}</span>
      </div>
    </div>
  );
}

function PromptList(props: { bundleId: string; view: StudioView; onView: (v: StudioView) => void }): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | PromptStatus>('all');
  const [notice, setNotice] = useState<Notice>(null);
  const act = async (itemId: string, action: PromptActionName): Promise<boolean> => {
    const r = await bridge.promptAction(props.bundleId, itemId, action);
    if (!r.ok) {
      setNotice(errNotice(r.error));
      return false;
    }
    setNotice(null);
    props.onView(r.data);
    return true;
  };
  const all = props.view.batches.flatMap((b) => b.items);
  const bulk = async (pick: (i: PromptItem) => boolean, action: PromptActionName, label: string): Promise<void> => {
    const ids = all.filter(pick).map((i) => i.id);
    let done = 0;
    for (const id of ids) if (await act(id, action)) done++;
    setNotice({ tone: 'ok', text: `${label}: ${done} prompt${done === 1 ? '' : 's'}.` });
  };
  return (
    <section className="card" aria-labelledby="prompts-title">
      <h3 id="prompts-title">3. Prompts and production queue</h3>
      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'primary' : ''} onClick={() => setFilter(f.key)}>
            {f.label}
            {f.key !== 'all' ? ` (${props.view.counts[f.key]})` : ''}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" onClick={() => void bulk((i) => i.status === 'draft' && i.flags.length === 0, 'approve', 'Approved')}>
          Approve all unflagged drafts
        </button>
        <button type="button" onClick={() => void bulk((i) => i.status === 'approved', 'queue', 'Queued for generation')}>
          Queue all approved
        </button>
      </div>
      <NoticeBox notice={notice} testId="prompts-notice" />
      {props.view.batches.length === 0 && <p className="muted small">No prompts yet. Choose a template, check the settings and press Generate.</p>}
      {props.view.batches.map((b) => {
        const items = b.items.filter((i) => filter === 'all' || i.status === filter);
        if (items.length === 0) return null;
        return (
          <div key={b.id} className="batch" data-batch-id={b.id}>
            <div className="batch-head small muted">
              {b.templateName} v{b.templateVersion} · {new Date(b.createdAt).toLocaleString()} · {b.items.length} of {b.requested} prompts · generator: {b.providerId}
            </div>
            {items.map((i) => (
              <PromptCard key={`${i.id}:${i.updatedAt}`} bundleId={props.bundleId} item={i} view={props.view} onAct={act} onView={props.onView} onNotice={setNotice} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function PromptCard(props: {
  bundleId: string;
  item: PromptItem;
  view: StudioView;
  onAct: (id: string, action: PromptActionName) => Promise<boolean>;
  onView: (v: StudioView) => void;
  onNotice: (n: Notice) => void;
}): React.JSX.Element {
  const { item: i } = props;
  const [editing, setEditing] = useState(false);
  const [sections, setSections] = useState(i.content.sections.map((s) => s.text));
  const [caption, setCaption] = useState(i.content.caption);
  const [confirmSpend, setConfirmSpend] = useState(false);
  const [copied, setCopied] = useState(false);
  const call = async (p: Promise<{ ok: true; data: StudioView } | { ok: false; error: { code: string; details?: string[] } }>): Promise<boolean> => {
    const r = await p;
    if (!r.ok) {
      props.onNotice(errNotice(r.error));
      return false;
    }
    props.onNotice(null);
    props.onView(r.data);
    return true;
  };
  const blocking = i.flags.filter((f) => BLOCKING.includes(f));
  const copy = async (): Promise<void> => {
    const r = await bridge.copyPrompt(props.bundleId, i.id);
    if (r.ok) setCopied(true);
  };

  return (
    <article className={`prompt-card status-${i.status}`} data-prompt-id={i.id} data-status={i.status} data-position={i.position}>
      <header className="prompt-head">
        <strong>#{i.position}</strong>
        <Badge tone={STATUS_LABEL[i.status].tone} testId="prompt-status" value={i.status}>
          {STATUS_LABEL[i.status].label}
        </Badge>
        {i.edited && <Badge tone="muted">edited</Badge>}
        {i.flags.map((f) => (
          <Badge key={f} tone={BLOCKING.includes(f) ? 'bad' : 'warn'} value={f}>
            {f === 'near_duplicate' ? `similar to #${i.duplicates.join(', #')}` : (FLAG_LABEL[f] ?? f)}
          </Badge>
        ))}
        {i.manualSteps.length > 0 && <Badge tone="warn">needs manual action</Badge>}
      </header>
      <div className="chips axes">
        {Object.entries(i.axes).map(([k, v]) => (
          <span key={k} className="axis" title={v}>
            {k}: {v.length > 48 ? `${v.slice(0, 48)}…` : v}
          </span>
        ))}
      </div>
      {editing ? (
        <div className="prompt-edit">
          {i.content.sections.map((s, k) => (
            <label key={s.key}>
              {s.title}
              <textarea name={`edit-${s.key}`} rows={3} value={sections[k]} onChange={(e) => setSections(sections.map((x, j) => (j === k ? e.target.value : x)))} />
            </label>
          ))}
          <label>
            Caption
            <textarea name="edit-caption" rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={async () => {
                if (await call(bridge.updatePrompt(props.bundleId, i.id, { sections: i.content.sections.map((s, k) => ({ ...s, text: sections[k]! })), caption }))) setEditing(false);
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
          <pre className="prompt-text" data-testid="prompt-text">
            {i.rendered}
          </pre>
          <div className="small">
            <span className="muted">Caption:</span> <span data-testid="prompt-caption">{i.content.caption}</span>
          </div>
        </>
      )}
      {i.manualSteps.length > 0 && (
        <ul className="manual-steps small" data-testid="manual-steps">
          {i.manualSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {blocking.length > 0 && (
        <p className="small bad-text">
          Can’t be approved until edited: {blocking.map((f) => describeField(f)).join(' ')}
        </p>
      )}
      {i.lastError && (
        <p className="small bad-text" data-testid="prompt-error">
          {i.lastError === 'manual_download_failed' ? 'The last download for this prompt failed; download it again in Google Flow.' : `The last generation attempt ended without a video (${i.lastError}). It is back in the queue.`}
        </p>
      )}
      {!editing && (
        <div className="actions">
          {i.status === 'draft' && (
            <>
              <button type="button" className="primary" disabled={blocking.length > 0} onClick={() => void props.onAct(i.id, 'approve')}>
                Approve prompt
              </button>
              <button type="button" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" onClick={() => void call(bridge.regeneratePrompt(props.bundleId, i.id))}>
                Regenerate
              </button>
              <button type="button" className="danger-outline" onClick={() => void props.onAct(i.id, 'reject')}>
                Reject
              </button>
            </>
          )}
          {i.status === 'approved' && (
            <>
              <button type="button" className="primary" onClick={() => void props.onAct(i.id, 'queue')}>
                Queue for generation
              </button>
              <button type="button" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" onClick={() => void props.onAct(i.id, 'reopen')}>
                Back to draft
              </button>
              <button type="button" className="danger-outline" onClick={() => void props.onAct(i.id, 'reject')}>
                Reject
              </button>
            </>
          )}
          {i.status === 'rejected' && (
            <>
              <button type="button" onClick={() => void props.onAct(i.id, 'reopen')}>
                Restore to draft
              </button>
              <button type="button" onClick={() => void call(bridge.regeneratePrompt(props.bundleId, i.id))}>
                Regenerate
              </button>
            </>
          )}
          {i.status === 'queued' && (
            <>
              <button type="button" onClick={() => void copy()}>
                {copied ? 'Copied ✓' : 'Copy prompt for Flow'}
              </button>
              <button type="button" className="primary" onClick={() => void props.onAct(i.id, 'start_manual')}>
                I’m generating it in Flow
              </button>
              {props.view.videoProvider.available &&
                (confirmSpend ? (
                  <>
                    <span className="small warn-text">Uses video-generation credits ({props.view.videoProvider.label}).</span>
                    <button type="button" className="primary" onClick={() => void call(bridge.generateVideoFromPrompt(props.bundleId, i.id))}>
                      Confirm: generate video
                    </button>
                    <button type="button" onClick={() => setConfirmSpend(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmSpend(true)}>
                    Generate with {props.view.videoProvider.label}…
                  </button>
                ))}
              <button type="button" onClick={() => void props.onAct(i.id, 'unqueue')}>
                Remove from queue
              </button>
              <LinkVideo bundleId={props.bundleId} item={i} view={props.view} call={call} />
            </>
          )}
          {i.status === 'generating' && (
            <>
              <span className="small muted">
                {i.handoff === 'provider'
                  ? `Generating with ${props.view.videoProvider.label ?? 'the provider'}…`
                  : 'Waiting for the video: download it in this account’s Google Flow window and it will be linked here automatically.'}
              </span>
              {i.handoff === 'manual' && (
                <>
                  <button type="button" onClick={() => void copy()}>
                    {copied ? 'Copied ✓' : 'Copy prompt again'}
                  </button>
                  <button type="button" onClick={() => void props.onAct(i.id, 'back_to_queue')}>
                    Back to queue
                  </button>
                  <LinkVideo bundleId={props.bundleId} item={i} view={props.view} call={call} />
                </>
              )}
            </>
          )}
          {i.status === 'video_ready' && i.video && (
            <>
              <button type="button" className="primary" onClick={() => void bridge.revealVideo(i.video!.jobId)}>
                Show video in folder
              </button>
              {i.post ? <span className="small muted">Posted (marked by you) {new Date(i.post.postedAt).toLocaleString()}</span> : <span className="small muted">Ready to post: see below.</span>}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function ReadyToPost(props: { bundleId: string; view: StudioView; onView: (v: StudioView) => void }): React.JSX.Element {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const { readyToPost, posted } = props.view;
  return (
    <section className="card" aria-labelledby="post-title">
      <h3 id="post-title">4. Ready to post</h3>
      <p className="muted small">
        Videos whose file is in this account’s library. Post them yourself in TikTok (open the account’s TikTok window), then mark them as posted here. The app does not publish,
        schedule or add AI labels for you: when posting a realistic AI video, turn on TikTok’s AI-generated content label.
      </p>
      <NoticeBox notice={notice} testId="post-notice" />
      {readyToPost.length === 0 ? (
        <p className="muted small">Nothing ready to post yet.</p>
      ) : (
        <ul className="post-list" data-testid="ready-to-post">
          {readyToPost.map((i) => (
            <li key={i.id} data-prompt-id={i.id}>
              <div className="post-caption">{i.content.caption}</div>
              <div className="actions">
                <button type="button" onClick={() => void bridge.revealVideo(i.video!.jobId)}>
                  Show video
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const r = await bridge.copyCaption(props.bundleId, i.id);
                    if (r.ok) setCopied(i.id);
                  }}
                >
                  {copied === i.id ? 'Caption copied ✓' : 'Copy caption'}
                </button>
                <input
                  className="post-link"
                  aria-label="TikTok post link (optional)"
                  placeholder="Post link (optional): https://www.tiktok.com/@you/video/…"
                  value={links[i.id] ?? ''}
                  onChange={(e) => setLinks({ ...links, [i.id]: e.target.value })}
                />
                <button
                  type="button"
                  className="primary"
                  onClick={async () => {
                    const r = await bridge.markPosted(props.bundleId, i.id, (links[i.id] ?? '').trim() || null);
                    if (!r.ok) return setNotice(errNotice(r.error));
                    setNotice(null);
                    props.onView(r.data);
                  }}
                >
                  I posted it
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {posted.length > 0 && (
        <>
          <h4>Recently posted (marked by you)</h4>
          <ul className="post-list posted" data-testid="posted">
            {posted.map((i) => (
              <li key={i.id} data-prompt-id={i.id}>
                <span className="small">{new Date(i.post!.postedAt).toLocaleString()}</span> · <span className="small">{i.content.caption}</span>
                {i.post!.postUrl && <span className="small mono"> · {i.post!.postUrl}</span>}{' '}
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    const r = await bridge.undoPosted(props.bundleId, i.id);
                    if (r.ok) props.onView(r.data);
                  }}
                >
                  undo
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function LinkVideo(props: {
  bundleId: string;
  item: PromptItem;
  view: StudioView;
  call: (p: Promise<{ ok: true; data: StudioView } | { ok: false; error: { code: string; details?: string[] } }>) => Promise<boolean>;
}): React.JSX.Element | null {
  if (props.view.unlinkedVideos.length === 0) return null;
  return (
    <select
      aria-label="Link a downloaded video"
      value=""
      onChange={(e) => e.target.value && void props.call(bridge.linkPromptVideo(props.bundleId, props.item.id, e.target.value))}
    >
      <option value="">Link a video already in the library…</option>
      {props.view.unlinkedVideos.map((v) => (
        <option key={v.jobId} value={v.jobId}>
          {new Date(v.createdAt).toLocaleString()} · {v.source === 'manual_download' ? 'Flow download' : 'generated'}
          {v.bytes ? ` · ${(v.bytes / 1024 / 1024).toFixed(1)} MB` : ''}
        </option>
      ))}
    </select>
  );
}
