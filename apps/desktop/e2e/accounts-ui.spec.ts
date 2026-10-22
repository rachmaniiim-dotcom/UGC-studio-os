import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANARY_MARKER,
  cookieEditorEntry,
  cookieEditorExport,
  hashToken,
  sessionCookieEntry,
  startSyntheticProxy,
  startSyntheticSite,
  syntheticToken,
  type SyntheticProxy,
  type SyntheticSite,
} from '@ugc/test-fixtures';
import { filesContaining, fusedElectron, launch, nextSiteWindow, quit, syntheticHost, workDir, type Running } from './harness.js';

// Gate 3 Account Setup, driven through the real React UI (clicks and typing,
// no bridge shortcuts for the workflow under test). Synthetic site, synthetic
// proxies and synthetic cookies only. Screenshots go to docs/gate-3/screenshots.

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'gate-3', 'screenshots');
const EXIT = '198.51.100.10';
const creds = { username: 'ui-proxy-user', password: syntheticToken('ui_proxy_pass') };

let site: SyntheticSite;
let proxy: SyntheticProxy;
let executablePath: string;
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  site = await startSyntheticSite();
  proxy = await startSyntheticProxy({ exitIp: EXIT, credentials: creds });
  executablePath = await fusedElectron();
});
test.afterAll(async () => {
  await proxy.close();
  await site.close();
});

const start = (userData: string): Promise<Running> =>
  launch({ userData, site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
const card = (ui: Page, platform: string): Locator => ui.locator(`article[data-platform="${platform}"]`);
const shot = (ui: Page, name: string) => ui.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

async function fillProxy(ui: Page, password: string): Promise<void> {
  await ui.locator('select[name=protocol]').selectOption('http');
  await ui.locator('input[name=host]').fill('127.0.0.1');
  await ui.locator('input[name=port]').fill(String(proxy.port));
  await ui.locator('input[name=username]').fill(creds.username);
  await ui.locator('input[name=password]').fill(password);
}

test('Add Account → name and mode → proxy → Test Proxy → paste JSON → validate and encrypt → open browser → save; then restart', async () => {
  test.setTimeout(180_000);
  const dir = await workDir('accounts-ui');
  const userData = join(dir, 'userData');
  const session = site.addUser('ui-tiktok');
  const persistent = site.addUser('ui-tiktok-pref');
  const tiktokExport = cookieEditorExport([
    sessionCookieEntry({ domain: syntheticHost('tiktok'), value: session }),
    cookieEditorEntry({ domain: syntheticHost('tiktok'), name: 'pref', value: persistent }),
  ]);
  let run = await start(userData);
  const ui = run.ui;
  try {
    // Dashboard, empty.
    await expect(ui.getByText('No accounts yet.')).toBeVisible();
    await shot(ui, '01-dashboard-empty');

    // 1 · Account: name and mode, saved as a draft.
    await ui.getByRole('button', { name: '+ Add account' }).click();
    await ui.locator('input[name=displayName]').fill('Skincare ID 01');
    await ui.getByLabel('Affiliate UGC').check();
    await shot(ui, '02-add-account');
    await ui.getByRole('button', { name: 'Save draft' }).click();
    await expect(ui.getByTestId('details-notice')).toContainText('Draft saved');
    await expect(ui.getByTestId('editor-account-status')).toHaveAttribute('data-value', 'draft');
    // No proxy yet: browsing is blocked in every session card.
    await expect(card(ui, 'tiktok').getByRole('button', { name: 'Log in here' })).toBeDisabled();

    // 2 · Dedicated proxy: a wrong password fails the test with a clear recovery action.
    await fillProxy(ui, syntheticToken('wrong'));
    await ui.getByRole('button', { name: 'Save proxy' }).click();
    await expect(ui.locator('input[name=password]')).toHaveValue('');
    await expect(ui.getByTestId('proxy-status')).toHaveAttribute('data-status', 'untested');
    await ui.getByRole('button', { name: 'Test proxy' }).click();
    await expect(ui.getByTestId('proxy-notice')).toContainText('rejected the username or password');
    await expect(ui.getByTestId('proxy-status')).toHaveAttribute('data-status', 'failed');
    await shot(ui, '03-proxy-test-failed');

    // Fixed: re-enter the credentials, save, test → observed public IP.
    await fillProxy(ui, creds.password);
    await ui.getByLabel(/Keep the saved username and password/).uncheck();
    await ui.getByRole('button', { name: 'Save proxy changes' }).click();
    await expect(ui.locator('input[name=password]')).toHaveValue('');
    await ui.getByRole('button', { name: 'Test proxy' }).click();
    await expect(ui.getByTestId('observed-ip')).toHaveText(EXIT);
    await expect(ui.getByTestId('proxy-status')).toHaveAttribute('data-status', 'ok');
    await expect(ui.getByTestId('editor-account-status')).toHaveAttribute('data-value', 'operational');
    await shot(ui, '04-proxy-passed');

    // 3 · Platform sessions. Wrong input is explained and the box is cleared anyway.
    const flow = card(ui, 'google-flow');
    await flow.locator('textarea').fill('[{"domain": "flow.ugc-poc.test", "name": '); // truncated copy
    await flow.getByRole('button', { name: 'Validate & encrypt' }).click();
    await expect(flow.locator('textarea')).toHaveValue('');
    await expect(flow.getByTestId('session-notice')).toContainText("isn't valid JSON");
    const kalo = card(ui, 'kalodata');
    await kalo.locator('textarea').fill(tiktokExport); // TikTok cookies pasted into the Kalodata card
    await kalo.getByRole('button', { name: 'Validate & encrypt' }).click();
    await expect(kalo.locator('textarea')).toHaveValue('');
    await expect(kalo.getByTestId('session-notice')).toContainText('belong to another website');
    await expect(kalo.getByTestId('session-status')).toHaveAttribute('data-value', 'never_configured');
    await expect(kalo).toContainText('Automated research is not permitted');

    // TikTok: paste the export, validate and encrypt; the input is cleared immediately.
    const tiktok = card(ui, 'tiktok');
    await tiktok.locator('textarea').fill(tiktokExport);
    await tiktok.getByRole('button', { name: 'Validate & encrypt' }).click();
    await expect(tiktok.locator('textarea')).toHaveValue('');
    await expect(tiktok.getByTestId('session-status')).toHaveAttribute('data-value', 'imported_unverified');
    await expect(tiktok.getByTestId('session-notice')).toContainText('2 of 2 cookies imported, 2 loaded');
    await expect(tiktok.getByTestId('sync-line')).toHaveAttribute('data-saved-count', '1');
    await shot(ui, '05-session-imported');

    // Open Browser goes through the account's proxy; the owner confirms what they see.
    const mark = site.requests.length;
    const opened = nextSiteWindow(run);
    await tiktok.getByRole('button', { name: 'Open browser' }).click();
    const win = await opened;
    await expect(win.locator('#status')).toHaveText('Authenticated as ui-tiktok');
    expect([...new Set(site.requests.slice(mark).map((r) => r.clientIp))]).toEqual([EXIT]);
    await tiktok.getByRole('button', { name: "I'm logged in" }).click();
    await expect(tiktok.getByTestId('session-status')).toHaveAttribute('data-value', 'confirmed_by_user');
    await win.close();
    await shot(ui, '06-editor-complete');

    // Save → dashboard shows the account as operational with its proxy IP.
    await ui.getByRole('button', { name: 'Save and close' }).click();
    const row = ui.locator('table.accounts tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('account-status')).toHaveAttribute('data-value', 'operational');
    await expect(row).toContainText(`IP ${EXIT}`);

    // A second account saved as an incomplete draft.
    await ui.getByRole('button', { name: '+ Add account' }).click();
    await ui.locator('input[name=displayName]').fill('Growth ID 02');
    await ui.getByLabel('Account Growth (Ternak Akun)').check();
    await ui.getByRole('button', { name: 'Save draft' }).click();
    await expect(ui.getByTestId('editor-account-status')).toHaveAttribute('data-value', 'draft');
    await ui.getByRole('button', { name: 'Save and close' }).click();
    await expect(ui.locator('table.accounts tbody tr')).toHaveCount(2);
    await shot(ui, '07-dashboard-two-accounts');

    // Nothing secret in the app UI's own storage.
    expect(await ui.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  } finally {
    await quit(run);
  }

  // Restart: accounts persist; the proxy must pass again; the TikTok session cookie is restored.
  run = await start(userData);
  try {
    const row = run.ui.locator('table.accounts tbody tr').first();
    await expect(row.getByTestId('account-status')).toHaveAttribute('data-value', 'proxy_check_needed');
    await row.getByRole('button', { name: 'Open' }).click();
    const tiktok = card(run.ui, 'tiktok');
    await expect(tiktok.getByTestId('sync-line')).toContainText('last restore restored');
    await expect(tiktok.getByTestId('session-status')).toHaveAttribute('data-value', 'imported_unverified');
    const mark = site.requests.length;
    const opened = nextSiteWindow(run);
    await tiktok.getByRole('button', { name: 'Open browser' }).click(); // validates the proxy first
    const win = await opened;
    await expect(win.locator('#status')).toHaveText('Authenticated as ui-tiktok');
    const traffic = site.requests.slice(mark);
    expect([...new Set(traffic.map((r) => r.clientIp))]).toEqual([EXIT]);
    expect(traffic.some((r) => r.sessionTokenHash === hashToken(session))).toBe(true);
    await expect(run.ui.getByTestId('observed-ip')).toHaveText(EXIT);
    await shot(run.ui, '08-after-restart');
  } finally {
    await quit(run);
  }

  // Credential handling: no cookie value, canary or proxy password anywhere in userData or logs.
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  for (const s of [CANARY_MARKER, creds.password, creds.username, session, persistent]) {
    expect(log).not.toContain(s);
    expect(filesContaining(userData, s)).toEqual([]);
  }
});

test('clean launch in real mode: the Add Account interface on a fresh profile (no network used)', async () => {
  // Real platform definitions, fused binary, brand-new data folder. Only a draft
  // is created; no proxy is tested and no site is opened, so nothing leaves the machine.
  const userData = join(await workDir('real-mode-launch'), 'userData');
  const run = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false, synthetic: false });
  const ui = run.ui;
  try {
    expect(await ui.title()).toBe('UGC Production OS — Session Manager');
    await expect(ui.getByText('No accounts yet.')).toBeVisible();
    await expect(ui.locator('.legacy')).toHaveCount(0); // no test profiles in real mode
    await ui.getByRole('button', { name: 'Add your first account' }).click();
    await ui.locator('input[name=displayName]').fill('My first account');
    await ui.getByLabel('Affiliate UGC').check();
    await ui.getByRole('button', { name: 'Save draft' }).click();
    await expect(ui.getByTestId('editor-account-status')).toHaveAttribute('data-value', 'draft');
    for (const name of ['protocol', 'host', 'port', 'username', 'password']) await expect(ui.locator(`[name=${name}]`)).toBeVisible();
    await expect(ui.locator('input[name=password]')).toHaveAttribute('type', 'password');
    await expect(ui.getByTestId('proxy-status')).toHaveAttribute('data-status', 'none');
    await expect(ui.locator('article.session-card')).toHaveCount(4);
    for (const platform of ['tiktok', 'google-flow', 'kalodata', 'shopee']) {
      await expect(card(ui, platform).getByRole('button', { name: 'Log in here' })).toBeDisabled();
    }
    await expect(card(ui, 'kalodata')).toContainText('Automated research is not permitted');
    await shot(ui, '09-real-mode-new-account');
  } finally {
    await quit(run);
  }
});
