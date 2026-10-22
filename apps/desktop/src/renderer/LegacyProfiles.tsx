import { useState } from 'react';
import { bridge, describeError, type ImportSummary, type PlatformInfo, type Result, type Session } from './bridge.js';

// The bundle-less synthetic test profiles of Gates 1–2. Shown only in synthetic
// test runs, with the earlier UI's labels and markers, so their regression
// suites keep driving it unchanged.

const PAGE_LABELS: Record<string, string> = {
  home: 'Open site',
  strict: 'Open strict page',
  'interactive-login': 'Interactive login (synthetic)',
};
const TEST_ONLY_PAGES = new Set(['rotate', 'logout', 'basic-auth']);

function describeLegacyImport(summary: ImportSummary): string {
  const lines = [
    `Last import ${summary.at} — format: ${summary.format}${summary.fileError ? `, file error: ${summary.fileError}` : ''}`,
    `examined ${summary.examined}, imported ${summary.imported}, skipped ${summary.skipped}, rejected ${summary.rejected}`,
    `loaded into browser: ${summary.browserLoaded}`,
  ];
  const reasons = Object.entries(summary.reasons).map(([k, v]) => `${k}: ${v}`);
  if (reasons.length) lines.push(`reasons — ${reasons.join(', ')}`);
  const failures = Object.entries(summary.browserFailures).map(([k, v]) => `${k}: ${v}`);
  if (failures.length) lines.push(`browser load issues — ${failures.join(', ')}`);
  return [...lines, ...summary.messages].join('\n');
}

export function LegacyProfiles(props: { platform: PlatformInfo; profiles: Session[]; onChanged: () => Promise<void> }): React.JSX.Element {
  const { platform } = props;
  const [error, setError] = useState<string | null>(null);
  const act = (action: () => Promise<Result<unknown>>) => () => {
    void action().then(async (r) => {
      setError(r.ok ? null : r.error.code);
      await props.onChanged();
    });
  };
  return (
    <section className="legacy" aria-label="Synthetic test profiles">
      <h2>Synthetic test profiles</h2>
      <p
        id="platform"
        className="muted small"
        data-status-check={platform.statusCheck}
      >{`Platform: ${platform.displayName} — status ${platform.statusCheck === 'manual' ? 'confirmed by you (no automated checks)' : 'checked automatically'}`}</p>
      {error && (
        <p className="notice bad" role="alert">
          Request failed: {error}. {describeError(error).recovery}
        </p>
      )}
      <div id="profiles">
        {props.profiles.map((profile) => {
          const sync = profile.sessionSync;
          const saved = sync.saveError
            ? `not saved (${sync.saveError})`
            : sync.savedCount > 0
              ? `${sync.savedCount} saved, revision ${sync.revision}`
              : `none saved, revision ${sync.revision}`;
          const restore = sync.restore ? ` · last restore: ${sync.restore.state}, ${sync.restore.count}${sync.restore.error ? ` (${sync.restore.error})` : ''}` : '';
          return (
            <section key={profile.id} className="profile" data-profile-id={profile.id}>
              <h2>{profile.label}</h2>
              <p className="status" data-status={profile.status}>{`Status: ${profile.status}${profile.statusReason ? ` (${profile.statusReason})` : ''}`}</p>
              <p className="meta">{`Partition: ${profile.partition}`}</p>
              {profile.lastImport && <pre>{describeLegacyImport(profile.lastImport)}</pre>}
              <p
                className="meta sync"
                data-revision={String(sync.revision)}
                data-saved-count={String(sync.savedCount)}
                data-restore-state={sync.restore?.state ?? 'none'}
              >{`Session cookies: ${saved}${restore}`}</p>
              <div className="actions">
                <button type="button" onClick={act(() => bridge.importCookies(profile.id))}>
                  Import Cookie-Editor JSON…
                </button>
                {platform.statusCheck === 'probe' && (
                  <button type="button" onClick={act(() => bridge.checkStatus(profile.id))}>
                    Check status
                  </button>
                )}
                <button type="button" onClick={act(() => bridge.confirmStatus(profile.id, 'logged_in'))}>
                  I see I am logged in
                </button>
                <button type="button" onClick={act(() => bridge.confirmStatus(profile.id, 'logged_out'))}>
                  I see I am logged out
                </button>
                {platform.pages
                  .filter((page) => !TEST_ONLY_PAGES.has(page))
                  .map((page) => (
                    <button key={page} type="button" onClick={act(() => bridge.openSite(profile.id, page))}>
                      {PAGE_LABELS[page] ?? `Open ${page}`}
                    </button>
                  ))}
                <button type="button" onClick={act(() => bridge.clearProfile(profile.id))}>
                  Clear
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
