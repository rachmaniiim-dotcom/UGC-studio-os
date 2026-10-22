import { useState } from 'react';
import { bridge, describeError, describeField, type PromptTemplate, type StudioView, type TemplateVariable } from './bridge.js';

// Editor for the owner's own master templates. Saving always creates a new
// version (earlier batches keep the version they were made with). Starter
// templates are never edited here: they are duplicated first.

type Section = PromptTemplate['sections'][number];
type Slot = { key: string; label: string; options: string };
type Variable = Omit<TemplateVariable, 'options'> & { options: string };

const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function TemplateEditor(props: {
  bundleId: string;
  template: PromptTemplate;
  baseKey: string | null;
  onSaved: (key: string, view: StudioView) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = props.template;
  const [name, setName] = useState(t.name);
  const [niche, setNiche] = useState(t.niche);
  const [description, setDescription] = useState(t.description);
  const [sections, setSections] = useState<Section[]>(t.sections.map((s) => ({ ...s })));
  const [variables, setVariables] = useState<Variable[]>(t.variables.map((v) => ({ ...v, options: v.options.join('\n') })));
  const [slots, setSlots] = useState<Slot[]>(t.slots.map((s) => ({ ...s, options: s.options.join('\n') })));
  const [references, setReferences] = useState(t.references);
  const [caption, setCaption] = useState({ pattern: t.caption.pattern, hashtags: t.caption.hashtags.join(' '), maxLength: String(t.caption.maxLength) });
  const [error, setError] = useState<{ text: string; fields: string[] } | null>(null);

  const keys = ['duration_seconds', 'aspect_ratio', ...variables.map((v) => v.key), ...slots.map((s) => s.key)].filter(Boolean);
  const save = async (): Promise<void> => {
    const definition: Partial<PromptTemplate> = {
      name,
      niche,
      description,
      family: t.family,
      sections,
      variables: variables.map((v) => ({ ...v, options: lines(v.options) })),
      slots: slots.map((s) => ({ ...s, options: lines(s.options) })),
      references,
      video: t.video,
      caption: { pattern: caption.pattern, hashtags: caption.hashtags.split(/\s+/).filter(Boolean), maxLength: Number(caption.maxLength) },
    };
    const r = await bridge.saveTemplate(props.bundleId, definition, props.baseKey);
    if (!r.ok) {
      const d = describeError(r.error.code);
      return setError({ text: `${d.message} ${d.recovery}`, fields: r.error.details ?? [] });
    }
    props.onSaved(r.data.key, r.data.view);
  };
  const setVar = (k: number, patch: Partial<Variable>) => setVariables(variables.map((v, j) => (j === k ? { ...v, ...patch } : v)));
  const setSec = (k: number, patch: Partial<Section>) => setSections(sections.map((s, j) => (j === k ? { ...s, ...patch } : s)));
  const setSlot = (k: number, patch: Partial<Slot>) => setSlots(slots.map((s, j) => (j === k ? { ...s, ...patch } : s)));

  return (
    <section className="card template-editor" aria-labelledby="editor-title">
      <h3 id="editor-title">
        Edit template · {t.name} (saves as v{t.version + 1})
      </h3>
      <div className="form-grid editor-grid">
        <label>
          Name
          <input name="tpl-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Niche
          <input name="tpl-niche" value={niche} onChange={(e) => setNiche(e.target.value)} />
        </label>
        <label className="wide2">
          Description
          <input name="tpl-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <p className="muted small">
        Placeholders you can use: {keys.map((k) => `{{${k}}}`).join(' ')}
      </p>

      <h4>Prompt sections (in order)</h4>
      {sections.map((s, k) => (
        <div key={k} className="editor-row">
          <input aria-label="Section key" className="key" value={s.key} onChange={(e) => setSec(k, { key: e.target.value })} />
          <input aria-label="Section title" value={s.title} onChange={(e) => setSec(k, { title: e.target.value })} />
          <textarea aria-label={`Section text ${s.title}`} name={`tpl-section-${s.key}`} rows={3} value={s.text} onChange={(e) => setSec(k, { text: e.target.value })} />
          <button type="button" className="link danger-text" onClick={() => setSections(sections.filter((_, j) => j !== k))}>
            remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setSections([...sections, { key: `section_${sections.length + 1}`, title: 'New section', text: '' }])}>
        + Section
      </button>

      <h4>Variables</h4>
      <p className="muted small">
        consistency = character/world/style text copied word for word into every prompt; pool = one option per line, a different one per prompt; choice = pick one; text =
        same value everywhere.
      </p>
      {variables.map((v, k) => (
        <div key={k} className="editor-row">
          <input aria-label="Variable key" className="key" value={v.key} onChange={(e) => setVar(k, { key: e.target.value })} />
          <input aria-label="Variable label" value={v.label} onChange={(e) => setVar(k, { label: e.target.value })} />
          <select aria-label="Variable kind" value={v.kind} onChange={(e) => setVar(k, { kind: e.target.value as Variable['kind'] })}>
            <option value="consistency">consistency</option>
            <option value="pool">pool</option>
            <option value="choice">choice</option>
            <option value="text">text</option>
          </select>
          {v.kind === 'pool' || v.kind === 'choice' ? (
            <textarea aria-label={`Options for ${v.key}`} name={`tpl-options-${v.key}`} rows={3} value={v.options} onChange={(e) => setVar(k, { options: e.target.value })} />
          ) : (
            <textarea aria-label={`Default for ${v.key}`} name={`tpl-default-${v.key}`} rows={v.kind === 'consistency' ? 3 : 1} value={v.default} onChange={(e) => setVar(k, { default: e.target.value })} />
          )}
          {v.kind === 'choice' && <input aria-label="Default choice" value={v.default} onChange={(e) => setVar(k, { default: e.target.value })} />}
          <button type="button" className="link danger-text" onClick={() => setVariables(variables.filter((_, j) => j !== k))}>
            remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setVariables([...variables, { key: `var_${variables.length + 1}`, label: 'New variable', kind: 'pool', required: true, default: '', options: '', help: '' }])}
      >
        + Variable
      </button>

      <h4>Per-prompt details (filled by the generator)</h4>
      {slots.map((s, k) => (
        <div key={k} className="editor-row">
          <input aria-label="Slot key" className="key" value={s.key} onChange={(e) => setSlot(k, { key: e.target.value })} />
          <input aria-label="Slot label" value={s.label} onChange={(e) => setSlot(k, { label: e.target.value })} />
          <textarea aria-label={`Options for ${s.key}`} rows={3} value={s.options} onChange={(e) => setSlot(k, { options: e.target.value })} />
          <button type="button" className="link danger-text" onClick={() => setSlots(slots.filter((_, j) => j !== k))}>
            remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setSlots([...slots, { key: `detail_${slots.length + 1}`, label: 'New detail', options: '' }])}>
        + Detail
      </button>

      <h4>Reference files and caption</h4>
      <div className="form-grid editor-grid">
        <label>
          Reference files
          <select value={references.requirement} onChange={(e) => setReferences({ ...references, requirement: e.target.value as PromptTemplate['references']['requirement'] })}>
            <option value="none">none</option>
            <option value="optional">optional</option>
            <option value="required">required</option>
          </select>
        </label>
        <label>
          Kind
          <select
            value={references.kinds.join('+') || 'image'}
            onChange={(e) => setReferences({ ...references, kinds: e.target.value.split('+') as Array<'image' | 'video'> })}
          >
            <option value="image">image</option>
            <option value="video">video</option>
            <option value="image+video">image or video</option>
          </select>
        </label>
        <label>
          Google Flow support
          <select value={references.flowSupport} onChange={(e) => setReferences({ ...references, flowSupport: e.target.value as PromptTemplate['references']['flowSupport'] })}>
            <option value="manual_upload">upload by hand in Flow</option>
            <option value="unsupported">no Flow control (manual action)</option>
          </select>
        </label>
        <label>
          Purpose
          <select value={references.purpose} onChange={(e) => setReferences({ ...references, purpose: e.target.value as PromptTemplate['references']['purpose'] })}>
            <option value="appearance">appearance</option>
            <option value="style">style</option>
            <option value="motion">motion</option>
          </select>
        </label>
        <label className="wide2">
          Caption pattern
          <input name="tpl-caption" value={caption.pattern} onChange={(e) => setCaption({ ...caption, pattern: e.target.value })} />
        </label>
        <label className="wide2">
          Hashtags
          <input name="tpl-hashtags" value={caption.hashtags} onChange={(e) => setCaption({ ...caption, hashtags: e.target.value })} />
        </label>
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={() => void save()}>
          Save new version
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="notice bad" role="alert" data-testid="editor-error">
          {error.text}
          <ul>
            {error.fields.map((f) => (
              <li key={f} data-field-issue={f}>
                {describeField(f)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
