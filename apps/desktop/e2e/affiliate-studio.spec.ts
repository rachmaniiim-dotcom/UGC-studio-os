import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, makeSyntheticClip, startSyntheticProxy, startSyntheticSite, type SyntheticProxy, type SyntheticSite } from '@ugc/test-fixtures';
import { createAccount, fusedElectron, launch, nextSiteWindow, ok, quit, sessionOf, stubOpenDialog, workDir, type Account } from './harness.js';

// A2 demonstration: synthetic affiliate account and product, a synthetic Flow
// pool account, clips made by the local FFmpeg from test patterns. One plan
// goes from approval to a joined ~16-second video, through a failed download,
// a rejected first cut and an approved second cut, into the video library.
// No real Flow, no credits, no TikTok.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'factory-2', 'screenshots');
const PRODUCT = '1729384756102938471';
let site: SyntheticSite;
let proxy: SyntheticProxy;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  proxy = await startSyntheticProxy({ exitIp: '198.51.100.81' });
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await proxy.close();
  await site.close();
});

test.skip(!findFfmpeg(), 'FFmpeg is not installed on this machine');

test('A2: plan → Clip A/B by hand → FFmpeg join → review → Affiliate Video Library', async () => {
  test.setTimeout(240_000);
  const dir = await workDir('affiliate-studio');
  const clip = (name: string, opts: Parameters<typeof makeSyntheticClip>[1] = {}) => {
    const f = join(dir, name);
    makeSyntheticClip(f, opts);
    return f;
  };
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  const p = { protocol: 'http', host: '127.0.0.1', port: proxy.port };
  try {
    const aff = await ok<Account>(run, 'setAccountProxy', (await createAccount(run, 'Synthetic Affiliate 01', 'affiliate_ugc')).id, p, false);
    const poolAcc = await ok<Account>(run, 'setAccountProxy', (await createAccount(run, 'Synthetic Flow Pool 01', 'flow_pool')).id, p, false);
    await ok(run, 'confirmStatus', sessionOf(poolAcc, 'google-flow').id, 'logged_in');
    // The affiliate account's own Flow session, just configured: no credit history, no saved Flow settings.
    await ok(run, 'confirmStatus', sessionOf(aff, 'google-flow').id, 'logged_in');
    const added = await ok<{ view: { products: Array<{ id: string }> } }>(run, 'addAffiliateProducts', aff.id, PRODUCT);
    const row = added.view.products[0]!.id;
    await ok(run, 'setProductListing', aff.id, row, 'confirmed');
    await ok(run, 'updateProductFacts', aff.id, row, { title: 'Kipas Angin Mini Sintetis', shopName: 'Toko Sintetis', priceIdr: '89000', features: ['3 kecepatan angin', 'baterai isi ulang USB-C'] });
    await ui.reload();

    await ui.locator('tr', { hasText: 'Synthetic Affiliate 01' }).getByRole('button', { name: 'Products' }).click();
    await ui.locator(`article[data-product-id="${PRODUCT}"]`).getByRole('button', { name: 'Create videos' }).click();
    await expect(ui.getByRole('heading', { name: 'Create videos · Kipas Angin Mini Sintetis' })).toBeVisible();
    // Both Flow identities are offered: the pool and the account's own new session (zero history, default settings).
    const flowSelect = ui.getByLabel('Flow account', { exact: true });
    await expect(flowSelect.locator('option', { hasText: 'Synthetic Affiliate 01 (own session) · 1050 left' })).toHaveCount(1);
    await expect(flowSelect.locator('option', { hasText: 'Synthetic Flow Pool 01 (pool)' })).toHaveCount(1);
    await expect(flowSelect).toHaveValue('pool');
    await ui.getByRole('button', { name: 'or plan 10 as drafts to review first' }).click();
    const plans = ui.locator('article.plan-card');
    await expect(plans).toHaveCount(10);
    const plan = ui.locator('article.plan-card[data-position="1"]');
    await expect(plan).toHaveAttribute('data-status', 'draft');
    await expect(plan.getByTestId('clip-a-text')).toContainText('Kipas Angin Mini Sintetis');
    await expect(plan.getByTestId('clip-b-text')).toContainText('keranjang kuning');
    await ui.screenshot({ path: join(SHOTS, '04-affiliate-plans.png'), fullPage: false });

    // Approve (nothing is spent before this), then Clip A to the Flow pool.
    await plan.getByRole('button', { name: 'Approve plan' }).click();
    await expect(plan).toHaveAttribute('data-status', 'approved');
    const clipA = plan.locator('[data-clip-slot="A"]');
    const clipB = plan.locator('[data-clip-slot="B"]');
    const flowOpened = nextSiteWindow(run);
    await clipA.getByRole('button', { name: 'Send to Flow' }).click();
    // No product photo or character sheet in this test: refused with the reason, then sent without them on purpose.
    await expect(ui.getByTestId('astudio-notice')).toContainText('reference images aren’t ready');
    await ui.getByRole('button', { name: 'send without reference images' }).click();
    const flow = await flowOpened;
    expect(new URL(flow.url()).hostname).toBe('google-flow.ugc-poc.test');
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Clip A of 2');
    await expect(clipA).toHaveAttribute('data-clip-status', 'in_flow');
    // The synthetic "Flow" serves a file that only looks like an MP4: it arrives (credits counted) but is unusable.
    await flow.goto(`${new URL(flow.url()).origin}/flow-download`);
    await flow.click('#mp4');
    await expect(clipA).toHaveAttribute('data-clip-status', 'unusable', { timeout: 20_000 });
    await expect(ui.getByTestId('astudio-today')).toContainText('1 unusable outputs');
    await flow.close();

    // Import real clips (as if downloaded from Flow): Clip A 720×1280 24 fps with audio, Clip B silent.
    await stubOpenDialog(run, clip('clip-a.mp4', { width: 720, height: 1280, fps: 24 }));
    await clipA.getByRole('button', { name: 'Import clip file…' }).click();
    await expect(clipA).toHaveAttribute('data-clip-status', 'received');
    await stubOpenDialog(run, clip('clip-b.mp4', { audio: false, pattern: 'smptebars' }));
    await clipB.getByRole('button', { name: 'Import clip file…' }).click();
    await expect(plan).toHaveAttribute('data-status', 'review', { timeout: 60_000 });
    const final = plan.getByTestId('final');
    await expect(final).toContainText('1080×1920');
    // The in-app player loads the joined file through the app's read-only /media/ path.
    const seconds = await final.locator('video').evaluate(
      (v: HTMLVideoElement) => new Promise<number>((resolve, reject) => {
        if (v.readyState >= 1) return resolve(v.duration);
        v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
        v.addEventListener('error', () => reject(new Error('video error')), { once: true });
      }),
    );
    expect(seconds).toBeGreaterThan(15.5);
    expect(seconds).toBeLessThan(16.6);
    // The media path serves library videos by id only: anything else is refused.
    const refused = await ui.evaluate(async () => {
      const tryLoad = (src: string) =>
        new Promise<string>((resolve) => {
          const v = document.createElement('video');
          v.onloadedmetadata = () => resolve('loaded');
          v.onerror = () => resolve('refused');
          v.src = src;
        });
      return Promise.all(['/media/job/..%2F..%2Fugc.db', '/media/final/not-an-id', '/media/job/00000000-0000-4000-8000-000000000000'].map(tryLoad));
    });
    expect(refused).toEqual(['refused', 'refused', 'refused']);
    await plan.scrollIntoViewIfNeeded();
    await ui.screenshot({ path: join(SHOTS, '05-affiliate-review.png'), fullPage: false });

    // Reject the first cut (continuity), redo Clip B, approve the second cut.
    await final.getByLabel('Reject reason').selectOption('continuity');
    await final.getByLabel('Clip to redo').selectOption('B');
    await final.getByRole('button', { name: 'Reject video' }).click();
    await expect(plan).toHaveAttribute('data-status', 'producing');
    await expect(clipB).toHaveAttribute('data-clip-status', 'unusable');
    await stubOpenDialog(run, clip('clip-b2.mp4', { tone: 660 }));
    await clipB.getByRole('button', { name: 'Import clip file…' }).click();
    await expect(plan).toHaveAttribute('data-status', 'review', { timeout: 60_000 });
    await plan.getByTestId('final').getByRole('button', { name: 'Approve video' }).click();
    await expect(plan).toHaveAttribute('data-status', 'final_approved');
    await expect(ui.getByTestId('astudio-today')).toContainText('2 approved clips');
    await expect(ui.getByTestId('astudio-today')).toContainText('1 approved videos');

    // Library: product, Showcase state, the Flow account of each clip, source clips and the final MP4.
    await ui.getByRole('button', { name: 'Video library' }).first().click();
    const lib = ui.locator('article.library-card');
    await expect(lib).toHaveCount(1);
    await expect(lib).toContainText(PRODUCT);
    await expect(lib).toContainText('Showcase: not requested');
    await expect(lib).toHaveAttribute('data-status', 'final_approved');
    await expect(lib.locator('[data-clip-slot="A"]')).toContainText('attempts 2');
    await expect(lib.getByTestId('library-final')).toContainText('1080×1920');
    await ui.screenshot({ path: join(SHOTS, '06-affiliate-video-library.png'), fullPage: true });

    // Credits went to the Flow pool account that produced the (unusable) download, not to the TikTok account.
    await ui.getByRole('button', { name: '← All accounts' }).click();
    await ui.getByRole('button', { name: 'Flow pool' }).click();
    await expect(ui.getByTestId('pool').locator('tr', { hasText: 'Synthetic Flow Pool 01' }).getByTestId('pool-remaining')).toContainText('1,038');
    // The affiliate account's own session is listed with editable default settings and no credits used.
    const own = ui.getByTestId('pool').locator('tr', { hasText: 'Synthetic Affiliate 01' });
    await expect(own).toContainText('default settings: edit and save');
    await expect(own.getByTestId('pool-remaining')).toContainText('1,050');
    await own.getByLabel('Daily credit limit for Synthetic Affiliate 01').fill('240');
    await own.getByRole('button', { name: 'save' }).click();
    await expect(own).not.toContainText('default settings');
    await expect(own.getByTestId('pool-remaining')).toContainText('/ 240');
  } finally {
    await quit(run);
  }
});
