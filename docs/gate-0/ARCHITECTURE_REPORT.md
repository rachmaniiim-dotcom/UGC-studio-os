# UGC Production OS — Gate 0: Environment & Architecture Report

**Status:** Gate 0 deliverable. Documentation only. No implementation code, no dependencies installed, no project initialized.
**Date:** 2026-10-22
**Spec:** MASTER_SPEC.md v1.0

> **Update after owner review (2026-10-22):** the owner's decisions are recorded in `docs/DECISIONS.md` and override this report where they differ: conflicting duplicate cookies are rejected (D5); yellow-basket attachment stays an automation objective (D10); Google Flow stays the preferred provider (D11). Gate 1 results are in `docs/gate-1/GATE1_REPORT.md`.

Feature status legend (per spec §21): **implemented / tested / manually verified / untested / blocked / planned**. Everything in this report is **planned**. Nothing is implemented.

---

## 1. Environment findings

### 1.1 Critical finding: the Windows environment was NOT inspected

This Gate 0 session runs in a **cloud Linux container** (Claude Code on the web), not on the product owner's Windows laptop. I can't reach the Windows machine from here. **Nothing below describes your Windows environment.** I haven't guessed or invented any Windows facts.

What I *could* observe (the cloud container, which is only useful for CI-style unit tests later):

| Fact | Observed value (cloud container, NOT Windows) |
|---|---|
| OS | Ubuntu 24.04.5 LTS, Linux 6.18 x86_64 |
| Shell | bash |
| Node.js | v22.22.0 |
| npm / pnpm / yarn / corepack | 10.9.4 / 10.28.0 / 1.22.22 / 0.34.0 |
| Git | 2.43.0 |
| Global tools | typescript 6.0.2, playwright 1.56.1 (Chromium build 1194 at `/opt/pw-browsers`), eslint, prettier, ts-node |
| Free disk | ~31 GB available in session allowance |
| Directory | `/home/user/UGC-studio-os`, a git repo with **no commits**, branch `ccr-aecbb29a-dleiwi`, remote `rachmaniiim-dotcom/UGC-studio-os` |
| Windows tools | `cmd.exe`, `powershell.exe`, `wsl.exe`: **not available** |

**Unavailable facts (Windows):** Windows edition/version/build, PowerShell version, Node/npm/pnpm/Git on Windows, Visual Studio Build Tools, free disk on C:, whether the project folder sits under OneDrive sync, long-path setting, Git `core.autocrlf`, Defender/SmartScreen policy, TPM presence.

### 1.2 Read-only Windows inspection (for the product owner to run)

Run this in **Windows PowerShell** from the folder where you plan to keep the project, then paste the output back. It only reads values. It changes nothing and prints no secrets. Your Windows username will show up in paths, and you may redact it.

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
"PowerShell: $($PSVersionTable.PSVersion)"
foreach ($c in 'node','npm','pnpm','yarn','corepack','git','python','winget') {
  $p = (Get-Command $c -ErrorAction SilentlyContinue).Source
  if ($p) { "$c -> $p :: " + (& $c --version 2>&1 | Select-Object -First 1) } else { "$c -> NOT FOUND" }
}
"Current dir: $((Get-Location).Path)"
"Under OneDrive: $((Get-Location).Path -match 'OneDrive')"
Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
"LongPathsEnabled: $((Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -ErrorAction SilentlyContinue).LongPathsEnabled)"
"VS Installer present: $(Test-Path "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe")"
"git autocrlf: $(git config --get core.autocrlf 2>$null)"
"TPM present: $((Get-CimInstance -Namespace root\cimv2\security\microsofttpm -ClassName Win32_Tpm -ErrorAction SilentlyContinue) -ne $null)"
```

### 1.3 Expected Windows prerequisites (to confirm against the output above)

- Node.js LTS (22.x or 24.x), with the exact version pinned in the repo.
- pnpm via Corepack, pinned with the `packageManager` field.
- Git for Windows, with `core.autocrlf` set deliberately (recommend `input` plus a `.gitattributes`).
- Visual Studio Build Tools (C++ workload) **only if** a native module such as `better-sqlite3` lacks a prebuilt binary for the pinned Electron.
- Project folder **outside OneDrive-synced folders** (Desktop/Documents are often synced). Sync can lock files, upload build output and, worse, upload Electron profile data.
- At least about 5 GB free for `node_modules`, Electron binaries and build output.

### 1.4 Execution-location consequence (important)

| Gate | Where it must run | Why |
|---|---|---|
| 0 | Here (docs only) | No runtime needed. |
| 1 (synthetic PoC) | Code can be written and unit-tested here. **Electron runtime proof must be run on Windows.** | DPAPI/safeStorage, Windows paths, and the real Electron GUI can't be validated in this Linux container. |
| 2 (real Kalodata) | **Windows only, locally.** | Real cookies must never enter a cloud container, chat, or Git. |
| 3 (Milestone 1) | Mixed: code and CI tests here, acceptance on Windows. | Acceptance criterion 1 is "launches on Windows". |

---

## 2. Product and account-bundle understanding

- **AccountBundle** = one operational publishing identity, usually one TikTok account. It has exactly one mode (`affiliate_ugc` | `account_growth`), a status, non-secret config, a schedule (future) and **0..n PlatformSessions**.
- **PlatformSession** = one site login state (TikTok, Kalodata, Google Flow, Shopee) belonging to one bundle. It has its own collision-resistant browser partition and a vault reference. Not every bundle has every platform. **No cross-bundle sharing in M1.**
- Milestone 1 is only the **Browser Session Manager**. Research, generation, Showcase, yellow basket, publishing, n8n and VPS are all future work, and Gate 0 only defines their boundaries.
- Guiding principle: honest status. "Cookies imported" ≠ "logged in" ≠ "automation permitted".

---

## 3. Proposed monorepo / package architecture

The spec invites fewer packages. I recommend **4 workspaces in M1** (not 8), split along the one boundary that really matters: *Electron-free code* vs *Electron code*.

```text
ugc-production-os/
  apps/desktop/                 Electron + React + TS (main / preload / renderer)
    src/main/                   app lifecycle, IPC handlers, Electron session adapter,
                                SQLite repositories + migrations, safeStorage key provider
    src/preload/                minimal typed bridge (contextBridge only)
    src/renderer/               React UI (trusted app UI only)
  packages/core/                NO Electron/Playwright/Node-native imports
    domain/                     AccountBundle, PlatformSession, statuses, errors
    cookies/                    Cookie-Editor detection, validation, normalization
    platforms/                  platform registry: allowed cookie domains, start URLs
    redaction/                  redaction utilities + safe logger interface
    ports/                      interfaces: BrowserSessionAdapter, VaultPort, KeyProvider, Repos
  packages/vault/               AES-256-GCM envelope encryption over a KeyProvider port
                                (Node crypto only; no Electron import)
  packages/test-fixtures/       synthetic cookies, local HTTPS test site (dev only)
  docs/
```

Added later, **not in M1**: `packages/worker-playwright` (Linux/Windows worker), and a `jobs`/`storage` package when durable jobs arrive.

Toolchain: pnpm workspaces; TypeScript strict; Vitest for unit tests; Playwright's Electron support (`_electron`) for desktop end-to-end tests; ESLint with an import-boundary rule so `packages/core` and `packages/vault` can never import `electron`. Build tool: electron-vite (or Electron Forge + Vite); installer via electron-builder NSIS (decision D7). All versions pinned exactly with a committed lockfile.

---

## 4. Electron main / preload / renderer separation

| Process | Trust | Responsibilities | Never does |
|---|---|---|---|
| **Main** | Privileged | DB, vault, file dialogs, reading import files, Electron `session` APIs, creating browser views, IPC handlers, navigation policy | Run remote content or `eval` |
| **Preload (app UI only)** | Bridge | Exposes a frozen, typed API via `contextBridge` (`window.ugc.bundles.list()`, etc.) | Expose `ipcRenderer` itself, Node APIs, or generic `invoke(channel, ...)` |
| **Renderer (app UI)** | Semi-trusted | React UI, served from a custom `app://` protocol with strict CSP | Ever receive cookie values, vault plaintext or raw import JSON |
| **Third-party views** (Kalodata, TikTok…) | **Untrusted** | `WebContentsView` bound to that session's partition | Get **any** preload or IPC access |

Third-party view `webPreferences`: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, no preload, `session = fromPartition(partitionId)`.

Electron Fuses (set at package time): `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, `EnableEmbeddedAsarIntegrityValidation` on, **`EnableCookieEncryption` on** (see §11; Electron's default is off).

---

## 5. Typed / allowlisted IPC and security model

- One `ipcMain.handle` per **named channel** from a closed allowlist (e.g. `bundle:create`, `session:import-from-file`, `session:open-browser`, `session:recheck`, `session:clear`). No wildcard or dynamic channels.
- Every handler: (1) checks the sender is the **main app window's** `webContents` and that `senderFrame.url` has the `app://` origin; (2) validates input with a runtime schema (zod or similar), rejecting unknown keys; (3) authorizes the request (e.g. the session exists and isn't being deleted); (4) returns **non-secret DTOs** only; (5) maps errors to safe error codes, never raw stack traces carrying data.
- **Key design choice:** the renderer never touches cookie JSON. `session:import-from-file` makes the **main process** open the native file dialog and read the file. The renderer only gets the non-secret import report. Paste and drag-drop are deliberately excluded in M1 because they route secrets through the renderer.
- Untrusted views: `setWindowOpenHandler` denies by default (or opens in the same partition if the domain is allowlisted); `will-navigate`/`will-redirect` limited to the platform's domain allowlist plus required auth domains; other links go to the system browser only after user confirmation; `setPermissionRequestHandler` denies by default (camera, mic, notifications, geolocation…); downloads blocked or confined (M1).
- App UI CSP: `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`, with no remote scripts.

---

## 6. Cookie-Editor parsing, schema detection and validation

**Assumed input format (verify at Gate 1 against a real export from a throwaway/synthetic site):** Cookie-Editor's JSON export on Chrome is an array of objects mirroring Chrome's `chrome.cookies.Cookie`: `name`, `value`, `domain`, `hostOnly`, `path`, `secure`, `httpOnly`, `sameSite` (`"no_restriction" | "lax" | "strict" | "unspecified"`, possibly `null`), `session`, `expirationDate` (float Unix seconds, absent for session cookies), `storeId`, and possibly `partitionKey` on newer Chrome. **This is an assumption until verified.**

**Detection** returns one of: `cookie-editor-chrome-json` (supported) | `netscape-txt`, `header-string`, `firefox-json`, `unknown` (each rejected with a clear message). No guessing across formats.

**Whole-file rules:** max file size (proposal: 2 MB); UTF-8 only; plain `JSON.parse`; top level must be an array; max 5,000 entries; `__proto__`/`constructor` keys ignored and objects copied into fresh records; unknown fields ignored but counted.

**Per-cookie rules** (outcome: imported / skipped / rejected, each with a reason code):

| Check | Rule |
|---|---|
| Shape | `name` non-empty string; `value` string; booleans are booleans; `expirationDate` finite number if present |
| Characters | name/value contain no control chars, `;`, or newline (RFC 6265 subset) |
| Domain | lowercased, leading dot stripped; must equal or be a subdomain of the **target platform's allowlist** (e.g. Kalodata → `kalodata.com`); otherwise **rejected: out-of-scope domain** (least privilege: an export containing unrelated Google cookies won't be imported into Kalodata) |
| Path | must start with `/`; default `/` |
| Prefixes | `__Secure-` requires `secure`; `__Host-` requires `secure`, `hostOnly`, `path=/`; violations rejected |
| SameSite | `no_restriction`→`none`; `lax`; `strict`; `unspecified`/`null`→`unspecified`. `none` without `secure` → **rejected** (never silently "fixed") |
| Expiry | `expirationDate ≤ now` → **skipped: expired**. `session:true` or missing expiry → session cookie |
| Partition | `partitionKey` present → kept in the normalized model; if the target adapter can't honor it → **skipped: unsupported partitioned cookie** (never imported as unpartitioned, which would change its security scope) |
| Duplicates | identity = (name, domain, hostOnly, path, partitionKey). Exact duplicates collapse. Conflicting duplicates: **every entry in the group is rejected** with a non-sensitive diagnostic (D5, as approved) |
| Security | the importer never sets `secure`/`httpOnly` to false or loosens SameSite relative to the source |

**Report (non-secret):** format detected, target platform, counts examined/imported/skipped/rejected, reason-code histogram, cookie **names** optionally (decision D6: some names are themselves sensitive-ish, so I'd default to counts only), timestamp, resulting status. Never values.

---

## 7. Normalized session representation

A browser-independent, versioned payload stored **only inside the vault**:

| Field | Notes |
|---|---|
| `formatVersion` | `1` |
| `platform`, `source` (`cookie-editor-chrome-json`), `importedAt` | metadata |
| `cookies[]` | `{ name, value, domain, hostOnly, path, secure, httpOnly, sameSite: 'strict'\|'lax'\|'none'\|'unspecified', expiresAt: unixSeconds\|null, partitionKey?: { topLevelSite, hasCrossSiteAncestor? } }` |
| `origins[]` (reserved) | future localStorage per origin, matching Playwright `storageState` shape; empty in M1 |

Adapters convert *from* this model: `toElectron(cookie)` and, later, `toPlaywright(cookie)`. The model keeps `unspecified` SameSite and `hostOnly` precisely so that information isn't lost before the adapter decides.

---

## 8. Electron isolated-session / partition strategy

- Partition ID: `persist:ps_<uuidv4 or ULID>`, generated once at PlatformSession creation, **independent of bundle name**, never reused, unique in SQLite. Renaming a bundle never changes it.
- Each partition is its own Chromium profile on disk (under `userData/Partitions/…`): separate cookie jar, localStorage, IndexedDB, cache and service workers.
- Load: `cookies.set({ url, name, value, path, secure, httpOnly, sameSite, expirationDate, domain? })`. `url` is built from `https://<domain><path>`. `domain` is passed **only** for domain cookies (omitting it makes a host-only cookie). After batch load, `cookies.flushStore()`.
- Per partition: permission handler, navigation policy, a realistic default user agent (no spoofing of other browsers' identities; see §24), and no shared `protocol` handlers.
- Clear: `session.clearStorageData()` + `clearCache()`, then mark the partition directory for **deletion on next app start** (Chromium holds files open while the session is alive). The deletion is tracked in SQLite so a crash can't orphan it.
- **Unverified, tested at Gate 1:** (a) whether session cookies (no expiry) survive app restart in a `persist:` partition; (b) whether Electron's `cookies.set` supports partitioned (CHIPS) cookies; (c) how `unspecified` SameSite round-trips.

---

## 9. Future Playwright context / storage-state strategy

- Worker runs Playwright-managed Chromium, **no Electron dependency**.
- Per PlatformSession: `launchPersistentContext(userDataDir)` with a per-session directory **or** ephemeral `newContext({ storageState })` rebuilt from the vault each run. Recommendation: ephemeral context + vault as source of truth (stateless workers, easy recovery), with persistent dirs only where a platform proves it needs long-lived non-cookie state.
- Cookie load: `context.addCookies()`; `expires: -1` for session cookies; `sameSite` must be `Strict|Lax|None` (no `unspecified`).
- One browser context per account per job, concurrency limits, per-account locks (see §22).

---

## 10. What Electron and Playwright can share, cannot share, and conversion losses

| State | Portable via normalized vault payload? | Notes / losses |
|---|---|---|
| Cookies (name, value, domain, path, secure, httpOnly, expiry) | **Yes** | Exact. |
| Host-only vs domain cookie | Yes | Electron: omit `domain`. Playwright: use `url` instead of `domain`. |
| SameSite `unspecified` | **Lossy in Playwright** | Must be mapped to explicit `Lax`. Chromium's "Lax-by-default" has a short POST-allowance nuance; explicit `Lax` lacks it. Low practical impact, documented. |
| Partitioned cookies (CHIPS) | Partial | Playwright supports `partitionKey` (recent versions); Electron support unverified. |
| localStorage | Possible (future) | Playwright `storageState.origins`; Electron needs page-script extraction. Not in M1. |
| IndexedDB | Partial | Playwright can snapshot it in storageState (recent versions); Electron has no clean API. Not in M1. |
| Service workers, Cache Storage, HTTP cache | **No** | Not portable. |
| Browser/device-bound credentials (e.g. Google DBSC, TPM-bound keys), client certs, device fingerprints, IP reputation | **No, by design** | Can't and must not be transferred or spoofed. |
| Profile directories | **No** | Never copy Electron profile dirs to Playwright or vice versa (undocumented internals, version- and OS-specific encryption). |

**Portability ≠ acceptance.** The data can move; whether TikTok/Kalodata/Google accept a session from a new device/IP/OS is a separate, **unverified** platform behavior.

---

## 11. Encrypted vault and Linux encryption future path

**Design: envelope encryption.**
- `packages/vault`: each secret payload is encrypted with a random 256-bit data key using AES-256-GCM (Node `crypto`), with associated data = `vaultRef + platform + formatVersion` (binds ciphertext to its record, preventing swap attacks).
- The data key is wrapped by a **KeyProvider** port:
  - **Windows (M1):** Electron `safeStorage` (DPAPI). Hard requirement: `safeStorage.isEncryptionAvailable()` must be true after `app.ready`, or the app refuses to store secrets. **No plaintext fallback, ever.**
  - **Linux worker (future):** Electron isn't present. Options: systemd-creds (TPM/host key), a cloud KMS, or HashiCorp Vault/OpenBao. Never a key file sitting next to the ciphertext. Electron's own Linux `safeStorage` can silently use a `basic_text` backend on headless systems; the adapter must check `getSelectedStorageBackend()` and refuse that. That only matters if Electron ever runs on Linux, which it won't for the worker.
- Storage: one encrypted blob file per `vaultRef` under `userData/vault/`, with restrictive ACLs where feasible; SQLite stores only the `vaultRef`.

**Honest guarantees (DPAPI):** protects against other Windows users and offline disk theft while the user is logged out. **It does not protect against malware running as the same Windows user**, which can call DPAPI too. A Windows reinstall or new machine leaves the vault unreadable, so re-import is required. This is acceptable and documented.

**Second at-rest copy (important finding):** after import, Chromium also stores the cookies in the partition's own cookie database. In Electron that database is **not encrypted unless the `EnableCookieEncryption` fuse is enabled.** Recommendation: enable it (D3). Then both copies are OS-protected.

---

## 12. Minimal SQLite schema and migration strategy

Library: `better-sqlite3` in the main process (synchronous, mature, prebuilt Electron binaries usually available; native-rebuild risk noted). Alternative: Node's built-in `node:sqlite` if stable in the pinned Electron's Node (D8).

```sql
-- illustrative schema, not implementation
CREATE TABLE account_bundles (
  id            TEXT PRIMARY KEY,                    -- uuid v4
  display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  mode          TEXT NOT NULL CHECK (mode IN ('affiliate_ugc','account_growth')),
  status        TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  config_json   TEXT NOT NULL DEFAULT '{}',          -- non-secret, schema-validated
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (display_name)
);
CREATE TABLE platform_sessions (
  id              TEXT PRIMARY KEY,
  bundle_id       TEXT NOT NULL REFERENCES account_bundles(id) ON DELETE RESTRICT,
  platform        TEXT NOT NULL CHECK (platform IN ('tiktok','kalodata','google_flow','shopee')),
  partition_id    TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('never_configured','imported_unverified',
                    'appears_authenticated','expired','rejected','network_error',
                    'waiting_for_user','locked_unavailable')),
  status_reason   TEXT,                              -- non-secret code, e.g. 'redirected_to_login'
  vault_ref       TEXT UNIQUE,                       -- NULL until import
  last_import_report_json TEXT,                      -- counts + reason codes only
  last_imported_at TEXT, last_checked_at TEXT,
  lifecycle       TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','pending_deletion')),
  created_at      TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (bundle_id, platform)                       -- M1: one session per platform per bundle (D4)
);
```

- `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, UTC ISO-8601 timestamps.
- **Deletion:** `ON DELETE RESTRICT` forces deletion through an application service: mark `pending_deletion` → clear partition storage → delete vault blob → delete row → partition directory removed on next start. Restart reconciliation finishes any half-done deletion.
- **Migrations:** numbered forward-only SQL files, applied in a transaction, tracked with `PRAGMA user_version`; automatic DB file backup before migrating; migration tests run against an empty DB and the previous version's DB.
- A test asserts that no column ever holds a synthetic secret value (§15).

---

## 13. Log / diagnostic redaction

- One logger interface in `core`. It accepts structured events (`event`, codes, IDs, counts), not free-form secret-bearing strings.
- The redactor runs on every log, error and crash path. It masks: `Cookie`/`Set-Cookie`/`Authorization` headers, any key named like `value|token|secret|password|session|auth|sig|cookie`, URL query params (keep path, drop query by default), JWT-shaped and long high-entropy strings, and `Bearer …`.
- Cookie objects and normalized payloads have a custom `toJSON`/`inspect` that prints `[REDACTED]`, so they can't be logged by accident.
- Electron `crashReporter`: disabled in M1, or local-only with no upload.
- DevTools disabled on third-party views in production builds.
- Tests feed canary values (e.g. `SYNTHETIC_CANARY_7f3a…`) through import, errors and logging, then grep logs, SQLite, reports and the repo for the canary.
- Repository: `.gitignore` for `*.cookies.json`, `userData`, `vault/`, `.env*`; pre-commit secret scanning (gitleaks) plus GitHub secret scanning (proposal D9).

---

## 14. Synthetic proof-of-concept design and tests (Gate 1)

**Test site:** a tiny local HTTPS server (self-signed cert trusted **only** in the test build via a certificate-verify handler scoped to test partitions) serving two fake hostnames (`site-a.ugc.test`, `site-b.ugc.test`). Electron maps them to 127.0.0.1 with the `host-resolver-rules` switch in test builds only. `/whoami` returns "authenticated as X" only if the synthetic cookie is valid.

**PoC steps → evidence:**
1. Import synthetic Cookie-Editor-format JSON for profile A → report counts.
2. Validate/normalize; malformed fixtures rejected with reason codes.
3. Load into `persist:ps_A`; open site-a in a sandboxed view → page says authenticated.
4. Quit (after `flushStore`) → relaunch → still authenticated (persistent cookie); session-cookie behavior recorded as a finding.
5. Profile B with different cookie → B authenticated as B; A's cookie absent from B (checked via `cookies.get` **and** via server-side request headers).
6. Cookie-only limitation demo: a site page requiring a localStorage token **plus** the cookie → shows cookie-only import fails, which documents why real sites may reject.
7. Attribute experiments: `__Host-`, SameSite=None/Secure, `unspecified`, partitioned cookie, expired, duplicate.

**Automated tests:** Vitest unit tests for detection/validation/normalization/redaction (pure, run in CI on Linux); Playwright-`_electron` end-to-end tests for steps 3–7 (Linux CI with xvfb **and** manual run on Windows). Results reported separately as unit-tested / integration-tested / manually verified on Windows / untested.

Not in Gate 1: account UI, production repositories, final vault, any real site.

---

## 15. User-controlled authorized Kalodata validation (Gate 2)

Runs **only on your Windows laptop**, never in a cloud session.
1. You log in to Kalodata in ordinary Chrome and export with Cookie-Editor to a file in a local, **non-OneDrive** folder.
2. The PoC app's main process reads the file via the native file dialog and stores it immediately in the minimal protected store (safeStorage-wrapped). You then delete the export file (on SSDs, deletion isn't guaranteed secure erasure; documented).
3. Open Kalodata in its isolated partition; **you** judge whether you're logged in (screenshots avoided or cropped of account data).
4. Restart, recheck. Optionally recheck the next day (expiry behavior).
5. Record any MFA, CAPTCHA, logout, "new device" email or concurrent-session kick-out (e.g. your Chrome session logged out) as **findings**. No workaround attempts.
6. If cookie-only import fails, the recommendation is authorized interactive login inside the isolated partition (if Kalodata allows it in an embedded browser).
7. Only the non-secret report and your observations come back to the chat.

Before Gate 2, you should read Kalodata's Terms regarding automated access, data extraction and account sharing (see §24).

---

## 16. Future product catalog and product matching boundaries

- Separate entities and states: `ResearchCandidate` (Kalodata observation with source and timestamp) → `ShopListing` (exact TikTok Shop product ID + seller ID) → `CreatorEligibility` → `ShowcaseEntry` → `VideoProductAttachment` → `PublishedPost`.
- Matching is **by platform IDs**, never by title or image. A candidate with no resolvable listing ID stays `identity_pending` and needs human review. Similar listings from different sellers are never interchangeable.
- Metrics are stored with provenance (`source`, `observedAt`, "as displayed"). Nothing is computed or invented.
- M1 boundary: none of this is built; `core/domain` gets no product types yet.

---

## 17. Showcase eligibility and yellow-basket attachment boundaries

- Research popularity ≠ eligibility; Showcase membership ≠ the post's product link. Each is verified separately and recorded with evidence and a timestamp.
- **Risk:** I'm not aware of a public, creator-accessible API for adding Showcase products or attaching product anchors to TikTok posts in Indonesia. TikTok Shop Open API affiliate features are mostly for sellers/partners; whether any applies to your accounts is **unverified**. Automating the TikTok Studio/mobile UI for this may breach TikTok's terms and is brittle.
- Recommended default: an **assisted workflow**. The app prepares video, caption and the exact product ID and opens the correct isolated session; the human performs Showcase addition and product attachment; the app then verifies the result where observable and won't mark a job complete without verification.
- Hard rule (from spec): attachment failure → `waiting_for_user`/exception, never a silent unlinked affiliate post.

---

## 18. Regular vs shoppable video scheduling risks

- Standard scheduling (TikTok Studio web, or Content Posting API for approved apps) and **scheduling a post with a product anchor** are different capabilities. The latter is **unverified for TikTok Shop Indonesia** and may be unavailable, available only in-app, or account-dependent.
- TikTok's Content Posting API requires app review/audit; unaudited apps may only post privately. I'm not aware of product-anchor support there (unverified).
- Implication: the future scheduler models `capabilities` per account (`canSchedule`, `canAttachProduct`, `canScheduleWithProduct`), detected and recorded manually, never assumed. Affiliate jobs without `canScheduleWithProduct` become "ready for human publish at time T" notifications.

---

## 19. Affiliate vs account-growth pipeline separation

- Mode lives on the bundle; jobs carry `pipeline` explicitly, and code paths are separate (growth jobs never touch product state; affiliate jobs can't reach `completed` without a verified attachment).
- Mode switch Growth → Affiliate requires a recorded, human-confirmed eligibility verification. **No hardcoded follower threshold.**
- Separate media roots (`affiliate/…`, `account-growth/…`) are presentation only; the DB is the source of truth.
- Out of scope permanently: fake engagement, purchased followers, bulk account creation, ban evasion.

---

## 20. Future Google Flow provider interface

- `VideoGenerationProvider` port: `submit(request) → providerJobId`, `status(id)`, `fetchOutput(id) → file`, `cancel(id)`, `estimateCost?()`, with a normalized request (prompt, reference images, product assets, aspect ratio, duration, style, character reference) and normalized errors (`quota_exhausted`, `auth_required`, `policy_rejected`, `transient`).
- Implementations: `FlowBrowserProvider` (unverified), plus room for an API provider.
- **High risk (strong disagreement, see §26):** Google sign-in commonly refuses embedded/automated browsers, and Google is rolling out **device-bound session credentials** on Chrome for Windows, which bind Google session cookies to the device. A Cookie-Editor export of Google cookies may therefore stop working in Electron, and almost certainly on a Linux VPS. Unattended Flow automation should be treated as **probably infeasible** until proven, with a fallback (Veo via the Gemini API / Vertex AI, paid per use) kept available.

---

## 21. Future n8n / VPS scheduling and independent workers

- n8n (optional) only triggers jobs by ID via an authenticated internal API. It never receives cookies, vault data or session payloads, so execution logs can't leak them.
- Workers are a separate Node service (Playwright, no Electron) that pulls jobs from a durable queue (PostgreSQL with `SELECT … FOR UPDATE SKIP LOCKED` is enough; Redis optional).
- The desktop app becomes a client of the backend later; M1 stays local-only. The `core` package is shared so models, validation and redaction behave identically.

---

## 22. Reliability, retry, recovery and idempotency boundaries

- Job states: `pending → running → completed | waiting_for_user | retryable_failure | permanent_failure`.
- `running` always holds a **lease** with expiry plus heartbeat; an expired lease returns to `retryable_failure` on reconciliation, so nothing stays stuck in `running` after a crash.
- Per-account lock (one active browser job per PlatformSession); global concurrency cap; bounded exponential backoff with jitter; max attempts per error class; auth errors → `waiting_for_user`, not retries.
- Publishing idempotency: each publish has a stable `idempotencyKey`; before retrying, the worker **checks whether the post already exists** (by caption marker/time window/post ID) to prevent duplicates.
- Append-only audit log of state transitions (non-secret).
- M1 boundary: none implemented. M1's only relevance is a restart reconciliation for `pending_deletion` sessions and for "checking" statuses.

---

## 23. Security threats and mitigations

| Threat | Mitigation |
|---|---|
| Secret leakage via logs/errors/crash dumps | Structured logging, redactor, `[REDACTED]` serialization, crash upload off, canary tests |
| Secrets in Git | `.gitignore`, gitleaks pre-commit, synthetic fixtures only, canary scan of repo |
| Hostile/oversized JSON | Size/count limits, strict schema, no prototype pollution, char validation |
| Cookie injection for other domains | Platform domain allowlist; out-of-scope cookies rejected |
| Profile crossover | Unique partition per session, UUID partition IDs, isolation tests (API + server-side) |
| Vault theft (disk copy) | DPAPI-wrapped keys, AES-GCM with AAD, cookie-DB encryption fuse |
| Same-user malware | **Not fully mitigable**; documented. Minimize exposure: no plaintext temp files, short-lived plaintext in memory |
| Renderer compromise (app UI) | Context isolation, sandbox, CSP, narrow preload, renderer never gets secrets |
| Malicious third-party page | No preload/IPC, sandbox, navigation/popup/permission restrictions |
| Unsafe IPC | Allowlisted channels, sender verification, schema validation, authorization |
| Expired/revoked sessions | Honest statuses, recheck, re-import/reconnect flows |
| Device verification / MFA | Treated as `waiting_for_user`; never bypassed |
| Malicious dependencies | Minimal deps, exact pins, lockfile, `pnpm` with `onlyBuiltDependencies` allowlist for install scripts, audit in CI |
| Tampered app binary | ASAR integrity fuse, code signing (D7) |

---

## 24. Platform compliance and login-portability risks

- **Kalodata:** ToS may restrict automated extraction, scraping and account sharing, and some plans limit concurrent devices. **Unverified; must be read before Gate 2 and before any research automation.** If automation is disallowed, the compliant alternative is manual browsing in the isolated browser, or importing Kalodata's own exports if your plan provides them (unverified).
- **TikTok / TikTok Shop:** automation of posting UIs and multi-account operation may breach terms; official APIs require app review. Assisted workflows are the safe default.
- **Google Flow:** see §20 (embedded-browser sign-in blocks, device-bound sessions, ToS on automated use).
- **Shopee:** affiliate program terms on automation unverified.
- **Portability:** sessions may be invalidated on IP/country/OS/device change. Laptop → VPS migration is a separate, per-platform experiment, never assumed.
- No user-agent spoofing, fingerprint evasion, CAPTCHA solving or "stealth" plugins, by design.

---

## 25. Assumptions and unresolved issues

1. Cookie-Editor's Chrome JSON export matches the `chrome.cookies.Cookie` shape (verify at Gate 1).
2. Your Windows environment meets the prerequisites (unverified; see §1.2).
3. Electron session cookies' restart persistence and CHIPS support (Gate 1 experiments).
4. Kalodata accepts imported cookies in Electron (Gate 2).
5. TikTok Shop Indonesia shoppable scheduling capability (future manual check).
6. Google Flow cookie portability (likely negative; future spike).
7. Which TikTok/Kalodata/Flow/Shopee domains are needed per platform allowlist (from Gate 2 non-secret observations).
8. Whether you'll run Gates 1–3 runtime checks yourself on Windows, or via Claude Code running locally on Windows.

---

## 26. Technical disagreements, with reasons and alternatives

| # | Spec position / assumption | Concern & evidence | Recommendation |
|---|---|---|---|
| 1 | "Inspect the actual Windows environment" in this session | This session is a Linux cloud container with no access to your laptop | You run the read-only script (§1.2) **or** run Claude Code locally on Windows for Gate 0 re-check and Gates 1–3 runtime work |
| 2 | Suggested 8+ packages | Most splits add build overhead without a real boundary in M1 | 4 workspaces (§3); split later when a second consumer exists |
| 3 | Google Flow via cookie session as the preferred unattended provider | Google blocks embedded/automated sign-in and is binding sessions to devices; a VPS move is very likely to fail | Keep Flow as an interactive/assisted option; budget for an API fallback; spike before any design depends on it |
| 4 | Automated yellow-basket attachment & shoppable scheduling as an end goal | No known public creator API; UI automation risks ToS violation and is brittle | Assisted publish + automated verification as the default design target |
| 5 | Vault is the only secret store | Chromium also stores cookies on disk, plaintext unless a fuse is set | Enable `EnableCookieEncryption`; document dual-copy risk |
| 6 | Cookie import via any input path | Paste/drag-drop pass secrets through the renderer | File-dialog-only import in M1, read in the main process |
| 7 | Kalodata data capture | Possible ToS conflict | Legal/ToS review before research automation; manual or export-based alternative |

---

## 27. Decisions needing product-owner approval

- **D1** Execution model: run Windows runtime gates yourself, or use Claude Code locally on Windows (recommended for Gates 1–3 runtime checks; mandatory for Gate 2).
- **D2** Accept the 4-workspace layout (§3).
- **D3** Enable the Electron `EnableCookieEncryption` fuse and the other fuses (§4, §11).
- **D4** M1 constraint: one PlatformSession per platform per bundle (`UNIQUE(bundle_id, platform)`).
- **D5** Conflicting-duplicate cookie rule. *Decided: reject all conflicting entries (see `docs/DECISIONS.md`).*
- **D6** Import report shows counts/reasons only, no cookie names, by default.
- **D7** Installer tooling (electron-builder NSIS proposed) and whether to obtain a code-signing certificate later (unsigned builds trigger SmartScreen warnings).
- **D8** SQLite library: `better-sqlite3` (proposed) vs `node:sqlite`.
- **D9** Secret scanning: gitleaks pre-commit + GitHub secret scanning.
- **D10** Accept "assisted workflow" as the default target for Showcase/yellow basket/shoppable scheduling, pending platform validation. *Decided otherwise: automation stays the objective; shoppable scheduling is risk R-01.*
- **D11** Accept Google Flow as high-risk/unverified, with a paid API provider as a documented fallback. *Decided: Flow stays preferred; portability risk and API fallback in R-02.*
- **D12** Commit to reading Kalodata/TikTok/Google ToS before the respective automation gates.

---

## 28. Stage-gate sequence and verification criteria

| Gate | Scope | Exit evidence |
|---|---|---|
| **0** | This report + Windows inspection output | Your approval; Windows facts filled in from the §1.2 output |
| **1** | Synthetic PoC (§14) | Unit tests pass in CI; Electron e2e passes on Linux CI **and** is manually run on Windows; isolation shown by API + server; restart persistence shown; cookie-only limitation demonstrated; findings report; no real secrets anywhere |
| **2** | Authorized Kalodata check (§15), local on Windows | Non-secret report; your observation of logged-in state before/after restart; challenges recorded; go/no-go on cookie import vs interactive login |
| **3** | Milestone 1 Session Manager | All 11 acceptance criteria in spec §18, each marked tested / manually verified with evidence; risk register; Linux boundary doc |
| Later | Research, generation, Showcase, publishing, VPS | Each needs separate authorization and its own spike for platform permission |
