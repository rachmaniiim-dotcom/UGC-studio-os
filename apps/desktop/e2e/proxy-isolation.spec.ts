import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANARY_MARKER,
  cookieEditorEntry,
  hashToken,
  startSyntheticProxy,
  startSyntheticSite,
  syntheticToken,
  type SyntheticProxy,
  type SyntheticSite,
} from '@ugc/test-fixtures';
import {
  accounts,
  call,
  createAccount,
  filesContaining,
  fusedElectron,
  importFile,
  launch,
  nextSiteWindow,
  ok,
  openSite,
  partitionCookies,
  quit,
  sessionOf,
  syntheticHost,
  workDir,
  writeExport,
  type Account,
  type Running,
} from './harness.js';

// Gate 3: each Account Bundle has a dedicated proxy for all its platform
// sessions. Two bundles open the same synthetic site through two different
// local authenticated proxies. Each proxy announces a simulated exit IP
// (documentation ranges) to the site; a connection that bypasses every proxy
// is recorded as 'direct'. Synthetic credentials carry the canary marker.

const EXIT_A = '198.51.100.10';
const EXIT_B = '203.0.113.20';
const EXIT_C = '192.0.2.30';

let site: SyntheticSite;
let executablePath: string;
const credsA = { username: 'bundle-a-user', password: syntheticToken('proxy_pass_a') };
const credsB = { username: 'bundle-b-user', password: syntheticToken('proxy_pass_b') };
let proxyA: SyntheticProxy;
let proxyB: SyntheticProxy;

test.beforeAll(async () => {
  site = await startSyntheticSite();
  executablePath = await fusedElectron();
  proxyA = await startSyntheticProxy({ exitIp: EXIT_A, credentials: credsA });
  proxyB = await startSyntheticProxy({ exitIp: EXIT_B, credentials: credsB });
});
test.afterAll(async () => {
  await proxyA.close();
  await proxyB.close();
  await site.close();
});

const start = (userData: string): Promise<Running> =>
  launch({ userData, site, executablePath, allowUnencryptedSynthetic: false, seedProfiles: false });
const proxyInput = (p: SyntheticProxy, creds?: { username: string; password: string }) => ({ protocol: 'http', host: '127.0.0.1', port: p.port, ...(creds ?? {}) });
const setProxy = (run: Running, account: Account, p: SyntheticProxy, creds?: { username: string; password: string }) =>
  ok<Account>(run, 'setAccountProxy', account.id, proxyInput(p, creds), false);
const testProxy = (run: Running, account: Account) => ok<Account>(run, 'testAccountProxy', account.id);
const since = (mark: number) => site.requests.slice(mark);
const exitsOf = (requests: typeof site.requests) => [...new Set(requests.map((r) => r.clientIp))].sort();
const entryFor = (platformId: string, value: string) => cookieEditorEntry({ domain: syntheticHost(platformId), value });
const siteWindows = (run: Running) =>
  run.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.webContents.getURL().startsWith('app://'))
      .map((w) => ({ id: w.id, webrtc: w.webContents.getWebRTCIPHandlingPolicy() })),
  );
const rawFetch = (run: Running, partition: string, url: string) =>
  run.app.evaluate(
    async ({ session }, args) => {
      try {
        const r = await session.fromPartition(args.partition).fetch(args.url);
        return `status ${r.status}`;
      } catch {
        return 'failed';
      }
    },
    { partition, url },
  );

function assertNoSecretLeak(userData: string, run: Running, secrets: string[]): void {
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  for (const s of [CANARY_MARKER, ...secrets]) {
    expect(log).not.toContain(s);
    expect(JSON.stringify(run.responses)).not.toContain(s);
    expect(filesContaining(userData, s)).toEqual([]);
  }
  // Proxy host:port and observed IPs link accounts: kept out of the log too.
  for (const ip of [EXIT_A, EXIT_B, EXIT_C]) expect(log).not.toContain(ip);
}

test('two accounts, two proxies, two platforms each: no cross-routing, no direct path, no cookie leakage', async () => {
  const dir = await workDir('bundle-two-proxies');
  const userData = join(dir, 'userData');
  const tokens = {
    aTiktok: site.addUser('a-tiktok'),
    aKalo: site.addUser('a-kalodata'),
    bTiktok: site.addUser('b-tiktok'),
    bKalo: site.addUser('b-kalodata'),
  };
  const run = await start(userData);
  try {
    let a = await createAccount(run, 'Account A', 'affiliate_ugc');
    let b = await createAccount(run, 'Account B', 'account_growth');
    expect(a.status).toBe('draft');
    expect(a.sessions.map((s) => s.platformId)).toEqual(['tiktok', 'google-flow', 'kalodata', 'shopee']);
    expect(a.sessions.map((s) => s.optional)).toEqual([false, false, true, true]);
    // A draft has no proxy: nothing may open.
    expect(await call(run, 'openSite', sessionOf(a, 'tiktok').id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_configured' } });

    const plan = [
      [a, 'tiktok', tokens.aTiktok, EXIT_A],
      [a, 'kalodata', tokens.aKalo, EXIT_A],
      [b, 'tiktok', tokens.bTiktok, EXIT_B],
      [b, 'kalodata', tokens.bKalo, EXIT_B],
    ] as const;
    for (const [account, platform, token] of plan) {
      await importFile(run, sessionOf(account, platform).id, await writeExport(dir, `${account.displayName}-${platform}`, [entryFor(platform, token)]));
    }
    const mark = site.requests.length;
    a = await setProxy(run, a, proxyA, credsA);
    b = await setProxy(run, b, proxyB, credsB);
    expect(a.proxy).toMatchObject({ hasCredentials: true, status: 'untested', observedIp: null });
    expect(a.status).toBe('draft');
    a = await testProxy(run, a);
    b = await testProxy(run, b);
    expect(a.proxy).toMatchObject({ status: 'ok', observedIp: EXIT_A, endpoint: 'primary', error: null });
    expect(b.proxy).toMatchObject({ status: 'ok', observedIp: EXIT_B, endpoint: 'primary' });
    expect(a.status).toBe('operational');
    expect(since(mark).filter((r) => r.path === '/ip').every((r) => r.cookieNames.length === 0)).toBe(true);

    expect((await openSite(run, sessionOf(a, 'tiktok').id)).status).toBe('Authenticated as a-tiktok');
    expect((await openSite(run, sessionOf(a, 'kalodata').id)).status).toBe('Authenticated as a-kalodata');
    expect((await openSite(run, sessionOf(b, 'tiktok').id)).status).toBe('Authenticated as b-tiktok');
    expect((await openSite(run, sessionOf(b, 'kalodata').id)).status).toBe('Authenticated as b-kalodata');

    const traffic = since(mark);
    expect(exitsOf(traffic)).toEqual([EXIT_A, EXIT_B].sort()); // never 'direct'
    for (const [, , token, exit] of plan) {
      const withToken = traffic.filter((r) => r.sessionTokenHash === hashToken(token));
      expect(withToken.length).toBeGreaterThan(0);
      expect(exitsOf(withToken)).toEqual([exit]);
      // Each request carried exactly one cookie: no platform or account mixing.
      expect(withToken.every((r) => r.cookieNames.length === 1)).toBe(true);
    }
    expect([...new Set(proxyA.records.map((r) => r.username).filter(Boolean))]).toEqual([credsA.username]);
    expect([...new Set(proxyB.records.map((r) => r.username).filter(Boolean))]).toEqual([credsB.username]);
    // Four separate jars, each with only its own cookie.
    for (const [account, platform, token] of plan) {
      expect((await partitionCookies(run, sessionOf(account, platform).partition)).map((c) => c.value)).toEqual([token]);
    }
    expect((await siteWindows(run)).every((w) => w.webrtc === 'disable_non_proxied_udp')).toBe(true);
    expect(readFileSync(join(userData, 'proxy-secrets', `${a.id}.proxy`)).subarray(0, 3).toString('latin1')).toBe('v10');
    // The renderer never gets credentials back.
    expect(JSON.stringify(await accounts(run))).not.toContain(credsA.username);
  } finally {
    await quit(run);
  }
  assertNoSecretLeak(userData, run, [credsA.password, credsB.password, credsA.username]);
});

test('a draft account is pinned to a closed port: even a raw request from its sessions never goes direct', async () => {
  const run = await start(join(await workDir('bundle-blackhole'), 'userData'));
  try {
    const a = await createAccount(run, 'Draft only');
    const mark = site.requests.length;
    expect(await rawFetch(run, sessionOf(a, 'tiktok').partition, `https://${syntheticHost('tiktok')}:${site.port}/whoami`)).toBe('failed');
    expect(since(mark)).toEqual([]);
  } finally {
    await quit(run);
  }
});

test('fail closed: a dead proxy blocks browsing, open windows never fall back to direct, restart re-validates', async () => {
  const dir = await workDir('bundle-fail-closed');
  const userData = join(dir, 'userData');
  const proxyC = await startSyntheticProxy({ exitIp: EXIT_C });
  const token = site.addUser('user-fc');
  let run = await start(userData);
  try {
    let a = await createAccount(run, 'Fail closed');
    await importFile(run, sessionOf(a, 'tiktok').id, await writeExport(dir, 'a', [entryFor('tiktok', token)]));
    a = await setProxy(run, a, proxyC);
    // No explicit test: Open Browser validates the proxy first.
    const opened = await openSite(run, sessionOf(a, 'tiktok').id);
    expect(opened.status).toBe('Authenticated as user-fc');
    expect((await accounts(run))[0]!.proxy).toMatchObject({ status: 'ok', observedIp: EXIT_C });

    await proxyC.close();
    const mark = site.requests.length;
    await opened.window.reload().catch(() => undefined);
    await opened.window.waitForTimeout(1500);
    const failed = await testProxy(run, a);
    expect(failed.proxy).toMatchObject({ status: 'failed', error: 'proxy_unreachable', observedIp: null });
    expect(failed.status).toBe('attention');
    expect(await call(run, 'openSite', sessionOf(a, 'tiktok').id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_ready' } });
    expect(since(mark)).toEqual([]);
  } finally {
    await quit(run);
  }

  run = await start(userData);
  try {
    const mark = site.requests.length;
    const after = (await accounts(run))[0]!;
    expect(after.proxy?.status).toBe('untested');
    expect(after.status).toBe('proxy_check_needed');
    expect(await call(run, 'openSite', sessionOf(after, 'tiktok').id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_ready' } });
    expect(since(mark)).toEqual([]);
  } finally {
    await quit(run);
  }
});

test('wrong proxy credentials: bounded attempts, sanitized error, browsing blocked', async () => {
  const dir = await workDir('bundle-bad-auth');
  const userData = join(dir, 'userData');
  const wrong = { username: credsA.username, password: syntheticToken('wrong_pass') };
  const run = await start(userData);
  try {
    const a = await setProxy(run, await createAccount(run, 'Bad auth'), proxyA, wrong);
    const before = proxyA.records.length;
    const tested = await testProxy(run, a);
    expect(tested.proxy).toMatchObject({ status: 'failed', error: 'proxy_auth_failed', observedIp: null });
    const attempts = proxyA.records.slice(before).filter((r) => r.outcome === 'auth_rejected').length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(await call(run, 'openSite', sessionOf(a, 'tiktok').id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_ready' } });
  } finally {
    await quit(run);
  }
  assertNoSecretLeak(userData, run, [wrong.password]);
});

test('proxy credentials are never offered to a site asking for authentication', async () => {
  const dir = await workDir('bundle-site-auth');
  const userData = join(dir, 'userData');
  const run = await start(userData);
  try {
    const a = await setProxy(run, await createAccount(run, 'Site auth'), proxyA, credsA);
    const mark = site.requests.length;
    const opened = nextSiteWindow(run);
    await ok(run, 'openSite', sessionOf(a, 'tiktok').id, 'basic-auth');
    const win = await opened;
    await expect.poll(() => since(mark).filter((r) => r.path === '/basic-auth').length).toBeGreaterThan(0);
    await win.waitForTimeout(500);
    const hits = since(mark).filter((r) => r.path === '/basic-auth');
    expect(hits.every((r) => r.authorizationSent === false)).toBe(true);
    expect(exitsOf(hits)).toEqual([EXIT_A]);
  } finally {
    await quit(run);
  }
  expect(readFileSync(join(userData, 'logs', 'poc.log'), 'utf8')).not.toContain(credsA.password);
});

test('editing a proxy: keep saved credentials on a new endpoint, or replace; old windows and tunnels close; re-test required', async () => {
  const dir = await workDir('bundle-replace');
  const userData = join(dir, 'userData');
  // Same login, different gateway (a common provider setup).
  const proxyA2 = await startSyntheticProxy({ exitIp: EXIT_C, credentials: credsA });
  const proxyOpen = await startSyntheticProxy({ exitIp: EXIT_B });
  const token = site.addUser('user-replace');
  const run = await start(userData);
  try {
    let a = await setProxy(run, await createAccount(run, 'Replace'), proxyA, credsA);
    await importFile(run, sessionOf(a, 'tiktok').id, await writeExport(dir, 'a', [entryFor('tiktok', token)]));
    expect((await openSite(run, sessionOf(a, 'tiktok').id)).status).toBe('Authenticated as user-replace');
    expect(await siteWindows(run)).toHaveLength(1);

    // New endpoint, saved credentials kept (password never re-entered or returned).
    a = await ok<Account>(run, 'setAccountProxy', a.id, proxyInput(proxyA2), true);
    expect(a.proxy).toMatchObject({ status: 'untested', hasCredentials: true, observedIp: null, lastPassedAt: null });
    expect(a.status).toBe('draft');
    expect(await siteWindows(run)).toHaveLength(0);
    await expect.poll(() => proxyA.openTunnels()).toBe(0);
    let mark = site.requests.length;
    expect((await openSite(run, sessionOf(a, 'tiktok').id)).status).toBe('Authenticated as user-replace');
    expect(exitsOf(since(mark))).toEqual([EXIT_C]);
    expect([...new Set(proxyA2.records.map((r) => r.username).filter(Boolean))]).toEqual([credsA.username]);

    // Replace with a proxy without login: the sealed credentials are deleted.
    a = await ok<Account>(run, 'setAccountProxy', a.id, proxyInput(proxyOpen), false);
    expect(a.proxy?.hasCredentials).toBe(false);
    expect(existsSync(join(userData, 'proxy-secrets', `${a.id}.proxy`))).toBe(false);
    mark = site.requests.length;
    expect((await openSite(run, sessionOf(a, 'tiktok').id)).status).toBe('Authenticated as user-replace');
    expect(exitsOf(since(mark))).toEqual([EXIT_B]);

    // Keeping credentials that don't exist is refused.
    expect(await call(run, 'setAccountProxy', a.id, proxyInput(proxyA2), true)).toEqual({ ok: false, error: { code: 'credentials_missing' } });
  } finally {
    await quit(run);
    await proxyA2.close();
    await proxyOpen.close();
  }
  assertNoSecretLeak(userData, run, [credsA.password]);
});

test('Test Proxy falls back to the backup diagnostic endpoint and reports which one answered', async () => {
  const run = await start(join(await workDir('bundle-backup'), 'userData'));
  try {
    const a = await setProxy(run, await createAccount(run, 'Backup'), proxyB, credsB);
    site.failPrimaryIp(true);
    expect((await testProxy(run, a)).proxy).toMatchObject({ status: 'ok', observedIp: EXIT_B, endpoint: 'backup' });
  } finally {
    site.failPrimaryIp(false);
    await quit(run);
  }
});

test('invalid account and proxy input is refused with field-level codes only', async () => {
  const run = await start(join(await workDir('bundle-invalid'), 'userData'));
  try {
    expect(await call(run, 'createAccount', '  ', 'growth')).toEqual({ ok: false, error: { code: 'invalid_account', details: ['invalid_display_name', 'invalid_mode'] } });
    const a = await createAccount(run, 'Valid');
    const bad = await call(run, 'setAccountProxy', a.id, { protocol: 'ftp', host: 'user:pw@evil.test', port: 70000, username: 'only-user' }, false);
    expect(bad).toEqual({ ok: false, error: { code: 'invalid_proxy', details: ['invalid_protocol', 'invalid_host', 'invalid_port', 'credentials_incomplete'] } });
    const socks = await call(run, 'setAccountProxy', a.id, { protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' }, false);
    expect(socks).toEqual({ ok: false, error: { code: 'invalid_proxy', details: ['socks5_auth_unsupported'] } });
    expect(await call(run, 'setAccountProxy', a.id, { protocol: 'http', host: 'x.test', port: 8080, extra: 1 }, false)).toEqual({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect((await accounts(run))[0]!.proxy).toBeNull();
  } finally {
    await quit(run);
  }
});

// Characterization of S1 (Electron 44.9.3): a main-process request
// (session.fetch) through an authenticated proxy does not raise the 'login'
// event; it gets the proxy's 407 and fails. No credentials are sent and there
// is no direct fallback. This is why Test Proxy uses a window.
test('main-process requests can not authenticate to a proxy and fail closed', async () => {
  const dir = await workDir('bundle-s1');
  const userData = join(dir, 'userData');
  const run = await start(userData);
  try {
    let a = await setProxy(run, await createAccount(run, 'S1'), proxyA, credsA);
    a = await testProxy(run, a);
    expect(a.proxy?.status).toBe('ok');
    const mark = site.requests.length;
    const proxyMark = proxyA.records.length;
    expect(await rawFetch(run, sessionOf(a, 'tiktok').partition, `https://${syntheticHost('tiktok')}:${site.port}/whoami`)).not.toBe('status 200');
    expect(since(mark)).toEqual([]);
    expect(proxyA.records.slice(proxyMark).map((r) => r.outcome)).toEqual(['auth_required']);
  } finally {
    await quit(run);
  }
  expect(readFileSync(join(userData, 'logs', 'poc.log'), 'utf8')).not.toContain(credsA.password);
});
