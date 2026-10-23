import { useCallback, useEffect, useState } from 'react';
import { AccountEditor } from './AccountEditor.js';
import { bridge, describeError, type Account, type PlatformInfo, type Session } from './bridge.js';
import { Dashboard } from './Dashboard.js';
import { GrowthIntelligence } from './GrowthIntelligence.js';
import { AffiliateProducts } from './AffiliateProducts.js';
import { FlowPool } from './FlowPool.js';
import { ProductionBoard } from './ProductionBoard.js';
import { PromptStudio } from './PromptStudio.js';
import { LegacyProfiles } from './LegacyProfiles.js';

// `visit` keeps the editor mounted while a new draft gets its id (so its confirmations stay visible).
type View = { kind: 'dashboard' } | { kind: 'editor'; accountId: string | null; visit: number } | { kind: 'growth'; accountId: string } | { kind: 'studio'; accountId: string } | { kind: 'board' } | { kind: 'products'; accountId: string } | { kind: 'pool' };

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [visits, setVisits] = useState(0);
  const openEditor = (accountId: string | null): void => {
    setVisits((v) => v + 1);
    setView({ kind: 'editor', accountId, visit: visits + 1 });
  };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [legacy, setLegacy] = useState<{ platform: PlatformInfo; profiles: Session[] } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await bridge.listAccounts();
    if (!list.ok) return setError(list.error.code);
    setAccounts(list.data);
    const platform = await bridge.getPlatform();
    const profiles = await bridge.listProfiles();
    setLegacy(platform.ok && platform.data && profiles.ok && profiles.data.length > 0 ? { platform: platform.data, profiles: profiles.data } : null);
    setError(null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const editing = view.kind === 'editor' ? (view.accountId ? (accounts.find((a) => a.id === view.accountId) ?? null) : null) : null;

  return (
    <div className="app" data-app-ready={loaded ? 'true' : undefined}>
      <header className="topbar">
        <h1>UGC Production OS</h1>
        <span className="topbar-sub">Accounts &amp; sessions</span>
      </header>
      {error && (
        <p id="error" role="alert" className="banner bad">
          {describeError(error).message} {describeError(error).recovery}
        </p>
      )}
      <main>
        {view.kind === 'dashboard' ? (
          <>
            <Dashboard
              accounts={accounts}
              onAdd={() => openEditor(null)}
              onEdit={(id) => openEditor(id)}
              onGrowth={(id) => setView({ kind: 'growth', accountId: id })}
              onStudio={(id) => setView({ kind: 'studio', accountId: id })}
              onBoard={() => setView({ kind: 'board' })}
              onProducts={(id) => setView({ kind: 'products', accountId: id })}
              onPool={() => setView({ kind: 'pool' })}
            />
            {legacy && <LegacyProfiles platform={legacy.platform} profiles={legacy.profiles} onChanged={refresh} />}
          </>
        ) : view.kind === 'pool' ? (
          <FlowPool
            onBack={async () => {
              await refresh();
              setView({ kind: 'dashboard' });
            }}
            onEdit={(id) => openEditor(id)}
          />
        ) : view.kind === 'products' ? (
          <AffiliateProducts
            account={accounts.find((a) => a.id === view.accountId) ?? null}
            onBack={async () => {
              await refresh();
              setView({ kind: 'dashboard' });
            }}
          />
        ) : view.kind === 'board' ? (
          <ProductionBoard
            onBack={async () => {
              await refresh();
              setView({ kind: 'dashboard' });
            }}
            onStudio={(id) => setView({ kind: 'studio', accountId: id })}
          />
        ) : view.kind === 'studio' ? (
          <PromptStudio
            account={accounts.find((a) => a.id === view.accountId) ?? null}
            onBack={async () => {
              await refresh();
              setView({ kind: 'dashboard' });
            }}
          />
        ) : view.kind === 'growth' ? (
          <GrowthIntelligence
            account={accounts.find((a) => a.id === view.accountId) ?? null}
            onBack={async () => {
              await refresh();
              setView({ kind: 'dashboard' });
            }}
          />
        ) : (
          <AccountEditor
            key={view.visit}
            account={editing}
            onSaved={async (account) => {
              await refresh();
              setView({ kind: 'editor', accountId: account.id, visit: view.visit });
            }}
            onRefresh={refresh}
            onClose={async () => {
              await refresh();
              setView({ kind: 'dashboard' });
            }}
          />
        )}
      </main>
    </div>
  );
}
