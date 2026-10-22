# Gate 1 Report — Synthetic Session Proof of Concept

**Date:** 2026-10-22
**Environment:** Linux cloud container (Ubuntu 24.04, Node 22.22.0, pnpm 10.28.0). **Not Windows.**
**Runtime under test:** Electron 44.9.3 (Chromium 152.0.7977.167, Node 24.22.0), Playwright 1.64.1, Vitest 5.0.5, TypeScript 6.0.2.
**Data:** synthetic only. No real site, account or cookie was used.

> **Update (2026-10-22):** Windows validation and the Gate 1 hardening pass are in [`WINDOWS_HARDENING_REPORT.md`](WINDOWS_HARDENING_REPORT.md). It supersedes §6 below and changes R-10 (session cookies are now restored by a DPAPI-sealed prototype).

Status legend (spec §21): **implemented**, **tested**, **manually verified**, **untested**, **blocked**, **planned**.

---

## 1. What was built

| Item | Status | Where |
|---|---|---|
| Cookie-Editor JSON detection, validation, normalization | implemented, tested | `packages/core/src/cookies/` |
| Duplicate policy: identical copies collapse; **conflicting copies are all rejected** with a non-sensitive diagnostic (D5) | implemented, tested | `packages/core/src/cookies/import.ts` |
| Non-secret import report (counts, positions, reason codes; no names or values) | implemented, tested | same |
| `SecretValue` wrapper, text/object redaction, redacting logger | implemented, tested | `packages/core/src/redaction/` |
| Normalized → Electron cookie adapter (host-only vs domain, SameSite, session, refuses partitioned) | implemented, tested | `apps/desktop/src/main/electron-cookies.ts` |
| Minimal Electron app: main/preload/renderer split, `app://` protocol + CSP, frozen 5-method bridge, allowlisted IPC with sender and payload checks | implemented, tested | `apps/desktop/src/` |
| One isolated `persist:ps_<uuid>` partition per profile; hardened sessions (no permissions, no downloads, test-only cert trust) | implemented, tested | `apps/desktop/src/main/sessions.ts` |
| Sandboxed third-party windows (no preload, popups denied, off-domain navigation blocked) | implemented, tested | `apps/desktop/src/main/windows.ts` |
| Cookie-encryption guard: import refused unless the `EnableCookieEncryption` fuse is on (explicit synthetic-only override) | implemented, tested | `apps/desktop/src/main/fuses.ts`, `ipc.ts` |
| Production fuse set (for future packaging) | implemented, **untested** | `apps/desktop/scripts/fuse-config.mjs` |
| Local HTTPS synthetic site (`*.ugc-poc.test`), synthetic fixtures with canary marker | implemented | `packages/test-fixtures/` |
| Repository secret scan | implemented, tested | `scripts/check-no-secrets.mjs` |
| Manual demo launcher | implemented, smoke-tested (launch only) | `apps/desktop/scripts/run-poc.mjs` |
| Dev fuse switch for local real-cookie work | implemented, `--check` run only | `apps/desktop/scripts/enable-dev-fuses.mjs` |

Deliberately **not** built (out of Gate 1 scope): account-bundle UI, SQLite schema/migrations (a small JSON metadata file stands in), the final vault (`packages/vault` deferred), any real-site code, Kalodata, Flow, TikTok, Showcase, scheduling, n8n, VPS.

## 2. Tests actually run

All commands were run in this container on 2026-10-22; results are from the final run.

| Suite | Command | Result |
|---|---|---|
| Typecheck (source + tests) | `pnpm typecheck` | pass, 0 errors |
| Unit (Vitest) | `pnpm test:unit` | **85 passed**, 0 failed (4 files) |
| End-to-end (Playwright + real Electron, sandbox on, Xvfb) | `scripts/e2e-container.sh` | **18 passed**, 0 failed |
| Repository secret scan | `pnpm check:secrets` | no findings |
| Mutation check: forced both profiles onto one partition | isolation spec against a sabotaged build | **3 of 3 failed as expected**; passed again after a clean rebuild |

### 2.1 Unit-tested (85)
- Format detection: Chrome JSON accepted; Netscape, header-string, non-cookie JSON, wrapped JSON, Firefox variant and unknown text rejected as `unsupported_format`; invalid JSON, empty file, oversize, too many cookies, non-UTF-8 and BOM handling.
- Normalization: host-only vs domain cookies, leading-dot stripping, lower-casing, SameSite mapping (including Cookie-Editor's `null` for unspecified), session semantics, partition key preserved, unknown fields counted and dropped, `__proto__` safety.
- 28 per-cookie rejection cases (missing attributes, bad names/values, size, flags, domains, out-of-scope domains including look-alikes and parent domains, host-only inconsistency, path, SameSite, expiry, session/expiry conflict, `SameSite=None` without `Secure`, `__Secure-`/`__Host-` prefixes, partition keys), plus expired-skipped and clock handling.
- Duplicates: exact collapse; conflicting group fully rejected with diagnostic; attribute-only conflicts; host-only vs domain treated as distinct; expired copy ignored.
- Secrecy: no canary in report, serialized cookies, `inspect` output or `String()`; no cookie names in the report.
- Redaction: headers, Bearer, JWT, query strings, JSON `value`, key=value secrets, long opaque strings; UUIDs left readable; deep objects, errors, cycles; logger output.
- Electron adapter mapping (5 cases); secret scanner rules and a clean repository scan.

### 2.2 Integration-tested in real Electron on Linux (18)
- **Import:** valid export → `imported_unverified` → `appears_authenticated`; the site page shows "Authenticated as user-a".
- **Fail-safe:** an invalid JSON file and a Netscape file after a good import leave the partition's cookies and status untouched.
- **Attribute fidelity:** host-only and domain cookies, `Secure`, `HttpOnly`, SameSite `lax`/`strict`/`no_restriction`/`unspecified` and session cookies all read back from Electron exactly as imported; out-of-scope, expired, conflicting-duplicate and partitioned entries are kept out and reported.
- **Status honesty:** revoked server-side token → `rejected`; cleared profile → `never_configured`, empty jar.
- **Isolation:** partitions are UUID-based, label-independent, never reused; two profiles on the same site each hold only their own token, and the server receives only that profile's token from that profile's window; clearing one leaves the other intact; localStorage is isolated too.
- **Restart persistence:** persistent cookies and profile metadata (IDs, partitions, last import) survive restart and are still accepted by the site.
- **Session cookies:** lost on restart → status `expired` / `no_session_cookie` (finding R-10).
- **Non-cookie state:** a cookie-only import fails on a page that also needs a localStorage device token; an interactive login inside the isolated partition works and persists across restart.
- **Security:** app UI has no `require`/`process`/`ipcRenderer`, a frozen 5-method bridge, and CSP blocks an injected inline script; IPC rejects malformed IDs, unknown profiles, object payloads, path-traversal and prototype-key page names; a forged IPC call from a third-party window is refused as `untrusted_sender`; third-party windows are sandboxed, have no bridge, cannot open popups, cannot navigate off-domain, and get `denied` for permissions; no canary in logs, profile metadata or any bridge response (with a check that logging actually happened); the guard refuses imports on an unfused binary.
- **Cookie database:** without the fuse the value is stored in plaintext in `Cookies` (characterization of the risk); with the fuse on, the `value` column is empty, `encrypted_value` is populated (`v10`), no file under userData contains the token, and the session still works after restart.

### 2.3 Manually verified
**None.** No human has looked at the running app. On Windows, nothing has been run (blocked, D1).

### 2.4 Untested
- Anything on Windows (launch, DPAPI, Windows encryption of the cookie DB, paths, file dialog).
- Packaged build and the full production fuse set (no packaging tool yet).
- The real native file dialog (tests replace `dialog.showOpenDialog`; the main process still reads the file itself).
- Real Cookie-Editor exports from a live browser; any real website.
- The renderer UI's buttons by click (tests call the same bridge the buttons call).

## 3. Assumptions validated or invalidated

| Assumption (Gate 0) | Result |
|---|---|
| Cookie-Editor JSON = `chrome.cookies.Cookie` objects | **Validated against source code** (Cookie-Editor 1.13.0, `interface/lib/jsonFormat.js`): it exports the browser's cookie objects, sets `storeId` to `null` and writes `sameSite: "unspecified"` as `null`. Not yet observed in a live export |
| Netscape/header-string formats lose attributes | **Validated from source**: Netscape drops SameSite and turns session cookies into 1-day cookies; header string keeps only name=value |
| Electron `persist:` partitions isolate profiles | **Validated** (cookies, localStorage, server-side view) |
| Persistent cookies survive restart | **Validated** |
| Session cookies survive restart | **Invalidated**: they are dropped (R-10) |
| Electron can load partitioned (CHIPS) cookies | **Invalidated** for 44.9.3: the API has no partition key (R-11) |
| Without the fuse, the cookie DB is plaintext | **Validated** (R-13) |
| The fuse encrypts the cookie DB | **Validated on Linux**, but only with Chromium's fallback key there (R-14); Windows unverified |
| Linux `safeStorage` without a keyring is unsafe | **Validated**: `isEncryptionAvailable: false`, backend `basic_text` |
| Electron sandbox works in the container | **Validated as a non-root user**; refused as root (R-15) |

## 4. Electron ↔ Playwright implications

- The normalized cookie model carried everything Electron needed. Playwright's `addCookies` will need the one documented loss: SameSite `unspecified` → explicit `Lax`.
- Session cookies vanish on restart in Electron, and a Playwright worker using ephemeral contexts has no restart at all. **Both point to the same design: the vault, not the browser profile, is the source of truth**, and sessions are re-loaded from it.
- Partitioned cookies: Playwright supports a partition key, Electron 44 does not. Keep `partitionKey` in the normalized model.
- Non-cookie state (localStorage etc.) is not carried by Cookie-Editor exports. If a real platform needs it, interactive login in the isolated browser is the working path, and moving that state to a worker needs a separate, documented export (e.g. Playwright `storageState.origins`).
- Testing packaged builds with Playwright conflicts with the production fuses (R-16).

## 5. Security findings

1. **Plaintext cookie DB without the fuse** (R-13). Now guarded in code: the app refuses imports on an unfused binary. Before any Gate 2 real-cookie run, `node apps/desktop/scripts/enable-dev-fuses.mjs` must be run and `--check` must print `ON`.
2. **Linux encryption is obfuscation** (R-14). The future Linux worker needs its own key management.
3. The renderer never receives cookie JSON or values; this is shown by the canary scan of every bridge response.
4. Synthetic-mode switches (host mapping, certificate trust, plaintext override) are read from the environment only when `app.isPackaged` is false.
5. The secret scanner caught two fixed synthetic strings in a test file during development; the test now builds them at runtime.

## 6. Windows validation still required

Run on the owner's laptop when available (nothing below has been done):

1. Environment inspection script from Gate 0 report §1.2.
2. `pnpm install`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:e2e` (directly, no container script).
3. `node apps/desktop/scripts/run-poc.mjs`: click through import (real file dialog), status, open site, restart, profile B.
4. `node apps/desktop/scripts/enable-dev-fuses.mjs`, then re-run the e2e suite and confirm the encrypted-DB test on Windows. Confirm `safeStorage.isEncryptionAvailable()` is true (DPAPI).
5. Check that the userData folder is not under OneDrive.

## 7. Decisions needed before Gate 2

- **R-10:** accept that Gate 2 restart results for session-cookie logins will reflect the browser alone (no vault reload yet), or ask for vault-backed re-loading earlier.
- **Gate 2 storage:** the spec asks for "minimum practical protected storage" for the real Kalodata export. Proposal: fuse-enabled cookie DB only (Chromium + DPAPI on Windows), file read once by the main process, buffer zeroed, owner deletes the export file afterwards. No vault yet.
- **Gate 2 location:** must run on Windows locally (D1); it cannot run in this container.
- Still open from Gate 0: D4, D6, D7, D8, D9, D12.
