import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticSite, SYNTHETIC_REJECTED_ROWS, SYNTHETIC_ROW_COUNT, syntheticReferenceCsv, syntheticVideoUrl, type SyntheticSite } from '@ugc/test-fixtures';
import { createAccount, fusedElectron, launch, quit, stubOpenDialog, workDir } from './harness.js';

// Gate 5 (R1/R2): the Growth Intelligence screen, driven through the UI with
// the synthetic research dataset. No network: nothing is fetched from TikTok.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'gate-5', 'screenshots');
const ACCEPTED = SYNTHETIC_ROW_COUNT - SYNTHETIC_REJECTED_ROWS;
let site: SyntheticSite;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await site.close();
});

test('Growth Intelligence: strategy, CSV import, scoring, validation, shortlist', async () => {
  const dir = await workDir('growth-ui');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  try {
    await createAccount(run, 'Growth Research 01', 'account_growth');
    await createAccount(run, 'Affiliate 01', 'affiliate_ugc');
    await ui.reload();
    // Only growth accounts get the screen.
    await expect(ui.locator('tr', { hasText: 'Affiliate 01' }).getByRole('button', { name: 'Growth Intelligence' })).toHaveCount(0);
    await ui.locator('tr', { hasText: 'Growth Research 01' }).getByRole('button', { name: 'Growth Intelligence' }).click();
    await expect(ui.getByRole('heading', { name: 'Growth Intelligence · Growth Research 01' })).toBeVisible();
    await expect(ui.getByTestId('growth-summary')).toContainText('0 references');
    await expect(ui.getByText('Not saved yet. Default thresholds are in use.')).toBeVisible();

    // R1: strategy and editable thresholds, with field-level validation.
    await ui.locator('input[name=niche]').fill('Synthetic home & kitchen');
    await ui.locator('input[name=subNiches]').fill('kitchen gadgets, cleaning hacks');
    await ui.locator('input[name=audience]').fill('Synthetic audience, 22–35');
    await ui.locator('input[name=outlierThreshold]').fill('1');
    await ui.getByRole('button', { name: 'Save strategy' }).click();
    await expect(ui.getByTestId('strategy-notice').locator('[data-field-issue=invalid_outlier_threshold]')).toBeVisible();
    await ui.locator('input[name=outlierThreshold]').fill('3');
    await ui.getByRole('button', { name: 'Save strategy' }).click();
    await expect(ui.getByTestId('strategy-notice')).toContainText('Strategy and thresholds saved');

    // Reference creators.
    await ui.locator('input[name=creatorHandle]').fill('https://www.tiktok.com/@synth.kitchen.lab');
    await ui.locator('input[name=creatorNote]').fill('Synthetic reference creator');
    await ui.getByRole('button', { name: 'Add creator' }).click();
    await ui.locator('input[name=creatorHandle]').fill('not a handle!');
    await ui.getByRole('button', { name: 'Add creator' }).click();
    await expect(ui.getByTestId('creator-notice')).toContainText('valid TikTok handle');

    // CSV import (pasted): accepted rows scored, bad rows explained per row.
    await ui.locator('textarea[name=csv-text]').fill(syntheticReferenceCsv());
    await ui.getByRole('button', { name: 'Import pasted CSV' }).click();
    await expect(ui.getByTestId('csv-notice')).toContainText(`${ACCEPTED} added, 0 updated, ${SYNTHETIC_REJECTED_ROWS} rejected`);
    await expect(ui.getByTestId('csv-rejections')).toContainText('Short links');
    await expect(ui.getByTestId('csv-rejections')).toContainText('Views: a number like');
    await expect(ui.getByTestId('creators')).toContainText('synth.kitchen.lab 12 reference video(s)');
    const summary = ui.getByTestId('growth-summary');
    await expect(summary).toContainText(`${ACCEPTED} references`);
    await expect(summary).toContainText('2 outliers');
    await expect(summary).toContainText('2 shortlisted');
    const shortlist = ui.getByTestId('shortlist').locator('li');
    await expect(shortlist).toHaveCount(2);
    await expect(shortlist.first()).toContainText('@synth.kitchen.lab');
    await expect(shortlist.first()).toContainText('7.4×');
    await expect(shortlist.first()).toContainText('high confidence');
    await expect(shortlist.nth(1)).toContainText('low confidence');
    const rows = ui.getByTestId('references').locator('tbody tr');
    await expect(rows).toHaveCount(ACCEPTED);
    await expect(ui.locator('tr[data-verdict=unverified]').first()).toContainText('Unverified: only');
    await expect(ui.locator('tr[data-verdict=missing_metrics]')).toContainText('No view count entered');
    await ui.screenshot({ path: join(SHOTS, '01-growth-intelligence.png'), fullPage: true });

    // Manual entry: a short link is refused with a clear field message.
    await ui.locator('input[name=ref-url]').fill('https://vm.tiktok.com/ZSynth02/');
    await ui.getByRole('button', { name: 'Add reference' }).click();
    await expect(ui.getByTestId('addref-notice').locator('[data-field-issue=short_link_unsupported]')).toBeVisible();
    // A valid entry with too little baseline is unverified, but pinning keeps it on the shortlist.
    await ui.locator('input[name=ref-url]').fill(syntheticVideoUrl('synth.new.creator', 60));
    await ui.locator('input[name=ref-publishedAt]').fill(new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10));
    await ui.locator('input[name=ref-views]').fill('1,2 jt');
    await ui.locator('input[name=ref-pinned]').check();
    await ui.getByRole('button', { name: 'Add reference' }).click();
    await expect(ui.getByTestId('addref-notice')).toContainText('Reference added and scored');
    await expect(shortlist).toHaveCount(3);
    await expect(shortlist.nth(2)).toContainText('Unverified · pinned');

    // Missing metrics → fill them in → scored.
    const missing = ui.locator('tr[data-verdict=missing_metrics]');
    await missing.getByRole('button', { name: 'Edit metrics' }).click();
    await missing.locator('input[name=edit-views]').fill('30000');
    await missing.getByRole('button', { name: 'Save' }).click();
    await expect(ui.locator('tr[data-verdict=missing_metrics]')).toHaveCount(0);

    // Relevance: the owner can drop a real outlier from the shortlist.
    await shortlist.first().waitFor();
    const strong = ui.locator('tr[data-verdict=outlier][data-confidence=high]');
    await strong.getByLabel('Relevance').selectOption('not_relevant');
    await expect(shortlist).toHaveCount(2);
    await expect(ui.locator('tr[data-verdict=outlier][data-confidence=high]')).toHaveCount(0);

    // Thresholds re-score immediately.
    await ui.locator('input[name=outlierThreshold]').fill('5');
    await ui.getByRole('button', { name: 'Save strategy' }).click();
    await expect(summary).toContainText('0 outliers');
    await expect(shortlist).toHaveCount(1); // only the pinned reference remains
    await ui.locator('input[name=outlierThreshold]').fill('3');
    await ui.getByRole('button', { name: 'Save strategy' }).click();
    await expect(summary).toContainText('1 outliers');

    // CSV file import (main process reads the file): re-import updates, no duplicates.
    const file = join(dir, 'synthetic-references.csv');
    await writeFile(file, syntheticReferenceCsv());
    await stubOpenDialog(run, file);
    await ui.getByRole('button', { name: 'Import CSV file…' }).click();
    await expect(ui.getByTestId('csv-notice')).toContainText(`0 added, ${ACCEPTED} updated, ${SYNTHETIC_REJECTED_ROWS} rejected`);
    await expect(rows).toHaveCount(ACCEPTED + 1);
    await ui.getByTestId('references').scrollIntoViewIfNeeded();
    await ui.screenshot({ path: join(SHOTS, '02-growth-after-edits.png'), fullPage: true });

    // Back to the dashboard.
    await ui.getByRole('button', { name: '← All accounts' }).click();
    await expect(ui.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  } finally {
    await quit(run);
  }
});
