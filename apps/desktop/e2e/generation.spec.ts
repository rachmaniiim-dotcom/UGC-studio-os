import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticProxy, startSyntheticSite, type SyntheticProxy, type SyntheticSite } from '@ugc/test-fixtures';
import { accounts, call, createAccount, fusedElectron, launch, nextSiteWindow, ok, quit, sessionOf, workDir, type Account, type Running } from './harness.js';

// Gate 4: platform-independent video generation with the synthetic provider,
// and the one download exception (a video the owner downloads by hand in a
// bundle's Google Flow window → that bundle's library). Synthetic only.

const EXIT = '198.51.100.40';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'gate-4', 'screenshots');
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

const start = (userData: string, synthetic = true): Promise<Running> =>
  launch({ userData, site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false, synthetic });
type Job = { id: string; state: string; errorCode: string | null; needsUser: boolean; source: string; videoFile: string | null; videoBytes: number | null };
const jobsOf = (run: Running, a: Account) => ok<Job[]>(run, 'listGenerations', a.id);

async function openGrowthEditor(ui: Page, name: string): Promise<void> {
  await ui.getByRole('button', { name: '+ Add account' }).click();
  await ui.locator('input[name=displayName]').fill(name);
  await ui.getByLabel('Account Growth (Ternak Akun)').check();
  await ui.getByRole('button', { name: 'Save draft' }).click();
  await expect(ui.getByTestId('editor-account-status')).toBeVisible();
}

test('Growth account: save the creative brief, generate one video, see it saved; failures explained', async () => {
  const userData = join(await workDir('gen-ui'), 'userData');
  const run = await start(userData);
  const ui = run.ui;
  try {
    await openGrowthEditor(ui, 'Growth Video 01');
    // Nothing to generate until a brief is saved.
    await expect(ui.getByRole('button', { name: 'Generate one video' })).toBeDisabled();
    await ui.locator('textarea[name=creative-prompt]').fill('Unboxing a desk lamp, warm light');
    await ui.locator('select[name=durationSeconds]').selectOption('6');
    await ui.getByRole('button', { name: 'Save video settings' }).click();
    await expect(ui.getByTestId('video-notice')).toContainText('Video settings saved');
    await expect(ui.getByTestId('generation-provider')).toContainText('Synthetic test provider · 0 of 3 today');

    await ui.getByRole('button', { name: 'Generate one video' }).click();
    const row = ui.locator('table.jobs tr').first();
    await expect(row).toHaveAttribute('data-state', 'completed');
    await expect(row.getByRole('button', { name: 'Show in folder' })).toBeVisible();

    const [account] = await accounts(run);
    const [job] = await jobsOf(run, account!);
    expect(job).toMatchObject({ state: 'completed', source: 'provider', needsUser: false });
    const file = join(userData, ...job!.videoFile!.split('/'));
    expect(readFileSync(file).subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(job!.videoFile).toBe(`library/${account!.id}/${job!.id}.mp4`);

    // A challenge stops the job and asks for the owner; nothing is bypassed or retried.
    await ui.locator('textarea[name=creative-prompt]').fill('Same scene [synthetic:challenge_required]');
    await ui.getByRole('button', { name: 'Save video settings' }).click();
    await ui.getByRole('button', { name: 'Generate one video' }).click();
    await expect(ui.locator('table.jobs tr').first()).toHaveAttribute('data-state', 'waiting_for_user');
    await expect(ui.locator('table.jobs tr').first()).toContainText('Nothing was bypassed');
    await ui.screenshot({ path: join(SHOTS, '01-growth-video-section.png'), fullPage: true });

    // Daily cap (3): the third job uses it up.
    await ui.locator('textarea[name=creative-prompt]').fill('Third');
    await ui.getByRole('button', { name: 'Save video settings' }).click();
    await ui.getByRole('button', { name: 'Generate one video' }).click();
    await expect(ui.locator('table.jobs tr').first()).toHaveAttribute('data-state', 'completed');
    expect(await call(run, 'startGeneration', account!.id)).toEqual({ ok: false, error: { code: 'daily_cap_reached' } });

    // An Affiliate account has no generation section and is refused by the main process.
    const affiliate = await createAccount(run, 'Affiliate 01', 'affiliate_ugc');
    expect(await call(run, 'startGeneration', affiliate.id)).toEqual({ ok: false, error: { code: 'not_growth_account' } });
    expect(await call(run, 'saveCreative', account!.id, '', { aspectRatio: '4:3', durationSeconds: 8, quality: 'fast' })).toEqual({
      ok: false,
      error: { code: 'invalid_creative', details: ['invalid_prompt', 'invalid_aspect_ratio'] },
    });
  } finally {
    await quit(run);
  }
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).toContain('generation_job_state');
  expect(log).not.toContain('desk lamp'); // the owner's prompt never reaches the log
});

test('manual Flow download: an MP4 from the Flow window lands in that account library; anything else is refused', async () => {
  const userData = join(await workDir('gen-download'), 'userData');
  const run = await start(userData);
  try {
    let a = await createAccount(run, 'Growth Download', 'account_growth');
    a = await ok<Account>(run, 'setAccountProxy', a.id, { protocol: 'http', host: '127.0.0.1', port: proxy.port }, false);
    const flow = sessionOf(a, 'google-flow');
    const opened = nextSiteWindow(run);
    await ok(run, 'openSite', flow.id, 'download');
    const win = await opened;
    await expect(win.locator('#status')).toHaveText('Video ready');

    const mark = site.requests.length;
    await win.click('#mp4');
    await expect.poll(async () => (await jobsOf(run, a)).find((j) => j.source === 'manual_download')?.state).toBe('completed');
    const [saved] = (await jobsOf(run, a)).filter((j) => j.source === 'manual_download');
    expect(saved!.videoFile).toMatch(new RegExp(`^library/${a.id}/[0-9a-f-]{36}\\.mp4$`));
    expect(readFileSync(join(userData, ...saved!.videoFile!.split('/'))).subarray(4, 8).toString('latin1')).toBe('ftyp');
    // The download went through the account's proxy like everything else.
    expect([...new Set(site.requests.slice(mark).map((r) => r.clientIp))]).toEqual([EXIT]);

    // Not a video: refused before download. Claims to be MP4 but isn't: downloaded, then rejected and deleted.
    await win.click('#txt');
    await win.click('#fake');
    await expect.poll(async () => (await jobsOf(run, a)).filter((j) => j.source === 'manual_download').length).toBe(2);
    const fake = (await jobsOf(run, a)).find((j) => j.source === 'manual_download' && j.state !== 'completed');
    await expect.poll(async () => (await jobsOf(run, a)).find((j) => j.id === fake!.id)?.state).toBe('failed');
    expect((await jobsOf(run, a)).find((j) => j.id === fake!.id)?.errorCode).toBe('output_invalid');
    const files = readdirSync(join(userData, 'library', a.id));
    expect(files.filter((f) => f.endsWith('.mp4'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.part') || f.endsWith('.txt'))).toEqual([]);

    // Other platforms keep the no-downloads rule.
    const tiktok = sessionOf(a, 'tiktok');
    const openedTiktok = nextSiteWindow(run);
    await ok(run, 'openSite', tiktok.id, 'download');
    const tiktokWin = await openedTiktok;
    await tiktokWin.click('#mp4');
    await tiktokWin.waitForTimeout(1000);
    expect((await jobsOf(run, a)).filter((j) => j.source === 'manual_download')).toHaveLength(2);
  } finally {
    await quit(run);
  }
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).toContain('manual_download_saved');
  expect(log).toContain('"reason":"not_mp4"');
  expect(log).toContain('download_blocked');
});

test('real mode: no automated provider; the screen says how to generate by hand', async () => {
  const userData = join(await workDir('gen-real'), 'userData');
  const run = await start(userData, false);
  try {
    await openGrowthEditor(run.ui, 'Real growth');
    await expect(run.ui.getByTestId('generation-provider')).toContainText('Automated Google Flow generation is not enabled yet');
    await expect(run.ui.getByRole('button', { name: 'Generate one video' })).toBeDisabled();
    const [a] = await accounts(run);
    expect(sessionOf(a!, 'google-flow').platform.pages).toEqual(['home']);
    expect(await call(run, 'saveCreative', a!.id, 'A prompt', { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' })).toMatchObject({ ok: true });
    expect(await call(run, 'startGeneration', a!.id)).toEqual({ ok: false, error: { code: 'no_provider' } });
  } finally {
    await quit(run);
  }
  expect(existsSync(join(userData, 'library'))).toBe(false);
});
