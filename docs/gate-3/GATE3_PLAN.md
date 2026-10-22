# Gate 3 Plan (revised): Account Bundles with dedicated proxies and in-app session setup

**Date:** 2026-10-22 · **Status:** direction approved with required changes (below). Proxy-isolation proof of concept done (§10). The full account-management UI is not yet built
**Supersedes** the Gate 3 parts of `docs/gate-0/ARCHITECTURE_REPORT.md` where they differ (the owner's product correction of 2026-10-22).

## 0. What changed in the requirement

- The owner already has proxies. **No proxy purchasing or provider management.** The proxy is entered per account in the Add/Edit Account form.
- **One Account Bundle = one operational TikTok account**, with linked platform sessions (TikTok, Kalodata, Google Flow, Shopee).
- **Cookie-Editor JSON can be pasted** into the setup form, as well as imported from a file. It is validated and encrypted on submit, and the input is cleared.
- **Each bundle has a dedicated proxy by default.** All of the bundle's browser sessions use it. If it isn't working, browsing is blocked, never silently direct.
- **The future Linux/VPS worker** keeps the same bundle→proxy configuration, behind a Linux secret-storage adapter.
- **Kalodata stays manual only.** Its session can be set up and browsed by hand; no automation (D14, D16).


## Owner decisions and required changes (2026-10-22)

| # | Decision |
|---|---|
| Q1 | Authenticated **HTTP/HTTPS** proxies first. Authenticated SOCKS5 deferred unless the purchased proxies need it (SOCKS5 without credentials is accepted) |
| Q2 | **Kalodata is an optional, separately isolated platform session per bundle.** No forced shared global Kalodata account. Its prohibited or unauthorized automation stays disabled (D14, D16) |
| Q3 | **Google Flow is a separately configured session per bundle.** Its browser profile and credentials are never shared silently across bundles |
| Q4 | **Shopee is optional per bundle**, with its own isolated session when configured |
| Q5 | A reviewed IP-check endpoint **plus a backup**, used only for proxy diagnostics. Reported: observed IP, proxy status, sanitized errors |
| Q6 | Clear the **HTTP cache on exit** where appropriate. Cookies, localStorage, IndexedDB and other storage needed for session persistence are kept. Cache clearing is **not** described as encryption of site data |
| Q7 | **"Log in here"** inside the bundle's partition, through its assigned proxy |

**Mandatory setup flow:** Add Account → Account Name → Production Mode → Dedicated Proxy → **Test Proxy** → Paste or Import Cookie-Editor JSON per platform → **Validate and Encrypt** → Open Browser → Save Account.
- **Proxy first:** the proxy must be configured and validated before any external navigation for the bundle. If a required proxy fails, the app fails closed.
- **Isolation:** each bundle's TikTok, Kalodata, Flow and optional Shopee sessions are isolated, and nothing (sessions or proxies) is shared between bundles automatically.

**Security requirements added:**
- **Where secrets may never go:** cookies and proxy credentials never go into browser localStorage, logs, diagnostics, analytics or ordinary SQLite fields.
- **Where secrets are handled:** only in the main process, behind narrowly scoped IPC.
- **Site-written storage:** script-readable cookies, and site-written localStorage, IndexedDB and cache, are treated as **potential secondary exposure of sensitive data**, never assumed harmless. `security-check` reports them as findings. Classifying them is for the owner, not automatic.

**Consequences for §2–§3:**
- Kalodata, Google Flow and Shopee are `platform_sessions` rows like TikTok. The "outside bundles" recommendations in §8 are withdrawn.
- §5.8 and §5.9 remain risks to manage per account, not design constraints: one Kalodata or Google account used in several bundles means several IPs. Owner policy is to configure separate accounts where that matters.

## 1. Architecture

```text
Renderer (trusted app UI, sandboxed, CSP connect-src 'none')
  Account list · Add/Edit Account form · per-platform session cards
        │  narrow typed IPC (validated, size-limited, sender-checked)
        ▼
Main process (privileged)
  BundleService ── SQLite metadata (non-secret)        [new, replaces poc-profiles.json]
  SecretStore   ── vault adapter (encrypt/decrypt)     [new packages/vault]
                     Windows: safeStorage (DPAPI)  ·  Linux: envelope + systemd-creds/KMS (design only)
  ProxyService  ── applies proxy to each bundle partition, test, auth, fail-closed gate
  SessionSync   ── (C1, unchanged) sealed session-cookie snapshots, now stored via SecretStore
  Importer      ── (unchanged) Cookie-Editor validation per platform definition
        │
        ▼
Electron sessions: one persist: partition per (bundle, platform)
  all partitions of one bundle → that bundle's proxy; never shared with another bundle
```

`packages/core` stays platform-neutral: account model, validation, proxy config validation, payload formats. `packages/vault` holds the `SecretStore` interface and the Windows adapter, plus the Linux adapter's interface and tests in a later gate.

## 2. Account model (SQLite, Gate 3 migration 001)

| Table | Columns (secrets never stored here) |
|---|---|
| `account_bundles` | `id` (UUID) · `display_name` · `mode` (`affiliate_ugc` \| `account_growth`) · `status` · `proxy_required` (default 1) · `created_at` · `updated_at` |
| `proxies` | `id` · `bundle_id` (UNIQUE: one per bundle, never shared) · `protocol` (`http` \| `https` \| `socks5`) · `host` · `port` · `has_credentials` · `secret_ref` (vault key, if credentials) · `status` (`untested` \| `ok` \| `failed` \| `blocked`) · `last_test_at` · `last_test_result` (code) · `observed_ip` · `updated_at` |
| `platform_sessions` | `id` · `bundle_id` · `platform_id` (`tiktok` \| `kalodata` \| `google_flow` \| `shopee`) · `partition` (UUID, never reused) · `required` · `status` (existing statuses incl. `confirmed_by_user`) · `status_reason` · `last_import` (non-secret summary JSON) · `sync_revision` · `sync_saved_count` · `updated_at` · UNIQUE(`bundle_id`, `platform_id`) |
| `schema_migrations` | `version` · `applied_at` |

Vault entries (encrypted, outside SQLite):
- `bundle/<id>/proxy-credentials`: username and password, both encrypted. The username identifies the proxy account, so it is treated as sensitive.
- `session/<platformSessionId>/snapshot` and `/revision`: the C1 format, with `bundleId` added to the binding.

Rules:
- A bundle's partitions all get its proxy. No two bundles share a proxy row. Copying a proxy to another bundle is an explicit user action that creates a separate row.
- The proxy host and observed IP are **not secret**, but they link accounts together. They are shown in the UI and kept out of logs.
- Migration: the Gate 2 profiles (`C:\ugc-private\gate2-userData`) are **not** migrated automatically. The owner re-imports into a bundle, which also gets the proxy applied from the start (see §5.6).

## 3. Setup UI (Add / Edit Account)

One form, four sections. Platform cards are listed in setup order.

```text
┌ Add Account ────────────────────────────────────────────────────────────┐
│ 1  Account   Display name [__________]   Mode (•) Affiliate UGC          │
│                                               ( ) Ternak Akun / Growth   │
│ 2  Proxy     Protocol [HTTP ▾]  Host/IP [__________]  Port [_____]       │
│              Username [______]  Password [••••••]  (optional)            │
│              [Test proxy]  Status: untested                              │
│              → after test: OK · public IP 203.0.113.7 · 412 ms           │
│ 3  Sessions  ┌ TikTok (required) ─────────────────────────────────────┐ │
│              │ [ paste Cookie-Editor JSON here          ] [Import file]│ │
│              │ [Validate & encrypt]   Status: never_configured         │ │
│              └────────────────────────────────────────────────────────┘ │
│              ┌ Kalodata (manual only · no automation) ─── same ────────┐ │
│              ┌ Google Flow (optional) ──────────────── same ───────────┐ │
│              ┌ Shopee (optional) ───────────────────── same ───────────┐ │
│ 4  Check     [Open TikTok]  [Open Kalodata] …  (enabled only when the    │
│              proxy test passed)  ·  I see I am logged in / logged out    │
└─────────────────────────────────────────────────────────────────────────┘
```

Behaviour:
- **Paste:** the textarea has `autocomplete="off"`, spellcheck off and no drag-drop. On **Validate & encrypt**, the text goes to main over IPC once. The renderer then *replaces the textarea element*, which drops its undo history, and keeps nothing.
  - Main validates against the platform definition, loads the cookies into the session's partition and seals the snapshot (C1).
  - It returns only the counts summary.
  - The plaintext buffer is zeroed after use. JS strings can't be (R-20).
- **Import file:** unchanged. The native dialog is opened by main, which reads the file itself.
- **Clear clipboard:** an optional button, shown after a paste import.
- **Proxy password:** a password field, sent once and encrypted by main. The edit form shows only "credentials set" and a **Replace credentials** action. Saved credentials are never sent back to the renderer.
- **Edit Account:** change name or mode, **Replace proxy** (re-test required before browsing), and per platform **Re-import** (replaces the jar and snapshot) and **Clear**.
- **Session-expired banner:** when status becomes `expired`/`rejected`, the card shows **Re-import** and **Log in here**. "Log in here" is interactive login inside the bundle's partition, through its proxy (§5.6).

## 4. Security boundaries (changes from Gate 1/2)

| # | Boundary | Rule |
|---|---|---|
| B1 | **Pasted secrets cross renderer → main** | New. Gate 1 kept cookie JSON out of the renderer entirely; pasting needs it in the trusted UI briefly. Mitigations: the renderer has no network (CSP `connect-src 'none'`), no remote content, no storage writes for these fields; a single IPC call with a 2 MB limit, sender check and schema check; inputs are cleared and replaced. The e2e scan of the app's own storage (Local Storage, IndexedDB, Session Storage, cache of the app UI session) must find no canary |
| B2 | Secrets never return to the renderer | Proxy password, cookie values and tokens: write-only from the renderer's view |
| B3 | **Proxy enforced in main, fail closed** | `session.setProxy({ mode: 'fixed_servers', proxyRules })` with no `direct://` fallback, awaited **before** any window, probe or request in that partition. A bundle whose proxy isn't `ok` can't open windows (`proxy_not_ready`). After any change: `closeAllConnections()` and `clearAuthCache()` |
| B4 | Proxy credentials go only to the proxy | The `login` handler answers only when `authInfo.isProxy`, the request's session belongs to that bundle, and `authInfo.host`/`port` equal the bundle's proxy. Never for site auth or another bundle. A retry limit → `proxy_auth_failed` |
| B5 | WebRTC can't bypass the proxy | Every site window: `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` |
| B6 | No Node-side network for platform traffic | Platform traffic only via the partition (`ses.fetch`/windows), never Node `fetch`/`http`, which ignore session proxies |
| B7 | Test Proxy is isolated | It uses a **temporary in-memory partition** with the same proxy (no bundle cookies) and a fixed, reviewed IP-echo endpoint. It reports the IP, latency and an error code only |
| B8 | Logs and diagnostics | Redaction extended to proxy URLs with credentials and `Proxy-Authorization`. Proxy host and observed IP are not logged (account linkage). `security-check` also searches for proxy usernames and passwords |
| B9 | Kalodata | Unchanged: manual setup, browsing and confirmation only. Test Proxy never contacts Kalodata |

## 5. Technical complications (authenticated proxies in embedded Electron)

1. **SOCKS5 with username/password isn't supported by Chromium.** Chromium only does unauthenticated SOCKS5 (SOCKS4/5 without auth), and it ignores credentials in the proxy URL. Options:
   - **(a)** support HTTP/HTTPS proxies with auth, and SOCKS5 **without** auth only (recommended for Gate 3);
   - **(b)** a local relay in a utility process: it listens on `127.0.0.1` on a random port, requires a per-run random credential from Chromium, and forwards to the authenticated SOCKS5 upstream. That's more code and a new local attack surface, so it's a separate decision.

   Most residential/ISP proxy providers also offer HTTP(S) endpoints with the same credentials.
2. **Proxy auth comes through an event, not configuration.** HTTP/HTTPS proxy credentials are supplied at runtime through Electron's `login` event (407 challenge). Whether requests made from the main process (`ses.fetch`, used by Test Proxy and probes) raise the same event in Electron 44 **needs a spike (S1)**. The fallback is to run Test Proxy from a hidden window in the temporary partition.
3. **Fail-closed depends on settings.** Leave out `direct://`, use `fixed_servers` (not system or PAC), and await `setProxy` before the first load. Restored sessions (C1) must not trigger network before the proxy is set: the restore sets cookies only, and the proxy is applied at partition creation, before restore.
4. **DNS.** Through an HTTP(S) proxy, Chromium sends hostnames to the proxy (CONNECT), so there's no local DNS lookup for those requests. With SOCKS5, Chromium resolves remotely. Residual risk: certificate revocation fetches and some Chromium-internal requests may use the system network context. To be measured in S2.
5. **WebRTC** leaks the real IP unless policy B5 is set. It's set per window and covered by a test.
6. **IP change vs session (R-05).** Cookies exported from Chrome were created on your **home IP**. Using them through a proxy is an IP jump that TikTok/Google may treat as suspicious (new-device check, logout, warning). This is unavoidable with Cookie-Editor imports. Mitigations:
   - set the proxy before the first use;
   - export from a Chrome profile that already uses the same proxy; or
   - use **Log in here** inside the bundle's proxied partition, so the session is born on the proxy IP.
7. **Embedded-browser logins.** Google (Flow) and possibly TikTok may refuse sign-in or sessions inside an embedded/automation-capable browser (R-02, device-bound session credentials). The design doesn't work around these checks. If a platform refuses, the card shows it, and that platform stays unconfigured for the bundle.
8. **Kalodata and multiple bundles.** Using **one** Kalodata account in several bundles means one account on several IPs at once. That conflicts with ToS §3.4/§14.7 (account sharing, circumvention) and R-22 concurrent sessions. **Decision needed (Q2).**
9. **Same for Google Flow.** One Google account across several proxied bundles is likely to trigger Google security checks. **Decision needed (Q3).**
10. **Data at rest beyond cookies (new, from Gate 2).** Chromium encrypts only cookies. Local Storage, IndexedDB and the HTTP cache are plaintext on disk. Gate 2 found *script-readable* cookie values that the site itself copied there (no HttpOnly values). Options:
    - clear each partition's HTTP cache on quit;
    - ask the owner to enable Windows Device Encryption/BitLocker (Home edition support depends on hardware; TPM wasn't detected);
    - classify these findings as `site_storage_copy` (medium) rather than high in `security-check`.

## 6. Linux / VPS (design only in Gate 3)

- **`SecretStore` interface:** `put(ref, bytes)`, `get(ref)`, `delete(ref)`, `describe()` (backend and protection level). One implementation per platform.
- **Windows:** `safeStorage` (DPAPI-wrapped AES-GCM key), as today.
- **Linux worker:** envelope encryption. Each record gets AES-256-GCM with a random data key, wrapped by a key-encryption key from **systemd-creds** (TPM2 if present, else the host key) or a cloud **KMS**. It **refuses** plaintext or "basic_text" backends (R-14).
- **Moving a bundle laptop → VPS:** an encrypted **bundle package** (config + secrets) encrypted to the VPS's public key (X25519/age). It is never sent in plaintext, never through Claude, and never in Git. The VPS re-wraps it with its own key-encryption key.
- **Proxy on the worker:** Playwright contexts take `proxy: {server, username, password}` per bundle. The same SOCKS5-auth limit applies to Chromium.

## 7. Test requirements (Gate 3)

Synthetic only. The new fixtures are local proxies:
- an HTTP CONNECT proxy with Basic auth;
- an HTTPS proxy;
- an unauthenticated SOCKS5 proxy.

Each binds outgoing connections to its own loopback address (127.0.0.2, 127.0.0.3, …). The synthetic site's `/ip` endpoint returns the address it sees, so "observed IP" is testable offline.

| Area | Tests |
|---|---|
| Model | Migrations up from empty and from a Gate 2 profile store (no auto-import); constraints (one proxy per bundle, unique partitions, one session per platform per bundle) |
| Proxy validation | Protocols; IPv4/IPv6/hostname; port range; credentials rejected inside URLs; SOCKS5+credentials refused (option a) |
| Routing | Bundle A traffic is observed from A's proxy address, B from B's; **no request ever reaches the site from 127.0.0.1** (the direct path) during startup, restore, open, probe or re-import |
| Fail closed | Proxy down → windows blocked (`proxy_not_ready`), page loads fail, and the site's request log shows zero direct requests. Wrong credentials → `proxy_auth_failed` after the retry limit, no loop |
| Credential scope | The login handler never answers site auth or another bundle's proxy; credentials never reach the renderer, logs, SQLite, crash output or bridge responses; `security-check` finds none in plaintext |
| Change | Replacing the proxy → new observed IP; old connections closed; browsing blocked until re-tested |
| WebRTC | ICE candidates gathered in a site window contain no host/srflx candidates from the real interfaces |
| Paste import | Valid/invalid/oversized/wrong-platform JSON; the textarea is replaced; app-UI storage (Local Storage, IndexedDB, cache) contains no canary; re-import replaces jar and snapshot (C1 revision) |
| Isolation (regression) | Cookies, localStorage, server view per bundle and per platform; C1 rotation, logout, crash and rollback suites unchanged |
| Kalodata | Manual only: no app-initiated request (count = 0), no Test Proxy traffic to it |
| Vault | Windows adapter round trip, tamper, wrong key; Linux adapter interface tests against a mock key-encryption key |

## 8. Decisions (as originally proposed; superseded by the owner decisions above)

| # | Question | Recommendation |
|---|---|---|
| Q1 | SOCKS5 with credentials: (a) not supported, use HTTP(S) instead, or (b) build a local relay? | **(a)** for Gate 3; (b) later if needed |
| Q2 | Kalodata: one shared account across bundles, a separate account per bundle, or a single research session outside bundles? | A **single Kalodata research session outside bundles**, on one fixed proxy, because §3.4/§14.7 and R-22 make per-bundle copies of one account risky |
| Q3 | Google Flow: per bundle, or one shared generation session outside bundles? | **Outside bundles** (one session, one IP); Flow generates content and isn't tied to a TikTok identity |
| Q4 | Shopee: per bundle? | Per bundle, if each TikTok identity has its own Shopee account; otherwise outside bundles |
| Q5 | Test Proxy IP-echo endpoint: which service is acceptable (it sees the proxy IP)? | One fixed, reviewed endpoint, configurable in a reviewed definition |
| Q6 | HTTP cache: clear on quit for platform partitions? | Yes (cheap; reduces plaintext at rest) |
| Q7 | Is "Log in here" (interactive login inside the proxied partition) wanted as an alternative to JSON import? | Yes: it avoids the IP jump |

## 9. Gate 3 sequence

1. ~~Spike S1~~ (done, §10). Spike S2 (direct-path leaks from revocation or DNS with the direct route closed) is still open.
2. `packages/vault` (Windows adapter), plus the Linux adapter interface.
3. SQLite metadata and migration; `BundleService`.
4. `ProxyService` (apply, auth, test, fail closed) with the local proxy fixtures.
5. Setup UI (Add/Edit Account, paste and file import), wired to the existing importer and C1.
6. Full Windows test run; security check; report; stop for approval.

## 10. Proxy-isolation proof of concept (2026-10-22)

**Scope:** synthetic only, built into the existing profile model (two profiles stand in for two bundles). No real proxy, credential, cookie or platform was used. The full Add Account interface is the next deliverable.

### What was built
| Part | Where |
|---|---|
| Proxy settings validation (protocol, host, port, credentials), Chromium rule builder, challenge matching | `packages/core/src/proxy/config.ts` |
| `ProxyService`: apply per partition, sealed credentials, proxy-only and bundle-only auth handler, Test Proxy (primary + backup endpoint), fail-closed gate, replace/remove | `apps/desktop/src/main/proxy.ts` |
| WebRTC `disable_non_proxied_udp` on every site window | `apps/desktop/src/main/windows.ts` |
| IPC `setProxy` / `testProxy` (sanitized field-level error codes); Open Site and status probes go through the gate | `apps/desktop/src/main/ipc.ts` |
| Redaction of `user:password@` in URLs and proxy credential fields; `security-check` also searches for proxy usernames and passwords | `packages/core/src/redaction/redact.ts`, `apps/desktop/src/main/security-check.ts` |
| Local authenticated HTTP CONNECT proxy fixture; synthetic site IP-echo endpoints (`/ip`, `/ip-backup`) and a Basic-auth page | `packages/test-fixtures/src/proxy.ts`, `site.ts` |

**Simulated exit IPs.** Windows won't let a local process use 127.0.0.2+ as a source address, which was measured. So each synthetic proxy announces a simulated exit IP from a documentation range (`198.51.100.10`, `203.0.113.20`, `192.0.2.30`) with a PROXY-protocol header, the mechanism real load balancers use. The site labels any connection without it `direct`. "No direct path" is therefore checked exactly, offline.

**Test Proxy runs in a hidden window**, on a throwaway in-memory partition with the same proxy and no bundle cookies. The reason is that a proxy-auth challenge must be traceable to exactly one bundle. Providers often use one gateway host:port with a different username per account, so host:port can't identify the bundle; only the requesting window's session can.

### Results (Windows, Electron 44.9.3)
| Proven | Test |
|---|---|
| Two bundles open the same site through **different proxies**. Every request with A's cookie came from A's exit IP and every request with B's from B's; **no request was direct**; each proxy only ever saw its own bundle's username; cookie jars stayed separate; the diagnostic partition carried no cookies | two-bundle test |
| **Fail closed:** dead proxy → Test Proxy `proxy_unreachable`, Open Site refused (`proxy_not_ready`). An already-open window reloading during the outage sent **nothing** to the site. After restart the proxy is `untested` and browsing stays blocked until it passes | fail-closed test |
| Wrong credentials → `proxy_auth_failed` after at most 2 attempts; browsing blocked | bad-auth test |
| A site's own 401 challenge is **never** answered with proxy credentials (`Authorization` never sent) | site-auth test |
| Replacing a proxy closes the bundle's windows and old tunnels, requires a new test, and the new exit IP is used from then on | replace test |
| Primary diagnostic endpoint down → backup used and reported | backup test |
| Invalid settings refused with field-level codes only; SOCKS5 with credentials refused | validation test |
| No proxy password or username in logs, metadata, bridge responses or any userData file; credentials sealed `v10`; proxy host and exit IPs kept out of the log | every test |
| `security-check` finds a leaked proxy password and reports it as `proxy-password x1` at the file path, without the value | check test |

**Spike S1 (answered).** On Electron 44, a main-process `session.fetch` through an authenticated proxy **doesn't raise the `login` event**. It gets the proxy's 407 and fails (`network_error`): no credentials sent, nothing reaches the site, no direct fallback. Consequences: automated status probes can't use authenticated proxies (real platforms use owner-confirmed status anyway), and every proxied action that needs auth must come from a window. That's why Test Proxy uses one.

**Mutation checks.** A `direct://` fallback is caught: the fail-closed test fails, and Test Proxy reports `proxy_bypassed`. Answering site auth with proxy credentials is caught. Removing `closeAllConnections()` on replace is **not** caught, because Chromium itself flushes its connection pools when a partition's proxy settings change. The explicit call stays as a second layer. Telling the two apart needs a test that holds a request open across the switch (follow-up).

**Full suite:** unit 187/187; e2e 43/43, with the dev fuse both ON and OFF (including the native-dialog test).

### Behaviour change to note
**Non-synthetic platforms now require a proxy.** Opening a site in Kalodata mode without a configured, tested proxy is refused (`proxy_not_configured` / `proxy_not_ready`). The Gate 2 launcher still starts, but its profiles must be given a proxy before browsing. That's intended (fail closed).

## 11. Electron vs Playwright proxy behaviour (for the Linux worker)

| Topic | Electron (desktop) | Playwright + Chromium (Linux worker) |
|---|---|---|
| Where the proxy is set | Per **session/partition**: `ses.setProxy({mode:'fixed_servers', proxyRules})` | Per **browser context**: `browser.newContext({ proxy: { server, username, password, bypass } })` (or per launch) |
| Credentials | Not in the rule; supplied at runtime through the `login` event (window requests only, see S1) | Passed in `proxy.username/password`; Playwright answers the 407 itself, including for page requests |
| Requests outside a page | `session.fetch` doesn't authenticate to the proxy (S1) | `context.request` (APIRequestContext) uses the context's proxy and credentials |
| SOCKS5 with credentials | Not supported (Chromium) | Not supported for Chromium either |
| Direct fallback | None with `fixed_servers` and no `direct://` | None unless `bypass` lists hosts; avoid `bypass` |
| WebRTC | `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` per webContents | Chromium flag `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (launch arg) |
| Changing proxy | `setProxy` + `closeAllConnections` + `clearAuthCache` on the same partition | A context's proxy is fixed: create a **new context** (cookies re-loaded from the vault) |
| Persistence | `persist:` partition on disk (cookies Chromium-encrypted) | Ephemeral contexts; cookies loaded from the vault (`storageState`) each run |

**Shared across both:** the same `ProxySettings` validation (`packages/core`), the same bundle→proxy mapping, and sealed credentials through the `SecretStore` adapter (DPAPI on Windows, envelope encryption on Linux).
