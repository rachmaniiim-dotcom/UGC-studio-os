import { useCallback, useEffect, useState } from 'react';
import { bridge, describeError, describeField, describeJobOutcome, type Account, type GenerationJob, type VideoSettings } from './bridge.js';
import { Badge } from './Badge.js';

// Account Growth video generation (Gate 4): saved creative brief, one job at a
// time, completed videos in this account's library. Only the synthetic test
// provider can generate automatically; for real Flow use, the owner generates
// in the Flow window and the downloaded MP4 lands in this library.

const STATE_LABEL: Record<GenerationJob['state'], { label: string; tone: 'muted' | 'warn' | 'ok' | 'bad' }> = {
  pending: { label: 'Waiting', tone: 'muted' },
  running: { label: 'Generating', tone: 'warn' },
  completed: { label: 'Saved', tone: 'ok' },
  waiting_for_user: { label: 'Needs you', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
};

const DEFAULTS: VideoSettings = { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' };

export function VideoSection(props: { account: Account; onChanged: () => Promise<void> }): React.JSX.Element {
  const { account } = props;
  const saved = account.creative;
  const [prompt, setPrompt] = useState(saved?.prompt ?? '');
  const [settings, setSettings] = useState<VideoSettings>(saved?.settings ?? DEFAULTS);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string; fields?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const provider = account.generation.provider;
  const active = jobs.some((j) => j.state === 'pending' || j.state === 'running');

  const loadJobs = useCallback(async () => {
    const r = await bridge.listGenerations(account.id);
    if (r.ok) setJobs(r.data);
  }, [account.id]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // While a job runs (or a manual download is in progress), refresh its progress.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void loadJobs(), 500);
    return () => clearInterval(timer);
  }, [active, loadJobs]);

  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await bridge.saveCreative(account.id, prompt, settings);
    setBusy(false);
    setNotice(r.ok ? { tone: 'ok', text: 'Video settings saved.' } : { tone: 'bad', text: describeError(r.error.code).message, fields: r.error.details ?? [] });
    if (r.ok) await props.onChanged();
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    const r = await bridge.startGeneration(account.id);
    setBusy(false);
    if (!r.ok) {
      const d = describeError(r.error.code);
      return setNotice({ tone: 'bad', text: `${d.message} ${d.recovery}` });
    }
    setNotice({ tone: 'ok', text: 'Generation started.' });
    await loadJobs();
    await props.onChanged();
  };

  return (
    <section className="card" aria-labelledby="video-title">
      <h3 id="video-title">4 · Video generation (Account Growth)</h3>
      <label>
        Creative prompt
        <textarea name="creative-prompt" rows={4} value={prompt} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="form-grid video-grid">
        <label>
          Aspect ratio
          <select name="aspectRatio" value={settings.aspectRatio} onChange={(e) => setSettings({ ...settings, aspectRatio: e.target.value as VideoSettings['aspectRatio'] })}>
            <option value="9:16">9:16 vertical</option>
            <option value="16:9">16:9 landscape</option>
            <option value="1:1">1:1 square</option>
          </select>
        </label>
        <label>
          Duration (s)
          <select name="durationSeconds" value={settings.durationSeconds} onChange={(e) => setSettings({ ...settings, durationSeconds: Number(e.target.value) })}>
            {[4, 6, 8, 10].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quality
          <select name="quality" value={settings.quality} onChange={(e) => setSettings({ ...settings, quality: e.target.value as VideoSettings['quality'] })}>
            <option value="fast">Fast</option>
            <option value="quality">Quality</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void save()}>
          Save video settings
        </button>
        <button type="button" className="primary" disabled={busy || !provider || !saved || active} onClick={() => void generate()}>
          Generate one video
        </button>
        <span className="muted small" data-testid="generation-provider">
          {provider ? `Provider: ${provider.displayName} · ${account.generation.usedToday} of ${account.generation.dailyCap} today` : account.generation.unavailableReason}
        </span>
      </div>
      {notice && (
        <div className={`notice ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="video-notice">
          {notice.text}
          {notice.fields && notice.fields.length > 0 && (
            <ul>
              {notice.fields.map((f) => (
                <li key={f}>{describeField(f)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <h4 className="library-title">Video library</h4>
      {jobs.length === 0 ? (
        <p className="muted small">No videos yet.</p>
      ) : (
        <table className="jobs" data-testid="jobs">
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} data-job-id={j.id} data-state={j.state} data-error={j.errorCode ?? ''}>
                <td className="small">{new Date(j.createdAt).toLocaleString()}</td>
                <td className="small">
                  {j.source === 'manual_download' ? 'Downloaded from Flow' : j.providerId}
                  {j.promptItemId && <div className="muted" data-testid="from-prompt">from a Prompt Studio prompt</div>}
                </td>
                <td>
                  <Badge tone={STATE_LABEL[j.state].tone}>{STATE_LABEL[j.state].label}</Badge>
                  {j.state === 'running' && j.progress !== null && <span className="muted small"> {Math.round(j.progress * 100)}%</span>}
                </td>
                <td className="small">
                  {j.state === 'completed' && j.videoBytes !== null ? `${(j.videoBytes / 1048576).toFixed(1)} MB` : describeJobOutcome(j.errorCode)}
                </td>
                <td>
                  {j.state === 'completed' && (
                    <button type="button" onClick={() => void bridge.revealVideo(j.id)}>
                      Show in folder
                    </button>
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
