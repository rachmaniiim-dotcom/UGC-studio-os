# Risk and Limitation Register

Status values: **open** (unresolved), **mitigated** (control in place and tested), **accepted** (known and tolerated), **needs validation** (only real-world testing can settle it).

## Integration risks (platforms)

| ID | Risk | Impact | Status | Next step |
|---|---|---|---|---|
| R-01 | **Shoppable scheduling is unproven.** Ordinary TikTok scheduling (TikTok Studio web scheduler, Content Posting API) may not support attaching a TikTok Shop product (yellow basket / keranjang kuning) to a *scheduled* post in TikTok Shop Indonesia, or only for some accounts or only in-app. Product attachment and scheduling are separate capabilities. | Affiliate videos could post without a product link, or need a human at publish time | **needs validation** | Validate on a real eligible account before designing the publisher. The future scheduler must model `canSchedule`, `canAttachProduct` and `canScheduleWithProduct` per account, detected, never assumed. A failed attachment must raise an exception, never post unlinked (spec §5 step 14) |
| R-02 | **Google Flow authentication portability.** Flow is the preferred provider, but: Google often blocks sign-in from embedded or automated browsers; Chrome on Windows is rolling out device-bound session credentials that tie Google session cookies to the device; sessions may be invalidated on IP/OS/device change (laptop → VPS). A Cookie-Editor export of Google cookies may not work in Electron and is unlikely to work on a Linux server. | Unattended generation may be impossible via cookies | **needs validation** | Dedicated Flow spike after Gate 2. Keep the provider interface replaceable. **Possible authorized fallback:** Google's official Veo access through the Gemini API or Vertex AI (paid per use, API key or service account, no browser session). Pricing and terms must be checked when the fallback is considered |
| R-03 | Kalodata terms may restrict automated extraction, scraping or concurrent/shared sessions (unverified) | Research automation could breach terms or log the owner out | **open** | Owner reads the terms before Gate 2 and before any research automation |
| R-04 | TikTok / TikTok Shop UI automation may breach terms; official APIs require app review | Account risk; brittle automation | **open** | Prefer official APIs where they exist; validate per capability |
| R-05 | Device/IP-bound sessions: platforms may reject imported sessions on a different machine, OS or IP | Laptop → VPS migration may need re-login on the server | **needs validation** | Per-platform experiment; never bypass checks |

## Technical findings from Gate 1

| ID | Finding | Status | Consequence / mitigation |
|---|---|---|---|
| R-10 | **Session cookies are lost on restart.** Cookies without `expirationDate` imported into a `persist:` partition are gone after the app restarts (tested, Electron 44.9.3) | **accepted, design change needed** | Many sites keep logins in session cookies. Gate 3 must re-load them from the encrypted vault at startup (vault = source of truth), and status must show "re-import needed" honestly |
| R-11 | **Partitioned (CHIPS) cookies can't be loaded.** Electron 44's `cookies.set()` has no partition-key field | **mitigated** | The adapter skips them with `unsupported_partitioned` and reports it; it never stores them unpartitioned. Re-check on Electron upgrades |
| R-12 | **Cookie-only import is insufficient for sites needing non-cookie state** (localStorage, IndexedDB, device tokens). Shown with the synthetic `/strict` page | **accepted** | Interactive login in the isolated partition works and persists across restart (tested). Real sites: Gate 2 finding |
| R-13 | **Without the fuse, cookie values sit in plaintext** in the partition's `Cookies` SQLite database (tested) | **mitigated in code; packaging pending** | Import refuses to run unless the `EnableCookieEncryption` fuse is on (explicit synthetic-only override for tests). Production fuse set defined in `apps/desktop/scripts/fuse-config.mjs`; must be applied and verified when packaging exists |
| R-14 | **On headless Linux, Chromium's cookie encryption is obfuscation only.** With the fuse on, values were encrypted (`v10` prefix), but with no OS keyring Chromium uses a built-in fallback key. `safeStorage` reported `isEncryptionAvailable: false`, backend `basic_text` | **accepted for the container; Windows unverified** | On Windows `v10` is AES-GCM with a DPAPI-protected key: needs Windows validation. The future Linux worker must not rely on Chromium/Electron encryption; use systemd-creds, KMS or Vault |
| R-15 | **Chromium refuses to run as root without `--no-sandbox`.** In the container the suite runs as an unprivileged user under Xvfb, so the sandbox stays on | **mitigated** | `scripts/e2e-container.sh`. The app never passes `--no-sandbox` |
| R-16 | Playwright drives Electron through `--inspect` and remote debugging, which the production fuse set disables | **open** | Packaged-build tests need another approach (e.g. fuses applied after e2e, or a test-only packaged variant). Not solved in Gate 1 |
| R-17 | The forged-IPC test calls Electron's private `ipcMain._invokeHandlers` | **accepted** | Test-only; may break on Electron upgrades |
| R-18 | Reading the fuse wire scans the ~229 MB Electron binary on first import | **open** | Not measured. Cache is per process. Consider reading once at startup or checking at packaging time |
| R-19 | Same-user malware can read anything the app can (DPAPI and Chromium encryption protect against other users and offline theft, not processes running as the same user) | **accepted** | Documented; minimize plaintext lifetime |

## Validation gaps

| ID | Gap | Status |
|---|---|---|
| V-01 | Nothing has run on Windows: launch, DPAPI/`safeStorage`, cookie encryption, Windows paths, installer | **blocked** (owner away; deferred by D1) |
| V-02 | Packaged build with the full production fuse set | **planned** (no packaging tool chosen yet, D7) |
| V-03 | Cookie-Editor's real export, observed on a real browser (format was checked against Cookie-Editor 1.13.0 source code, not a live export) | **planned** (Gate 2) |
