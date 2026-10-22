import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
  call,
  filesContaining,
  fusedElectron,
  importFile,
  launch,
  nextSiteWindow,
  ok,
  openSite,
  partitionCookies,
  profiles,
  quit,
  workDir,
  writeExport,
  type Profile,
  type Running,
} from './harness.js';

// Gate 3 proxy-isolation proof of concept. Two bundles (profiles) open the
// same synthetic site through two different local authenticated proxies.
// Each proxy announces a simulated exit IP (documentation ranges) to the site,
// and a connection that bypasses every proxy is recorded as 'direct'.
// Synthetic credentials carry the canary marker, so any leak is detectable.

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

const start = (userData: string): Promise<Running> => launch({ userData, site, executablePath, allowUnencryptedSynthetic: false });
const proxyInput = (p: SyntheticProxy, creds?: { username: string; password: string }) => ({
  protocol: 'http',
  host: '127.0.0.1',
  port: p.port,
  ...(creds ?? {}),
});
const since = (mark: number) => site.requests.slice(mark);
const exitsOf = (requests: typeof site.requests) => [...new Set(requests.map((r) => r.clientIp))].sort();
const siteWindows = (run: Running) =>
  run.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.webContents.getURL().startsWith('app://'))
      .map((w) => ({ id: w.id, url: w.webContents.getURL(), webrtc: w.webContents.getWebRTCIPHandlingPolicy() })),
  );

function assertNoSecretLeak(userData: string, run: Running, secrets: string[]): void {
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).toContain('proxy_tested');
  for (const s of [CANARY_MARKER, ...secrets]) {
    expect(log).not.toContain(s);
    expect(JSON.stringify(run.responses)).not.toContain(s);
    expect(filesContaining(userData, s)).toEqual([]);
  }
  // Proxy host:port and observed IPs link accounts: kept out of the log too.
  expect(log).not.toContain(EXIT_A);
  expect(log).not.toContain(EXIT_B);
}

test('two bundles browse the same site through different proxies: no cross-routing, no direct path, no cookie leakage', async () => {
  const dir = await workDir('proxy-two-bundles');
  const userData = join(dir, 'userData');
  const tokenA = site.addUser('user-pa');
  const tokenB = site.addUser('user-pb');
  const run = await start(userData);
  try {
    const [a, b] = await profiles(run);
    await importFile(run, a!.id, await writeExport(dir, 'a', [cookieEditorEntry({ value: tokenA })]));
    await importFile(run, b!.id, await writeExport(dir, 'b', [cookieEditorEntry({ value: tokenB })]));
    const mark = site.requests.length;

    const setA = await ok<Profile>(run, 'setProxy', a!.id, proxyInput(proxyA, credsA));
    expect(setA.proxy).toMatchObject({ protocol: 'http', hasCredentials: true, status: 'untested', observedIp: null });
    await ok<Profile>(run, 'setProxy', b!.id, proxyInput(proxyB, credsB));
    expect((await ok<Profile>(run, 'testProxy', a!.id)).proxy).toMatchObject({ status: 'ok', observedIp: EXIT_A, endpoint: 'primary', error: null });
    expect((await ok<Profile>(run, 'testProxy', b!.id)).proxy).toMatchObject({ status: 'ok', observedIp: EXIT_B, endpoint: 'primary', error: null });
    // The diagnostic partition carried no bundle cookies.
    expect(since(mark).filter((r) => r.path === '/ip').every((r) => r.cookieNames.length === 0)).toBe(true);

    expect((await openSite(run, a!.id)).status).toBe('Authenticated as user-pa');
    expect((await openSite(run, b!.id)).status).toBe('Authenticated as user-pb');

    const traffic = since(mark);
    expect(exitsOf(traffic)).toEqual([EXIT_A, EXIT_B].sort()); // never 'direct'
    const withA = traffic.filter((r) => r.sessionTokenHash === hashToken(tokenA));
    const withB = traffic.filter((r) => r.sessionTokenHash === hashToken(tokenB));
    expect(withA.length).toBeGreaterThan(0);
    expect(withB.length).toBeGreaterThan(0);
    expect(exitsOf(withA)).toEqual([EXIT_A]);
    expect(exitsOf(withB)).toEqual([EXIT_B]);
    // Each proxy only ever received its own bundle's username.
    expect([...new Set(proxyA.records.map((r) => r.username).filter(Boolean))]).toEqual([credsA.username]);
    expect([...new Set(proxyB.records.map((r) => r.username).filter(Boolean))]).toEqual([credsB.username]);
    // Cookie jars stay separate.
    expect((await partitionCookies(run, a!.partition)).map((c) => c.value)).toEqual([tokenA]);
    expect((await partitionCookies(run, b!.partition)).map((c) => c.value)).toEqual([tokenB]);
    // Site windows can't open non-proxied WebRTC paths.
    expect((await siteWindows(run)).map((w) => w.webrtc)).toEqual(['disable_non_proxied_udp', 'disable_non_proxied_udp']);

    const sealed = readFileSync(join(userData, 'proxy-secrets', `${a!.id}.proxy`));
    expect(sealed.subarray(0, 3).toString('latin1')).toBe('v10');
  } finally {
    await quit(run);
  }
  assertNoSecretLeak(userData, run, [credsA.password, credsB.password]);
});

test('fail closed: a dead proxy blocks browsing, open windows never fall back to the direct path, and restart re-validates', async () => {
  const dir = await workDir('proxy-fail-closed');
  const userData = join(dir, 'userData');
  const proxyC = await startSyntheticProxy({ exitIp: EXIT_C });
  const token = site.addUser('user-fc');
  let run = await start(userData);
  const [a] = await profiles(run);
  try {
    await importFile(run, a!.id, await writeExport(dir, 'a', [cookieEditorEntry({ value: token })]));
    await ok(run, 'setProxy', a!.id, proxyInput(proxyC));
    // No explicit test: opening the site validates the proxy first.
    const opened = await openSite(run, a!.id);
    expect(opened.status).toBe('Authenticated as user-fc');
    expect((await profiles(run))[0]!.proxy).toMatchObject({ status: 'ok', observedIp: EXIT_C });

    await proxyC.close();
    const mark = site.requests.length;
    // The window that is already open reloads while the proxy is down.
    await opened.window.reload().catch(() => undefined);
    await opened.window.waitForTimeout(1500);
    expect((await ok<Profile>(run, 'testProxy', a!.id)).proxy).toMatchObject({ status: 'failed', error: 'proxy_unreachable', observedIp: null });
    expect(await call(run, 'openSite', a!.id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_ready' } });
    expect(since(mark)).toEqual([]); // nothing at all reached the site, in particular nothing direct
  } finally {
    await quit(run);
  }

  run = await start(userData);
  try {
    const mark = site.requests.length;
    expect((await profiles(run))[0]!.proxy?.status).toBe('untested');
    expect(await call(run, 'openSite', a!.id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_ready' } });
    expect(since(mark)).toEqual([]);
  } finally {
    await quit(run);
  }
});

test('wrong proxy credentials: bounded attempts, sanitized error, browsing blocked', async () => {
  const dir = await workDir('proxy-bad-auth');
  const userData = join(dir, 'userData');
  const wrong = { username: credsA.username, password: syntheticToken('wrong_pass') };
  const run = await start(userData);
  try {
    const [a] = await profiles(run);
    await ok(run, 'setProxy', a!.id, proxyInput(proxyA, wrong));
    const before = proxyA.records.length;
    const tested = await ok<Profile>(run, 'testProxy', a!.id);
    expect(tested.proxy).toMatchObject({ status: 'failed', error: 'proxy_auth_failed', observedIp: null });
    const attempts = proxyA.records.slice(before).filter((r) => r.outcome === 'auth_rejected').length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(await call(run, 'openSite', a!.id, 'home')).toEqual({ ok: false, error: { code: 'proxy_not_ready' } });
  } finally {
    await quit(run);
  }
  assertNoSecretLeak(userData, run, [wrong.password]);
});

test('proxy credentials are never offered to a site asking for authentication', async () => {
  const dir = await workDir('proxy-site-auth');
  const userData = join(dir, 'userData');
  const run = await start(userData);
  try {
    const [a] = await profiles(run);
    await ok(run, 'setProxy', a!.id, proxyInput(proxyA, credsA));
    const mark = site.requests.length;
    const opened = nextSiteWindow(run);
    await ok(run, 'openSite', a!.id, 'basic-auth');
    const win = await opened;
    await expect.poll(() => since(mark).filter((r) => r.path === '/basic-auth').length).toBeGreaterThan(0);
    await win.waitForTimeout(500);
    const hits = since(mark).filter((r) => r.path === '/basic-auth');
    expect(hits.every((r) => r.authorizationSent === false)).toBe(true);
    expect(exitsOf(hits)).toEqual([EXIT_A]);
  } finally {
    await quit(run);
  }
  const log = readFileSync(join(userData, 'logs', 'poc.log'), 'utf8');
  expect(log).not.toContain(credsA.password);
});

test('replacing a proxy closes the old connections and windows and requires a new test', async () => {
  const dir = await workDir('proxy-replace');
  const userData = join(dir, 'userData');
  const proxyC = await startSyntheticProxy({ exitIp: EXIT_C });
  const token = site.addUser('user-replace');
  const run = await start(userData);
  try {
    const [a] = await profiles(run);
    await importFile(run, a!.id, await writeExport(dir, 'a', [cookieEditorEntry({ value: token })]));
    await ok(run, 'setProxy', a!.id, proxyInput(proxyA, credsA));
    expect((await openSite(run, a!.id)).status).toBe('Authenticated as user-replace');
    expect(await siteWindows(run)).toHaveLength(1);

    const replaced = await ok<Profile>(run, 'setProxy', a!.id, proxyInput(proxyC));
    expect(replaced.proxy).toMatchObject({ status: 'untested', hasCredentials: false, observedIp: null });
    expect(await siteWindows(run)).toHaveLength(0);
    await expect.poll(() => proxyA.openTunnels()).toBe(0);

    const mark = site.requests.length;
    expect((await openSite(run, a!.id)).status).toBe('Authenticated as user-replace');
    expect(exitsOf(since(mark))).toEqual([EXIT_C]);
    // The old credentials were removed with the switch to a proxy without them.
    expect(readFileSync(join(userData, 'poc-profiles.json'), 'utf8')).not.toContain(credsA.username);
  } finally {
    await quit(run);
    await proxyC.close();
  }
});

test('Test Proxy falls back to the backup diagnostic endpoint and reports which one answered', async () => {
  const dir = await workDir('proxy-backup');
  const run = await start(join(dir, 'userData'));
  try {
    const [a] = await profiles(run);
    await ok(run, 'setProxy', a!.id, proxyInput(proxyB, credsB));
    site.failPrimaryIp(true);
    expect((await ok<Profile>(run, 'testProxy', a!.id)).proxy).toMatchObject({ status: 'ok', observedIp: EXIT_B, endpoint: 'backup' });
  } finally {
    site.failPrimaryIp(false);
    await quit(run);
  }
});

test('invalid proxy settings are refused with field-level codes only', async () => {
  const run = await start(join(await workDir('proxy-invalid'), 'userData'));
  try {
    const [a] = await profiles(run);
    const bad = await call(run, 'setProxy', a!.id, { protocol: 'ftp', host: 'user:pw@evil.test', port: 70000, username: 'only-user' });
    expect(bad).toEqual({ ok: false, error: { code: 'invalid_proxy', details: ['invalid_protocol', 'invalid_host', 'invalid_port', 'credentials_incomplete'] } });
    const socks = await call(run, 'setProxy', a!.id, { protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' });
    expect(socks).toEqual({ ok: false, error: { code: 'invalid_proxy', details: ['socks5_auth_unsupported'] } });
    expect(await call(run, 'setProxy', a!.id, { protocol: 'http', host: 'x.test', port: 8080, extra: 1 })).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect((await profiles(run))[0]!.proxy).toBeNull();
  } finally {
    await quit(run);
  }
});

// Characterization of complication S1 (measured on Electron 44.9.3): a
// main-process request (session.fetch, used by automated status probes) through
// an authenticated proxy does not raise the 'login' event at all; it gets the
// proxy's 407 and fails. No credentials are sent and there is no direct
// fallback. Real platforms use owner-confirmed status, so nothing depends on it;
// Test Proxy uses a window for this reason.
test('main-process requests can not authenticate to a proxy and fail closed', async () => {
  const dir = await workDir('proxy-s1');
  const userData = join(dir, 'userData');
  const token = site.addUser('user-s1');
  const run = await start(userData);
  try {
    const [a] = await profiles(run);
    await importFile(run, a!.id, await writeExport(dir, 'a', [cookieEditorEntry({ value: token })]));
    await ok(run, 'setProxy', a!.id, proxyInput(proxyA, credsA));
    await ok(run, 'testProxy', a!.id);
    const mark = site.requests.length;
    const proxyMark = proxyA.records.length;
    expect(await ok<Profile>(run, 'checkStatus', a!.id)).toMatchObject({ status: 'network_error', statusReason: 'unexpected_response' });
    expect(since(mark)).toEqual([]); // nothing reached the site, directly or otherwise
    expect(proxyA.records.slice(proxyMark).map((r) => r.outcome)).toEqual(['auth_required']); // challenged, never answered
  } finally {
    await quit(run);
  }
  expect(readFileSync(join(userData, 'logs', 'poc.log'), 'utf8')).not.toContain(credsA.password);
});
