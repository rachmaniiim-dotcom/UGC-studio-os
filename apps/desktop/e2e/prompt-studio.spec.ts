import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import { createAccount, fusedElectron, launch, ok, quit, stubOpenDialog, workDir } from './harness.js';

// T1 (Ternak Akun): the Prompt Studio screen with synthetic accounts, starter
// and owner templates, synthetic reference files and the synthetic video
// provider. Nothing reaches Google Flow or TikTok.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'factory-1', 'screenshots');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
let site: SyntheticSite;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await site.close();
});

const latest = (ui: Page) => ui.locator('.batch').first();
const card = (ui: Page, position: number) => latest(ui).locator(`article.prompt-card[data-position="${position}"]`);

test('Prompt Studio: generate, edit, regenerate, approve, queue and produce; owner templates; reference files', async () => {
  const dir = await workDir('prompt-studio');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  try {
    const account = await createAccount(run, 'Synthetic Ternak 01', 'account_growth');
    await createAccount(run, 'Synthetic Affiliate 01', 'affiliate_ugc');
    await ui.reload();
    await expect(ui.locator('tr', { hasText: 'Synthetic Affiliate 01' }).getByRole('button', { name: 'Prompt Studio' })).toHaveCount(0);
    await ui.locator('tr', { hasText: 'Synthetic Ternak 01' }).getByRole('button', { name: 'Prompt Studio' }).click();
    await expect(ui.getByRole('heading', { name: 'Prompt Studio · Synthetic Ternak 01' })).toBeVisible();
    await expect(ui.locator('[data-template-key]')).toHaveCount(3);

    // Account settings: the hands character, saved as a reusable preset.
    const hands = 'Synthetic hands: slender fingers, a thin jade bracelet on the left wrist, short clear nails, olive skin tone; the face is never shown.';
    await ui.locator('textarea[name=var-hands]').fill(hands);
    await ui.getByLabel('Name for this character').fill('Jade hands');
    await ui.getByRole('button', { name: 'Save character' }).click();
    await expect(ui.getByLabel('Load saved character')).toContainText('Jade hands');

    await ui.getByRole('button', { name: 'Generate 10 prompts' }).click();
    await expect(ui.getByTestId('config-notice')).toContainText('10 prompts generated as drafts');
    await expect(latest(ui).locator('article.prompt-card')).toHaveCount(10);
    await expect(latest(ui).locator('article[data-status=draft]')).toHaveCount(10);
    // Complete prompts with the character verbatim.
    for (const text of await latest(ui).getByTestId('prompt-text').allTextContents()) {
      expect(text).toContain(hands);
      expect(text).toContain('Camera: ');
      expect(text.length).toBeGreaterThan(900);
    }
    await ui.screenshot({ path: join(SHOTS, '01-prompt-studio-generated.png'), fullPage: true });

    // Edit #1's caption.
    await card(ui, 1).getByRole('button', { name: 'Edit' }).click();
    await card(ui, 1).locator('textarea[name=edit-caption]').fill('Synthetic edited caption #asmr');
    await card(ui, 1).getByRole('button', { name: 'Save edit' }).click();
    await expect(card(ui, 1).getByTestId('prompt-caption')).toHaveText('Synthetic edited caption #asmr');
    await expect(card(ui, 1)).toContainText('edited');

    // Break #2's character text: flagged and not approvable; regenerate fixes it.
    await card(ui, 2).getByRole('button', { name: 'Edit' }).click();
    await card(ui, 2).locator('textarea[name=edit-scene]').fill('Some hands do something.');
    await card(ui, 2).getByRole('button', { name: 'Save edit' }).click();
    await expect(card(ui, 2).locator('[data-value=consistency_missing]')).toBeVisible();
    await expect(card(ui, 2).getByRole('button', { name: 'Approve prompt' })).toBeDisabled();
    await card(ui, 2).getByRole('button', { name: 'Regenerate' }).click();
    await expect(card(ui, 2).locator('[data-value=consistency_missing]')).toHaveCount(0);
    await expect(card(ui, 2).getByTestId('prompt-text')).toContainText(hands);

    // Reject #3; approve the rest; queue them.
    await card(ui, 3).getByRole('button', { name: 'Reject' }).click();
    await expect(card(ui, 3)).toHaveAttribute('data-status', 'rejected');
    await ui.getByRole('button', { name: 'Approve all unflagged drafts' }).click();
    await expect(ui.getByTestId('prompts-notice')).toContainText('Approved: 9 prompts');
    const summary = ui.getByTestId('studio-summary');
    await expect(summary.locator('[data-status=approved]')).toContainText('9');
    await ui.getByRole('button', { name: 'Queue all approved' }).click();
    await expect(summary.locator('[data-status=queued]')).toContainText('9');
    await expect(summary.locator('[data-status=video_ready]')).toContainText('0');

    // Manual path: copy for Flow, mark as being generated in Flow.
    await card(ui, 4).getByRole('button', { name: 'Copy prompt for Flow' }).click();
    await expect(card(ui, 4).getByRole('button', { name: 'Copied ✓' })).toBeVisible();
    const clip = await run.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clip).toContain(hands);
    expect(clip).toContain('Scene: ');
    await card(ui, 4).getByRole('button', { name: 'I’m generating it in Flow' }).click();
    await expect(card(ui, 4)).toHaveAttribute('data-status', 'generating');
    await expect(card(ui, 4)).toContainText('download it in this account’s Google Flow window');

    // Provider path (synthetic provider), with an explicit credit confirmation.
    await card(ui, 5).getByRole('button', { name: /Generate with Synthetic/ }).click();
    await expect(card(ui, 5)).toContainText('Uses video-generation credits');
    await card(ui, 5).getByRole('button', { name: 'Confirm: generate video' }).click();
    await expect(card(ui, 5)).toHaveAttribute('data-status', 'video_ready', { timeout: 15000 });
    await expect(card(ui, 5).getByRole('button', { name: 'Show video in folder' })).toBeVisible();
    const jobs = await ok<Array<{ promptItemId: string | null; state: string }>>(run, 'listGenerations', account.id);
    expect(jobs).toEqual([expect.objectContaining({ state: 'completed', promptItemId: await card(ui, 5).getAttribute('data-prompt-id') })]);
    await expect(summary.locator('[data-status=video_ready]')).toContainText('1');
    await expect(summary.locator('[data-status=generating]')).toContainText('1');
    await ui.getByRole('tab', { name: /Queued/ }).click();
    await expect(latest(ui).locator('article.prompt-card')).toHaveCount(7);
    await ui.getByRole('tab', { name: 'All' }).click();
    await ui.screenshot({ path: join(SHOTS, '02-prompt-queue-and-statuses.png'), fullPage: true });

    // Owner master template: duplicate a starter, edit, save as a new version, generate from it.
    await ui.locator('[data-template-key=builtin-grandma]').getByRole('button', { name: 'Duplicate' }).click();
    const mine = ui.locator('[data-template-key^=custom-]');
    await expect(mine).toContainText('Grandma Messages (copy)');
    await mine.getByRole('button', { name: 'Edit' }).click();
    await ui.locator('input[name=tpl-name]').fill('Nenek Ratna Daily');
    await ui.locator('textarea[name=tpl-section-ending]').fill('{{ending}} {{not_a_variable}}');
    await ui.getByRole('button', { name: 'Save new version' }).click();
    await expect(ui.getByTestId('editor-error').locator('[data-field-issue=unknown_placeholder]')).toBeVisible();
    await ui.locator('textarea[name=tpl-section-ending]').fill('{{ending}} The camera holds on her smile for one more second.');
    const messages = ui.locator('textarea[name=tpl-options-message]');
    await messages.fill(`${await messages.inputValue()}\nNak, jangan lupa minum air putih dan tidur cukup ya.`);
    await ui.screenshot({ path: join(SHOTS, '03-template-editor.png'), fullPage: true });
    await ui.getByRole('button', { name: 'Save new version' }).click();
    await expect(mine).toContainText('Nenek Ratna Daily');
    await expect(mine).toContainText('v2 (2 versions)');
    await ui.locator('input[name=count]').fill('3');
    await ui.getByRole('button', { name: 'Generate 3 prompts' }).click();
    await expect(latest(ui).locator('article.prompt-card')).toHaveCount(3);
    await expect(latest(ui)).toContainText('Nenek Ratna Daily v2');
    await expect(latest(ui).getByTestId('prompt-text').first()).toContainText('The camera holds on her smile for one more second.');
    await expect(ui.locator('[data-template-key=builtin-grandma]')).toContainText('Starter');

    // Dance with a motion reference the owner has rights to: marked as manual action.
    await ui.locator('[data-template-key=builtin-dance]').getByRole('button', { name: 'Use' }).click();
    await expect(ui.getByRole('button', { name: 'Add reference file…' })).toBeDisabled();
    const motion = join(dir, 'synthetic-moves.mp4');
    await writeFile(motion, MP4);
    await writeFile(join(dir, 'unused.png'), PNG);
    await ui.locator('input[name=rights]').check();
    await stubOpenDialog(run, motion);
    await ui.getByRole('button', { name: 'Add reference file…' }).click();
    await expect(ui.locator('input[name="ref-synthetic-moves.mp4"]')).toBeChecked();
    await ui.locator('input[name=count]').fill('2');
    await ui.getByRole('button', { name: 'Generate 2 prompts' }).click();
    await expect(latest(ui).locator('article.prompt-card')).toHaveCount(2);
    await expect(card(ui, 1)).toContainText('needs manual action');
    await expect(card(ui, 1).getByTestId('manual-steps')).toContainText('no verified control');
    await card(ui, 1).scrollIntoViewIfNeeded();
    await ui.screenshot({ path: join(SHOTS, '04-dance-manual-action.png'), fullPage: true });

    await ui.getByRole('button', { name: '← All accounts' }).click();
    await expect(ui.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  } finally {
    await quit(run);
  }
});

test('T2: ready-to-post list, owner-recorded posts and the daily Ternak Akun board', async () => {
  const dir = await workDir('ternak-board');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  try {
    await createAccount(run, 'Synthetic Ternak 01', 'account_growth');
    await createAccount(run, 'Synthetic Ternak 02', 'account_growth');
    await createAccount(run, 'Synthetic Affiliate 01', 'affiliate_ugc');
    await ui.reload();
    await ui.locator('tr', { hasText: 'Synthetic Ternak 01' }).getByRole('button', { name: 'Prompt Studio' }).click();
    await ui.locator('input[name=count]').fill('3');
    await ui.getByRole('button', { name: 'Generate 3 prompts' }).click();
    await ui.getByRole('button', { name: 'Approve all unflagged drafts' }).click();
    await expect(ui.getByTestId('prompts-notice')).toContainText('Approved: 3 prompts');
    await ui.getByRole('button', { name: 'Queue all approved' }).click();
    await expect(ui.getByTestId('studio-summary').locator('[data-status=queued]')).toContainText('3');
    await expect(ui.getByTestId('ready-to-post')).toHaveCount(0);
    await card(ui, 1).getByRole('button', { name: /Generate with Synthetic/ }).click();
    await card(ui, 1).getByRole('button', { name: 'Confirm: generate video' }).click();
    await expect(card(ui, 1)).toHaveAttribute('data-status', 'video_ready', { timeout: 15000 });

    const ready = ui.getByTestId('ready-to-post').locator('li');
    await expect(ready).toHaveCount(1);
    const caption = (await card(ui, 1).getByTestId('prompt-caption').textContent())!;
    await ready.getByRole('button', { name: 'Copy caption' }).click();
    await expect(ready.getByRole('button', { name: 'Caption copied ✓' })).toBeVisible();
    expect(await run.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(caption);
    await ready.getByLabel('TikTok post link (optional)').fill('https://vm.tiktok.com/ZSynth/');
    await ready.getByRole('button', { name: 'I posted it' }).click();
    await expect(ui.getByTestId('post-notice')).toContainText('isn’t a TikTok video link');
    await ready.getByLabel('TikTok post link (optional)').fill('https://www.tiktok.com/@synth.ternak01/video/7000000000000000777');
    await ready.getByRole('button', { name: 'I posted it' }).click();
    await expect(ui.getByTestId('ready-to-post')).toHaveCount(0);
    await expect(ui.getByTestId('posted')).toContainText('https://www.tiktok.com/@synth.ternak01/video/7000000000000000777');
    await expect(card(ui, 1)).toContainText('Posted (marked by you)');
    await ui.getByRole('heading', { name: '4. Ready to post' }).scrollIntoViewIfNeeded();
    await ui.screenshot({ path: join(SHOTS, '05-ready-to-post.png'), fullPage: true });

    // The daily board: growth accounts only, today's numbers against each target.
    await ui.getByRole('button', { name: '← All accounts' }).click();
    await ui.getByRole('button', { name: 'Ternak Akun today' }).click();
    const board = ui.getByTestId('board');
    await expect(board.locator('tbody tr')).toHaveCount(2);
    await expect(board).not.toContainText('Synthetic Affiliate 01');
    const row = board.locator('tr', { hasText: 'Synthetic Ternak 01' });
    await expect(row.getByTestId('videos-today')).toContainText('1/10');
    await expect(row.getByTestId('posted-today')).toHaveText('1');
    await expect(row.getByTestId('ready-to-post')).toHaveText('0');
    await row.getByLabel('Daily target for Synthetic Ternak 01').fill('5');
    await row.getByRole('button', { name: 'save' }).click();
    await expect(row.getByTestId('videos-today')).toContainText('1/5');
    await expect(ui.getByTestId('board-summary')).toContainText('1/15 videos today');
    await ui.screenshot({ path: join(SHOTS, '06-ternak-akun-today.png'), fullPage: true });
    await row.getByRole('button', { name: 'Open Prompt Studio' }).click();
    await expect(ui.getByRole('heading', { name: 'Prompt Studio · Synthetic Ternak 01' })).toBeVisible();
  } finally {
    await quit(run);
  }
});
