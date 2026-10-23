import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticProxy, startSyntheticSite, type SyntheticProxy, type SyntheticSite } from '@ugc/test-fixtures';
import { createAccount, fusedElectron, launch, nextSiteWindow, ok, quit, sessionOf, workDir, type Account } from './harness.js';

// A1 (Affiliate Factory): products by TikTok product ID, today's selection,
// the listing check and the assisted Showcase flow, with synthetic stand-ins
// for TikTok and Kalodata behind a synthetic proxy. Nothing reaches TikTok.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'factory-2', 'screenshots');
const A = '1729384756102938471';
const B = '1729384756102938472';
const C = '1729384756102938473';
let site: SyntheticSite;
let proxy: SyntheticProxy;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  proxy = await startSyntheticProxy({ exitIp: '198.51.100.61' });
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await proxy.close();
  await site.close();
});

test('Affiliate Products: capture IDs, select for today, confirm listing, assisted Showcase', async () => {
  const dir = await workDir('affiliate-ui');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  try {
    let account = await createAccount(run, 'Synthetic Affiliate 01', 'affiliate_ugc');
    account = await ok<Account>(run, 'setAccountProxy', account.id, { protocol: 'http', host: '127.0.0.1', port: proxy.port }, false);
    await createAccount(run, 'Synthetic Ternak 01', 'account_growth');
    await ui.reload();
    await expect(ui.locator('tr', { hasText: 'Synthetic Ternak 01' }).getByRole('button', { name: 'Products' })).toHaveCount(0);
    await ui.locator('tr', { hasText: 'Synthetic Affiliate 01' }).getByRole('button', { name: 'Products' }).click();
    await expect(ui.getByRole('heading', { name: 'Products · Synthetic Affiliate 01' })).toBeVisible();

    // Paste links/IDs: short links are refused with the reason.
    await ui.locator('textarea[name=product-links]').fill(`https://www.tiktok.com/view/product/${A}?region=ID\n${B}\nhttps://vt.tiktok.com/ZSynth/`);
    await ui.getByRole('button', { name: 'Add and fill from TikTok' }).click();
    await expect(ui.getByTestId('affiliate-notice')).toContainText('2 added, 0 already listed, 1 not recognised');
    await expect(ui.getByTestId('affiliate-notice')).toContainText('Short links');

    // Capture from the account's Kalodata window: only the address is read.
    await ui.getByRole('button', { name: 'Use the product open in Kalodata' }).click();
    await expect(ui.getByTestId('affiliate-notice')).toContainText('Kalodata window isn’t open');
    const kaloOpened = nextSiteWindow(run);
    await ui.getByRole('button', { name: 'Open Kalodata' }).click();
    const kalo = await kaloOpened;
    await kalo.goto(`${new URL(kalo.url()).origin}/product/detail?id=${C}`).catch(() => undefined);
    await ui.getByRole('button', { name: 'Use the product open in Kalodata' }).click();
    // A3: a newly captured product is then read from its listing in this account's TikTok window.
    await expect(ui.getByTestId('affiliate-notice')).toContainText('Filled “Serum Glow Sintetis 30 ml”: 3 features');
    await expect(ui.locator(`article[data-product-id="${C}"]`)).toHaveAttribute('data-listing', 'confirmed');
    await kalo.close();

    // Today's selection (limit 3).
    const card = (id: string) => ui.locator(`article[data-product-id="${id}"]`);
    for (const id of [A, B, C]) await card(id).getByRole('button', { name: 'Select for today' }).click();
    await expect(ui.getByTestId('affiliate-summary')).toContainText('3/3 selected for today');
    await expect(ui.getByTestId('today').locator('article')).toHaveCount(3);

    // Listing check in the account's TikTok window, then verified details.
    await expect(card(A).getByRole('button', { name: 'Add to Showcase' })).toBeDisabled();
    const productOpened = nextSiteWindow(run);
    await card(A).getByRole('button', { name: 'Open product' }).click();
    const productWin = await productOpened;
    expect(new URL(productWin.url()).pathname).toBe(`/view/product/${A}`);
    expect(new URL(productWin.url()).hostname).toBe('tiktok.ugc-poc.test');
    await productWin.close();
    await card(A).getByRole('button', { name: 'This is the exact listing' }).click();
    await card(A).getByRole('button', { name: 'Edit details' }).click();
    await card(A).locator('input[name=fact-title]').fill('Kipas Angin Mini Sintetis');
    await card(A).locator('input[name=fact-shop]').fill('Toko Sintetis');
    await card(A).locator('input[name=fact-price]').fill('89.000');
    await card(A).locator('input[name=fact-commission]').fill('12,5');
    await card(A).locator('textarea[name=fact-features]').fill('3 kecepatan angin\nBaterai isi ulang USB-C');
    await card(A).getByRole('button', { name: 'Save details' }).click();
    await expect(card(A).getByTestId('product-summary')).toHaveText('Rp89.000 · komisi 12,5% · toko Toko Sintetis · 2 fitur terverifikasi · 0 video referensi');
    await card(A).getByRole('combobox', { name: 'Can this account promote it?' }).selectOption('can_promote');

    // Assisted Showcase: TikTok's Showcase page opens in the account's window, product link on the clipboard.
    const showcaseOpened = nextSiteWindow(run);
    await card(A).getByRole('button', { name: 'Add to Showcase' }).click();
    const showcaseWin = await showcaseOpened;
    expect(new URL(showcaseWin.url()).pathname).toBe('/streamer/showcase/product/list');
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`https://www.tiktok.com/view/product/${A}`);
    await expect(card(A)).toHaveAttribute('data-showcase', 'in_progress');
    await expect(card(A).getByTestId('showcase-box')).toContainText('Showcase Products');
    await ui.screenshot({ path: join(SHOTS, '01-affiliate-products.png'), fullPage: true });
    await showcaseWin.close();
    await card(A).getByRole('button', { name: 'TikTok shows it in my Showcase' }).click();
    await expect(card(A).getByTestId('showcase-state')).toHaveText('Added: TikTok confirmation seen by you');
    await expect(ui.getByTestId('affiliate-summary')).toContainText('1 in Showcase');
    await ui.screenshot({ path: join(SHOTS, '02-showcase-confirmed.png'), fullPage: true });

    // Every page the flow opened went through this account's proxy (its exit IP), never direct.
    const opened = site.requests.filter((r) => r.path.startsWith(`/view/product/${A}`) || r.path.startsWith('/streamer/showcase') || r.path.startsWith('/product/detail'));
    expect(opened.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(opened.map((r) => r.clientIp))]).toEqual(['198.51.100.61']);
    expect(sessionOf(account, 'tiktok').platformId).toBe('tiktok');
  } finally {
    await quit(run);
  }
});
