import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticProxy, startSyntheticSite, type SyntheticProxy, type SyntheticSite } from '@ugc/test-fixtures';
import { createAccount, fusedElectron, launch, nextSiteWindow, ok, quit, workDir, type Account, type Running } from './harness.js';

// Ternak Akun G1 on synthetic stand-ins and the deterministic test analyzer:
// finished MP4s → captions from each video → posting queue → TikTok's upload
// page in the account's window → "I posted it"; and FYP reference → format
// breakdown → original prompts → a finished video (synthetic provider) → the
// same queue. No real TikTok, Flow, AI service or credits.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'factory-1', 'screenshots');
let site: SyntheticSite;
let proxy: SyntheticProxy;
let executablePath: string;
test.beforeAll(async () => {
  site = await startSyntheticSite();
  proxy = await startSyntheticProxy({ exitIp: '198.51.100.83' });
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await proxy.close();
  await site.close();
});

const fakeMp4 = (file: string, seed: number): string => {
  const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
  writeFileSync(file, Buffer.concat([ftyp, Buffer.alloc(4096, seed)]));
  return file;
};
/** The next native open dialog returns these files. */
const stubDialog = (run: Running, paths: string[]) =>
  run.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as unknown as typeof dialog.showOpenDialog;
  }, paths);

test('Ternak Akun: ready-made videos and FYP-reference videos share one captioned posting queue', async () => {
  test.setTimeout(180_000);
  const dir = await workDir('growth-queue');
  const run = await launch({ userData: join(dir, 'userData'), site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
  const ui = run.ui;
  try {
    const acc = await ok<Account>(run, 'setAccountProxy', (await createAccount(run, 'Synthetic Ternak 01', 'account_growth')).id, { protocol: 'http', host: '127.0.0.1', port: proxy.port }, false);
    await run.app.evaluate(({ shell }) => {
      shell.showItemInFolder = () => undefined;
    });
    await ui.reload();
    await ui.locator('tr', { hasText: 'Synthetic Ternak 01' }).getByRole('button', { name: 'Posting queue' }).click();
    await expect(ui.getByRole('heading', { name: 'Posting queue · Synthetic Ternak 01' })).toBeVisible();
    await expect(ui.getByTestId('gq-summary')).toContainText('0/10 posted today');
    await expect(ui.getByTestId('gq-ai')).toContainText('test analyzer (no cost)');

    // 1. Ready-made: three new videos and one copy of a video already chosen.
    const files = [
      fakeMp4(join(dir, 'masak nasi goreng kilat.mp4'), 1),
      fakeMp4(join(dir, 'unclear clip.mp4'), 2),
      fakeMp4(join(dir, 'lipat baju cepat.mp4'), 3),
      fakeMp4(join(dir, 'copy of masak.mp4'), 1),
    ];
    await stubDialog(run, files);
    await ui.getByRole('button', { name: 'Choose MP4 files…' }).click();
    await expect(ui.getByTestId('gq-notice')).toContainText('3 added, 1 already in this queue (copy of masak.mp4)');
    const item = (name: string) => ui.locator(`article.queue-card[data-name="${name}"]`);
    await expect(item('masak nasi goreng kilat.mp4')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await expect(item('masak nasi goreng kilat.mp4').getByLabel('Caption')).toHaveValue(/masak nasi goreng kilat/);
    await expect(item('masak nasi goreng kilat.mp4')).toHaveAttribute('data-source', 'ready_made');
    // The AI couldn't tell what this one shows: flagged, no invented caption.
    await expect(item('unclear clip.mp4')).toHaveAttribute('data-status', 'needs_review');
    await expect(item('unclear clip.mp4').getByTestId('gq-flags')).toContainText('couldn’t tell what this video shows');
    await expect(item('unclear clip.mp4').getByLabel('Caption')).toHaveValue('');
    await item('unclear clip.mp4').getByLabel('Caption').fill('Detik-detik paling bikin kaget hari ini');
    await item('unclear clip.mp4').getByLabel('Hashtags').fill('#kaget #harian');
    await item('unclear clip.mp4').getByRole('button', { name: 'Save caption' }).click();
    await expect(item('unclear clip.mp4')).toHaveAttribute('data-status', 'ready');
    await expect(ui.getByTestId('gq-summary')).toContainText('3 ready to post');
    await ui.screenshot({ path: join(SHOTS, '06-posting-queue.png'), fullPage: false });

    // Posting: TikTok's own upload page in this account's window, caption on the clipboard. The owner posts.
    const uploadOpened = nextSiteWindow(run);
    await item('masak nasi goreng kilat.mp4').getByRole('button', { name: 'Post on TikTok…' }).click();
    const upload = await uploadOpened;
    expect(new URL(upload.url()).hostname).toBe('tiktok.ugc-poc.test');
    expect(new URL(upload.url()).pathname).toBe('/tiktokstudio/upload');
    const clip = await run.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clip).toContain('masak nasi goreng kilat');
    expect(clip).toContain('#masak');
    await upload.close();
    expect(site.requests.filter((r) => r.path === '/tiktokstudio/upload').every((r) => r.clientIp === '198.51.100.83')).toBe(true);
    await item('masak nasi goreng kilat.mp4').getByRole('button', { name: 'I posted it' }).click();
    await expect(ui.getByTestId('gq-summary')).toContainText('1/10 posted today');
    await expect(item('masak nasi goreng kilat.mp4')).toHaveCount(1);
    await ui.getByRole('tab', { name: /Posted/ }).click();
    await expect(item('masak nasi goreng kilat.mp4')).toHaveAttribute('data-status', 'posted');
    await ui.getByRole('tab', { name: /All/ }).click();

    // 2. AI-generated: an FYP reference → its format → 2 original prompts.
    await stubDialog(run, [fakeMp4(join(dir, 'fyp reference.mp4'), 9)]);
    await ui.getByLabel('These are reference files I may use for analysis').check();
    await ui.getByRole('button', { name: /Add reference videos/ }).click();
    await expect(ui.getByRole('button', { name: 'Add reference videos… (1)' })).toBeVisible();
    await ui.getByRole('button', { name: 'Analyze format' }).click();
    await expect(ui.getByTestId('gq-analysis')).toContainText('Format:');
    await expect(ui.getByTestId('gq-analysis')).toContainText('Beats:');
    await ui.getByLabel('How many original videos').fill('2');
    await ui.getByRole('button', { name: 'Write original prompts' }).click();
    await expect(ui.getByTestId('gq-notice')).toContainText('2 original prompts are in Prompt Studio’s queue');

    // They're queued in Prompt Studio; one is produced (synthetic provider stands in for Flow).
    await ui.getByRole('button', { name: 'Open Prompt Studio' }).click();
    const batch = ui.locator('.batch').first();
    await expect(batch.locator('article.prompt-card[data-status="queued"]')).toHaveCount(2);
    await expect(batch.locator('article.prompt-card').first()).toContainText('Hook (first 1–2 seconds)');
    const first = batch.locator('article.prompt-card[data-position="1"]');
    await first.getByRole('button', { name: /Generate with Synthetic/ }).click();
    await first.getByRole('button', { name: 'Confirm: generate video' }).click();
    await expect(first).toHaveAttribute('data-status', 'video_ready', { timeout: 20_000 });

    // The finished video is in the same queue, captioned, marked AI-generated.
    await ui.getByRole('button', { name: '← All accounts' }).click();
    await ui.locator('tr', { hasText: 'Synthetic Ternak 01' }).getByRole('button', { name: 'Posting queue' }).click();
    const ai = ui.locator('article.queue-card[data-source="ai_generated"]');
    await expect(ai).toHaveCount(1);
    await expect(ai).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await expect(ai.getByLabel('Caption')).not.toHaveValue('');
    await expect(ui.getByTestId('gq-summary')).toContainText('3 ready to post');
  } finally {
    await quit(run);
  }
});
