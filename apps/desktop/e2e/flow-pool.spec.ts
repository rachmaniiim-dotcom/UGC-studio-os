import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticProxy, startSyntheticSite, type SyntheticProxy, type SyntheticSite } from '@ugc/test-fixtures';
import { call, createAccount, fusedElectron, launch, nextSiteWindow, ok, quit, workDir, type Account } from './harness.js';

// F0: Flow pool accounts (Flow-only Google accounts with their own proxy)
// supply credits to a Ternak Akun account. A queued prompt goes to the pool
// account's Flow window; the video downloaded there lands in the prompt's
// account library and the pool's credits go down. Synthetic stand-ins only.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'factory-2', 'screenshots');
const EXIT = '198.51.100.72';
let site: SyntheticSite;
let proxy: SyntheticProxy;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  proxy = await startSyntheticProxy({ exitIp: EXIT });
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await proxy.close();
  await site.close();
});

test('Flow pool: credits, prompt hand-off to a pool account, download back to the right account', async () => {
  const dir = await workDir('flow-pool');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  try {
    const growth = await createAccount(run, 'Synthetic Ternak 01', 'account_growth');
    let poolAcc = await createAccount(run, 'Synthetic Flow Pool 01', 'flow_pool');
    expect(poolAcc.sessions.map((s) => s.platformId)).toEqual(['google-flow']);
    expect(await call(run, 'updateAccount', poolAcc.id, 'Synthetic Flow Pool 01', 'affiliate_ugc')).toEqual({
      ok: false,
      error: { code: 'invalid_account', details: ['mode_change_not_allowed'] },
    });
    poolAcc = await ok<Account>(run, 'setAccountProxy', poolAcc.id, { protocol: 'http', host: '127.0.0.1', port: proxy.port }, false);
    await ui.reload();

    // Pool screen: starts with Google AI Pro defaults.
    await ui.getByRole('button', { name: 'Flow pool' }).click();
    await expect(ui.getByRole('heading', { name: 'Flow pool' })).toBeVisible();
    const row = ui.getByTestId('pool').locator('tr', { hasText: 'Synthetic Flow Pool 01' });
    await expect(row.getByTestId('pool-remaining')).toContainText('1,050');
    await expect(row.getByTestId('pool-remaining')).toContainText('~87 videos');
    await ui.getByRole('button', { name: '← All accounts' }).click();

    // A queued prompt in the Ternak Akun account goes to the pool account.
    await ui.locator('tr', { hasText: 'Synthetic Ternak 01' }).getByRole('button', { name: 'Prompt Studio' }).click();
    await ui.locator('input[name=count]').fill('2');
    await ui.getByRole('button', { name: 'Generate 2 prompts' }).click();
    await ui.getByRole('button', { name: 'Approve all unflagged drafts' }).click();
    await expect(ui.getByTestId('prompts-notice')).toContainText('Approved: 2 prompts');
    await ui.getByRole('button', { name: 'Queue all approved' }).click();
    const card = ui.locator('.batch').first().locator('article[data-position="1"]');
    const flowOpened = nextSiteWindow(run);
    await card.getByRole('button', { name: 'Generate in Flow pool' }).click();
    const flowWin = await flowOpened;
    expect(new URL(flowWin.url()).hostname).toBe('google-flow.ugc-poc.test');
    await expect(card).toHaveAttribute('data-status', 'generating');
    await expect(card).toContainText('Flow pool account “Synthetic Flow Pool 01”');
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Scene: ');

    // The owner generates and downloads in the pool account's window: the video comes back to the prompt's account.
    const mark = site.requests.length;
    await flowWin.goto(`${new URL(flowWin.url()).origin}/flow-download`);
    await flowWin.click('#mp4');
    await expect(card).toHaveAttribute('data-status', 'video_ready', { timeout: 15000 });
    const jobs = await ok<Array<{ bundleId: string; promptItemId: string | null; flowBundleId: string | null; videoFile: string | null; state: string }>>(
      run,
      'listGenerations',
      growth.id,
    );
    expect(jobs).toEqual([
      expect.objectContaining({ state: 'completed', bundleId: growth.id, flowBundleId: poolAcc.id, promptItemId: await card.getAttribute('data-prompt-id') }),
    ]);
    expect(jobs[0]!.videoFile).toMatch(new RegExp(`^library/${growth.id}/`));
    expect([...new Set(site.requests.slice(mark).map((r) => r.clientIp))]).toEqual([EXIT]); // through the pool account's proxy
    await flowWin.close();

    // Credits went down by one video.
    await ui.getByRole('button', { name: '← All accounts' }).click();
    await ui.getByRole('button', { name: 'Flow pool' }).click();
    await expect(row.getByTestId('pool-remaining')).toContainText('1,038');
    await row.getByLabel('Remaining credits shown in Flow for Synthetic Flow Pool 01').fill('1000');
    await row.getByRole('button', { name: 'set' }).click();
    await expect(row.getByTestId('pool-remaining')).toContainText('1,000');
    await ui.screenshot({ path: join(SHOTS, '03-flow-pool.png'), fullPage: true });
  } finally {
    await quit(run);
  }
});
