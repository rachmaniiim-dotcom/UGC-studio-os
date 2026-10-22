import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cookieEditorEntry, sessionCookieEntry, startSyntheticSite, type SyntheticSite } from '@ugc/test-fixtures';
import { fusedElectron, launch, quit, workDir, writeExport, type Running } from './harness.js';

// Clicks the real UI buttons and drives the real Windows file dialog through UI
// Automation (no dialog stub). It takes over the desktop, so it is opt-in:
// set UGC_E2E_NATIVE_DIALOG=1 on Windows.
test.skip(process.platform !== 'win32' || process.env['UGC_E2E_NATIVE_DIALOG'] !== '1', 'opt-in, Windows only');

const helper = join(dirname(fileURLToPath(import.meta.url)), 'win-file-dialog.ps1');
const run = promisify(execFile);

let site: SyntheticSite;
test.beforeAll(async () => {
  site = await startSyntheticSite();
});
test.afterAll(async () => {
  await site.close();
});

const card = (ui: Page, label: string) => ui.locator('.profile', { hasText: label });

async function pickInDialog(app: Running, label: string, choice: { file: string } | 'cancel'): Promise<void> {
  await card(app.ui, label).getByRole('button', { name: 'Import Cookie-Editor JSON…' }).click();
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Title', `Import Cookie-Editor JSON into ${label}`];
  await run('powershell.exe', choice === 'cancel' ? [...args, '-Cancel'] : [...args, '-File', choice.file], { timeout: 30_000 });
}

test('synthetic import through the real Windows file dialog, then restart and restore', async () => {
  test.setTimeout(180_000);
  const executablePath = await fusedElectron();
  const dir = await workDir('native-dialog');
  const userData = join(dir, 'userData');
  const file = await writeExport(dir, 'user-dialog', [
    sessionCookieEntry({ value: site.addUser('user-dialog') }),
    cookieEditorEntry({ name: 'pref', value: 'persistent-pref' }),
  ]);
  const A = 'Synthetic Profile A';
  const B = 'Synthetic Profile B';

  const first = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  try {
    // Cancel changes nothing.
    await pickInDialog(first, A, 'cancel');
    await expect(card(first.ui, A).locator('.status')).toHaveAttribute('data-status', 'never_configured');

    await pickInDialog(first, A, { file });
    await expect(card(first.ui, A).locator('.status')).toHaveAttribute('data-status', 'imported_unverified');
    await expect(card(first.ui, A).locator('pre')).toContainText('imported 2');
    await expect(card(first.ui, A).locator('.restore')).toHaveAttribute('data-restore-state', 'sealed');

    await card(first.ui, A).getByRole('button', { name: 'Check status' }).click();
    await expect(card(first.ui, A).locator('.status')).toHaveAttribute('data-status', 'appears_authenticated');
    await card(first.ui, B).getByRole('button', { name: 'Check status' }).click();
    await expect(card(first.ui, B).locator('.status')).toHaveAttribute('data-status', 'never_configured');

    const opened = first.app.waitForEvent('window');
    await card(first.ui, A).getByRole('button', { name: 'Open site' }).click();
    await expect((await opened).locator('#status')).toHaveText('Authenticated as user-dialog');
  } finally {
    await quit(first);
  }

  const second = await launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
  try {
    await expect(card(second.ui, A).locator('.restore')).toHaveAttribute('data-restore-state', 'restored');
    await card(second.ui, A).getByRole('button', { name: 'Check status' }).click();
    await expect(card(second.ui, A).locator('.status')).toHaveAttribute('data-status', 'appears_authenticated');
    await card(second.ui, B).getByRole('button', { name: 'Check status' }).click();
    await expect(card(second.ui, B).locator('.status')).toHaveAttribute('data-status', 'never_configured');

    await card(second.ui, A).getByRole('button', { name: 'Clear' }).click();
    await expect(card(second.ui, A).locator('.status')).toHaveAttribute('data-status', 'never_configured');
    await expect(card(second.ui, A).locator('.restore')).toHaveCount(0);
  } finally {
    await quit(second);
  }
});
