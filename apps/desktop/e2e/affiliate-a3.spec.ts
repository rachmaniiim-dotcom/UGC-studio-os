import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticProxy, startSyntheticSite, type SyntheticProxy, type SyntheticSite } from '@ugc/test-fixtures';
import { createAccount, fusedElectron, launch, nextSiteWindow, ok, quit, sessionOf, workDir, type Account } from './harness.js';

// A3 morning flow on synthetic stand-ins: paste one product link → the app reads
// the listing in the account's TikTok window (after the owner completes a
// security check there) → one click makes and approves the plans → "Send next
// clip" takes clips to Flow one at a time. No real TikTok, Flow or credits.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'factory-2', 'screenshots');
const PRODUCT = '1738036500000000001';
let site: SyntheticSite;
let proxy: SyntheticProxy;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  proxy = await startSyntheticProxy({ exitIp: '198.51.100.82' });
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await proxy.close();
  await site.close();
});

test('A3: link → listing read (after a security check) → one-click videos → next clip to Flow', async () => {
  test.setTimeout(180_000);
  const dir = await workDir('affiliate-a3');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  const p = { protocol: 'http', host: '127.0.0.1', port: proxy.port };
  try {
    const aff = await ok<Account>(run, 'setAccountProxy', (await createAccount(run, 'Synthetic Beauty 01', 'affiliate_ugc')).id, p, false);
    const pool = await ok<Account>(run, 'setAccountProxy', (await createAccount(run, 'Synthetic Flow Pool 01', 'flow_pool')).id, p, false);
    await ok(run, 'confirmStatus', sessionOf(pool, 'google-flow').id, 'logged_in');
    await ui.reload();

    await ui.locator('tr', { hasText: 'Synthetic Beauty 01' }).getByRole('button', { name: 'Products' }).click();
    await ui.getByLabel('Use the listing photo as the product reference in Flow (products I promote)').check();
    await ui.locator('textarea[name="product-links"]').fill(`https://www.tiktok.com/view/product/${PRODUCT}?region=ID`);
    site.listingSecurityCheck(true);
    const listingOpened = nextSiteWindow(run);
    await ui.getByRole('button', { name: 'Add and fill from TikTok' }).click();
    const listing = await listingOpened;
    expect(new URL(listing.url()).hostname).toBe('tiktok.ugc-poc.test');
    // TikTok asks for a security check: the app waits; the owner completes it in that window.
    await expect(listing.locator('#verify')).toBeVisible();
    await expect(ui.getByTestId('affiliate-notice')).toContainText('complete it in that window');
    await listing.click('#verify');

    const card = ui.locator(`article[data-product-id="${PRODUCT}"]`);
    await expect(card).toHaveAttribute('data-listing', 'confirmed', { timeout: 30_000 });
    await expect(card.locator('header')).toContainText('Serum Glow Sintetis 30 ml');
    await expect(card.locator('header')).toContainText('photo');
    await expect(card.getByTestId('product-summary')).toContainText('Rp89.000');
    await expect(card.getByTestId('product-summary')).toContainText('toko Toko Glow Sintetis');
    await expect(card.locator('ul.features li')).toHaveText(['Membantu mencerahkan kulit kusam', 'Tekstur ringan, cepat meresap', 'Isi 30 ml dengan pipet']);
    await expect(ui.getByTestId('affiliate-notice')).toContainText('3 features, photo saved');
    // Every listing request went through the account's proxy.
    expect(site.requests.filter((r) => r.path.startsWith('/view/product/') || r.path === '/product-image.png').every((r) => r.clientIp === '198.51.100.82')).toBe(true);
    expect(site.requests.some((r) => r.path === '/product-image.png')).toBe(true);
    await listing.close();

    // Create videos: one click plans and approves (3 here to keep the test short).
    await card.getByRole('button', { name: 'Create videos' }).click();
    await expect(ui.getByRole('heading', { name: 'Create videos · Serum Glow Sintetis 30 ml' })).toBeVisible();
    const rowId = (await ok<{ products: Array<{ id: string }> }>(run, 'affiliateView', aff.id)).products[0]!.id;
    const current = await ok<{ config: Record<string, unknown> }>(run, 'affiliateStudioView', aff.id, rowId);
    await ok(run, 'saveAffiliateCreative', aff.id, rowId, { ...current.config, count: 3 });
    await ui.reload();
    await ui.locator('tr', { hasText: 'Synthetic Beauty 01' }).getByRole('button', { name: 'Products' }).click();
    await card.getByRole('button', { name: 'Create videos' }).click();

    await ui.getByRole('button', { name: 'Make 3 videos' }).click();
    await expect(ui.getByTestId('astudio-notice')).toContainText('3 videos planned and approved');
    await expect(ui.locator('article.plan-card[data-status="approved"]')).toHaveCount(3);
    await expect(ui.getByTestId('astudio-queue')).toContainText('6 clips to make');
    await ui.screenshot({ path: join(SHOTS, '07-a3-one-click-videos.png'), fullPage: false });

    // Without character sheets, sending is refused with what's missing.
    await ui.getByRole('button', { name: 'Send next clip to Flow' }).click();
    await expect(ui.getByTestId('astudio-notice')).toContainText('reference images aren’t ready');
    await expect(ui.getByTestId('astudio-notice')).toContainText('Character reference sheet');
    await expect(ui.getByTestId('astudio-product-photo')).toContainText('.png');
    // Each character the plans use gets one sheet: its prompt is copied for Flow, the image is added here.
    const characters = ui.getByTestId('astudio-characters').locator('li[data-character-key]');
    const n = await characters.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const li = characters.nth(i);
      await li.getByRole('button', { name: 'Copy sheet prompt' }).click();
      expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Character reference sheet of');
      const sheet = join(dir, `sheet-${i}.png`);
      writeFileSync(sheet, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, i + 1)]));
      await run.app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as unknown as typeof dialog.showOpenDialog;
      }, sheet);
      await li.getByRole('button', { name: 'Add sheet image…' }).click();
      await expect(li).toHaveAttribute('data-has-image', 'yes');
    }
    const opened: string[] = [];
    await run.app.evaluate(({ shell }) => {
      (globalThis as { __opened?: string[] }).__opened = [];
      shell.openPath = (async (p: string) => {
        (globalThis as { __opened?: string[] }).__opened!.push(p);
        return '';
      }) as typeof shell.openPath;
    });

    // Send next clip: video 1 Clip A goes to the pool's Flow window with its prompt on the clipboard,
    // and a folder with exactly its two reference images opens to drag into Flow.
    const flowOpened = nextSiteWindow(run);
    await ui.getByRole('button', { name: 'Send next clip to Flow' }).click();
    const flow = await flowOpened;
    opened.push(...(await run.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])));
    expect(opened).toHaveLength(1);
    expect(existsSync(opened[0]!)).toBe(true);
    expect(readdirSync(opened[0]!).sort()).toEqual(['1-product.png', '2-character.png']);
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Reference images uploaded with this prompt');
    await expect(ui.getByTestId('astudio-notice')).toContainText('drag both into Flow as ingredients');
    expect(new URL(flow.url()).hostname).toBe('google-flow.ugc-poc.test');
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Clip A of 2');
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Serum Glow Sintetis 30 ml');
    await expect(ui.getByTestId('astudio-notice')).toContainText('Video 1 · Clip A');
    await expect(ui.getByTestId('astudio-queue')).toContainText('Video 1 · Clip A is in Flow');
    await expect(ui.getByRole('button', { name: 'Send next clip to Flow' })).toBeDisabled();
    // The synthetic download isn't a real MP4: counted, marked unusable, and Clip A is next again.
    await flow.goto(`${new URL(flow.url()).origin}/flow-download`);
    await flow.click('#mp4');
    await expect(ui.locator('article.plan-card[data-position="1"] [data-clip-slot="A"]')).toHaveAttribute('data-clip-status', 'unusable', { timeout: 20_000 });
    await expect(ui.getByRole('button', { name: 'Send next clip to Flow' })).toBeEnabled();
    await flow.close();
  } finally {
    await quit(run);
  }
});
