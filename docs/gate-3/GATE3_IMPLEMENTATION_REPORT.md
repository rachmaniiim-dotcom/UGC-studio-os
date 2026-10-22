# Gate 3 Implementation Report: Account Setup and Session Manager

**Date:** 2026-10-22 · **Branch:** `ccr-aecbb29a-dleiwi`
**Scope (approved):** Account Bundles with a dedicated proxy, in-app Cookie-Editor JSON setup per platform, React interface. Synthetic data only in every automated test. No real proxy credentials or cookies were used or seen. No Kalodata scraping or automated research, no Flow generation, no TikTok upload/Showcase/yellow basket, no VPS.

## 1. Features implemented

**Account model (SQLite `ugc.db`, migration 1)**
- `account_bundles`: id (UUID), display name, mode (Affiliate UGC / Account Growth), non-secret proxy state.
- `platform_sessions`: one isolated partition per platform per bundle; non-secret state only.
- The Gate 1/2 `poc-profiles.json` is imported once and then renamed.
- Secrets never go into SQLite. A unit test checks that no column name suggests a secret.

**Account status** (computed):
| Status | Meaning |
|---|---|
| `draft` | No proxy, or a proxy that has never passed. **No external website can open** |
| `proxy_check_needed` | The proxy passed before but must pass again in this run, e.g. after a restart |
| `operational` | The proxy passed in this run |
| `attention` | The proxy failed, or a session expired, was rejected or can't be restored |

**Dedicated proxy per bundle**
- **Fields:** protocol (HTTP, HTTPS, SOCKS5 without login), host or IP, port, username, password.
- **Credentials:** encrypted with DPAPI (`safeStorage`) in `proxy-secrets/<bundleId>.proxy`, never returned to the UI. When editing, "keep saved credentials" is available.
- **One proxy for the whole bundle:** applied to every one of the bundle's platform partitions, with no direct fallback.
- **A bundle without a proxy is pinned to a closed local port**, so even a stray request fails instead of going direct.
- **Test Proxy:** reports the observed public IP, which check service answered (primary or backup), and sanitized errors with a recovery action.
- **Fail closed:** browsing is blocked until the proxy passes in this run. Opening a session validates the proxy first.
- **Editing or replacing:** closes the bundle's windows and old connections, clears the auth cache, and requires a new test.

**Platform sessions** (TikTok, Google Flow, Kalodata optional, Shopee optional), one card each:
- paste Cookie-Editor JSON, or **Import JSON file…**;
- **Validate & encrypt**;
- status;
- re-import;
- **Log in here / Open browser** (through the bundle's proxy);
- **I'm logged in / I'm logged out** (owner-confirmed status);
- **Clear session** (with an inline confirmation).

A draft can be saved with no sessions set up. Every platform is manual-only: no automated checks, no app-initiated requests.

**Paste handling**
- **No copies in the renderer:** the textarea is uncontrolled, and its text never enters React state or storage.
- **Cleared before anything else:** on submit, the element is replaced (dropping its undo history) **before** the request is sent.
- **One-way trip:** the main process validates the text with the existing importer (platform scope, all checks), loads it into the partition, seals the session snapshot (C1), and zeroes the byte buffer. The renderer receives only counts.

**React interface**
- **Account list:** status, proxy and session chips.
- **Add/Edit Account:** steps 1 to 3, then "Save and close".
- **Error messages:** plain language with a recovery action for every error code; field-level messages for invalid input.

**Other changes**
- `run-app.mjs` launcher (replaces `run-gate2.mjs`): refuses an unfused binary and data folders inside the repo or OneDrive.
- `security-check` covers bundles and proxy credentials.
- Pre-commit hook and `.gitignore` cover `ugc.db`, `proxy-secrets/` and `*.proxy`.

**Preserved:** C1 session sync, with rotation, encrypted restore and rollback checks (now per platform session); isolation; the cookie-encryption guard; the first-launch key guard; redaction; the fuse-independent tests. The Gate 1/2 synthetic test profiles remain for regression tests, in synthetic runs only.

## 2. Tests executed (Windows, Electron 44.9.3), exact results

| Suite | Command | Result |
|---|---|---|
| TypeScript typecheck (source + tests) | `pnpm typecheck` | **pass, 0 errors** |
| Unit tests | `pnpm test:unit` | **209 passed** (11 files) |
| Secret scan | `pnpm check:secrets` | **no findings** |
| Electron end-to-end, dev fuse ON, native dialog on | `UGC_E2E_NATIVE_DIALOG=1 pnpm test:e2e` | **46 passed**, 0 failed (3.0 min) |
| Same, dev fuse OFF | same | **46 passed**, 0 failed |
| Security check on the real (empty) data folder + repo | `pnpm security-check` | **PASS**, 0 findings |
| Mutation: draft not pinned to the closed port | blackhole test | **failed as expected**: a raw request reached the site directly |
| Mutation: drafts allowed to browse | two-accounts test | **failed as expected** |
| Mutation: pasted JSON not cleared | UI test | **failed as expected**: the textarea kept the text |
| Clean real-mode launch via `run-app.mjs` | manual smoke | refuses repo/OneDrive folders; window "UGC Production OS — Session Manager"; `app_ready synthetic:false`; clean exit |

New or changed end-to-end coverage:
- **UI workflow (real clicks and typing):** Add Account → name and mode → Save draft → proxy with a wrong password (failure and recovery message) → correct credentials → Test Proxy (observed IP) → invalid JSON and wrong-platform JSON (explained, input cleared) → paste TikTok JSON → Validate & encrypt (input cleared, 2/2 imported, session cookie sealed) → Open browser through the proxy → "I'm logged in" → Save and close → second account as a draft.
- **Then restart:** the account shows `proxy_check_needed`; the session cookie is restored; Open browser re-validates the proxy; traffic only from the proxy exit IP. Afterwards: no cookie, canary, proxy username or password in userData or logs; app UI localStorage and sessionStorage empty.
- **Clean launch in real mode:** fresh profile, real platform definitions, Add Account interface, four session cards, browsing disabled, no network.
- **Proxy routing and isolation:**
  - 2 accounts × 2 platforms through 2 proxies, with traffic per token from the right exit IP only, never `direct`;
  - each proxy saw only its own username;
  - 4 separate jars;
  - WebRTC policy on every site window.
- **Fail closed:** a draft's raw request goes nowhere; with the proxy down, open windows send nothing and browsing is blocked; after a restart the proxy must pass again.
- **Credential handling:**
  - wrong credentials: bounded attempts;
  - credentials never offered to a site's 401;
  - keep/replace/remove credentials; `credentials_missing`;
  - backup endpoint;
  - field-level validation;
  - main-process requests can't authenticate to a proxy (S1).
- **Restart and session regressions:** C1 rotation, crash, rollback, tamper and protected-key suites, unchanged and passing.
- **Security:** bridge surface (13 frozen methods); IPC validation and sender checks; sandboxed windows; redaction; the security check reports a leaked proxy password as `<account> proxy-password x1`.

## 3. Screenshots (synthetic data)
`docs/gate-3/screenshots/`:
| File | Shows |
|---|---|
| `01-dashboard-empty.png` | First start |
| `02-add-account.png` | Name and mode |
| `03-proxy-test-failed.png` | Wrong password: failure and recovery action |
| `04-proxy-passed.png` | Proxy passed, observed IP |
| `05-session-imported.png` | TikTok imported and encrypted |
| `06-editor-complete.png` | Confirmed session; invalid and wrong-platform pastes explained |
| `07-dashboard-two-accounts.png` | Operational account and a draft |
| `08-after-restart.png` | Restored session after restart |
| `09-real-mode-new-account.png` | Clean real-mode launch |

All addresses shown are local test proxies and documentation-range IPs.

## 4. Security limitations
1. **Pasted JSON passes through the renderer once** (boundary B1). It isn't stored, but JavaScript strings can't be zeroed, and the OS clipboard keeps the copy until something else is copied. Clear it after pasting.
2. **Same-user access (R-19).** DPAPI protects against other Windows users and offline theft, not against malware running as you.
3. **Site storage at rest (R-26).** Chromium encrypts only cookies. Local Storage, IndexedDB and cache that sites write are plaintext on disk. Clearing the HTTP cache on exit (Q6) is **not yet implemented**; it's planned.
4. **Rollback residual (R-20).** Restoring all three copies of a session snapshot from one earlier moment isn't detected.
5. **Main-process proxy auth (R-27).** Automated probes can't use authenticated proxies (they fail closed). Real platforms use owner-confirmed status anyway.
6. **IP change vs imported cookies (R-28).** Cookies exported on your home IP and then used from the proxy IP may alarm a platform. Prefer **Log in here** through the account's proxy.
7. **Embedded browser (R-02).** Google, and possibly TikTok, may refuse logins or sessions in an embedded browser. Nothing in the app works around such checks.
8. **Not yet in this gate:**
   - authenticated SOCKS5 (Q1, deferred);
   - the Linux secret-storage adapter (design only);
   - the packaged build with production fuses (V-02);
   - account deletion (only Clear per session exists).
9. **Metadata linkage.** Proxy host, port and observed IP are stored in SQLite as non-secret. They're kept out of logs but link accounts if the database is read.

## 5. Remaining blockers
- **Gate 2 real-site items PENDING:** login persistence after restart and Profile B logged out need your direct observation (`docs/gate-2/GATE2_REPORT.md`).
- **Real proxy validation:** not done; your first manual setup (§6) is that test.
- **Platform domain lists (TikTok, Google Flow, Shopee, Kalodata) are provisional** until a real import's domain census confirms them. Out-of-scope cookies are reported as "belong to another website".
- **Kalodata authorization (R-03, R-03b, D14, D16):** research automation and AI use of its data stay blocked.

## 6. Your first manual proxy setup
Do this yourself on the laptop. Never paste credentials or cookies into Claude.
1. Start the app:
   `node C:\dev\UGC-studio-os\apps\desktop\scripts\run-app.mjs`
   Data goes to `C:\ugc-private\ugc-userData`. If you see "Not starting: …", follow the message.
2. Click **+ Add account** → enter a name → choose the mode → **Save draft**.
3. **Dedicated proxy:** choose HTTP or HTTPS as your provider specifies, enter host, port, username and password → **Save proxy** → **Test proxy**.
   - Check that the **observed public IP** is the proxy's IP and not your home IP.
   - If it fails, the message tells you what to fix. Nothing opens until it passes.
   - Test Proxy contacts `api.ipify.org`, or `checkip.amazonaws.com` as backup. Both see only the proxy's IP.
4. **Sessions:** for a platform card, either **Log in here** (recommended: the session is created on the proxy IP), or paste that platform's Cookie-Editor JSON → **Validate & encrypt**. The box clears immediately; copy something harmless afterwards to overwrite the clipboard.
5. **Open browser** → check by eye → **I'm logged in** or **I'm logged out**. Stop if a site asks for extra verification or shows a security warning.
6. **Save and close.** Close the app, reopen it, open the session again, and note whether you're still logged in. That also settles the pending Gate 2 item E4.
7. Afterwards, with the app closed, run the sanitized check and share only its output:
   `node C:\dev\UGC-studio-os\apps\desktop\scripts\security-check.mjs --user-data C:\ugc-private\ugc-userData --scan C:\ugc-private`

## 7. Git
Committed and pushed to `ccr-aecbb29a-dleiwi` after the pre-commit secret scan. The previous work (proxy PoC, Gate 3 plan, Gate 2 report) is preserved in `68941e9`.
