# Gate 1 — Windows Validation and Hardening Report

**Date:** 2026-10-22
**Environment:** the owner's Windows laptop. Windows 11 Home Single Language, build 26300, x64. PowerShell 7.6.7, Node 24.18.0, pnpm 10.28.0 (Corepack), Git 2.54.0.
**Runtime under test:** Electron 44.9.3, Playwright 1.64.1, Vitest 5.0.5, TypeScript 6.0.2.
**Data:** synthetic only. No real cookie, site or account was used. Kalodata was not touched. Gate 2 has not started.

Status legend (spec §21): **implemented**, **tested**, **manually verified**, **untested**, **blocked**, **planned**.

## 1. Windows validation (accepted by the owner)

The first Windows run used the Gate 1 code unchanged:

| Check | Result |
|---|---|
| Environment | Project at `C:\dev\UGC-studio-os`, not under OneDrive; `%APPDATA%` not under OneDrive; 180 GB free; long paths on; LF in the working tree (`.gitattributes` overrides `core.autocrlf=true`) |
| `pnpm typecheck` / `pnpm test:unit` / `pnpm check:secrets` | pass / 85 passed / no findings |
| `pnpm test:e2e` (real Electron on Windows) | 18 passed |
| DPAPI probe (temporary, not kept) | `safeStorage` available and round-trips; `Local State` key is `DPAPI`-wrapped (32-byte AES key); cookie rows `v10`, empty plaintext column; the cookie decrypted through DPAPI as the current user equalled the imported synthetic token |

So on Windows the Chromium cookie encryption is real AES-GCM with a DPAPI-protected key, not the Linux fallback key (R-14 does not apply to Windows).

## 2. Hardening changes

| # | Item | Status | Where |
|---|---|---|---|
| 1 | **Electron binary installed by `pnpm install`.** Electron 44's npm package has no postinstall (it downloads lazily on the first `require('electron')`), so a fresh install left no binary. The root `postinstall` now runs Electron's own `install.js` (checksum-verified against the package's `checksums.json`), then checks that the binary and version match. It does nothing if the binary is already there, so it keeps a binary flipped by `enable-dev-fuses.mjs` | implemented, tested | `apps/desktop/scripts/install-electron.mjs`, root `package.json` |
| 2 | **Encryption tests independent of the dev fuse.** The harness builds two cached, version-named copies of Electron with `EnableCookieEncryption` explicitly on or off, and re-checks the fuse on every use. The "unfused" tests use the off copy | implemented, tested | `apps/desktop/e2e/harness.ts`, `security.spec.ts` |
| 3 | **Session-cookie restore prototype (R-10).** At import, the profile's cookies without expiry are sealed with `safeStorage` (DPAPI-backed on Windows) into `userData/session-restore/<profileId>.sealed`. At startup, before any window or IPC handler exists, they are decrypted, re-validated and set again in that profile's partition | implemented, tested | `apps/desktop/src/main/session-restore.ts`, `packages/core/src/session/restore-payload.ts` |
| 4 | Real Windows file dialog test: real button clicks plus UI Automation on the native Open dialog (no dialog stub) | implemented, tested (opt-in) | `apps/desktop/e2e/native-dialog.spec.ts`, `win-file-dialog.ps1` |

### 2.1 Restore design: what it reuses

- **Validation:** the sealed record stores cookies in Cookie-Editor JSON shape. A restore runs them through the same `importCookieEditorExport` as a fresh import (domain scope, prefixes, SameSite, flags), and also requires that every one is a session cookie and none is partitioned. Any invalid cookie rejects the whole record.
- **Binding:** the record carries the profile ID and partition and is refused (`binding_mismatch`) in any other profile, even though the same OS user can decrypt it.
- **Privileged boundary:** the main process alone seals and restores. Nothing new is exposed to the renderer or the bridge. The bridge returns only a non-secret summary `{state, count, error code, at}`.
- **Encryption gate:** sealing requires `safeStorage.isEncryptionAvailable()` and, on Linux, refuses the `basic_text`/`unknown` backends (R-14). Without protected storage nothing is written: the summary says `not_sealed / protected_storage_unavailable`, and the cookies are lost on restart, honestly reported as `expired`.
- **Failure:** decrypt, parse, binding, validation or browser errors restore nothing (cookies already set from that record are removed). The profile becomes `locked_unavailable / session_restore_failed` with a reason code (`decrypt_failed`, `binding_mismatch`, `invalid_cookies`, `record_missing`, …). OS error text is never logged. Other profiles are unaffected.
- **Status honesty:** a successful restore sets `imported_unverified / session_restored`. Only a status check against the site turns it into `appears_authenticated`.
- **Lifecycle:** a new import replaces the record, an import without session cookies removes it, and Clear removes it.

## 3. Tests run on Windows (final run)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | pass, 0 errors |
| Unit | `pnpm test:unit` | **94 passed** (5 files; +9 restore-payload tests) |
| Secret scan | `pnpm check:secrets` | no findings |
| E2E, dev binary fuse **ON** | `UGC_E2E_NATIVE_DIALOG=1 pnpm test:e2e` | **23 passed** |
| E2E, dev binary fuse **OFF** | same | **23 passed** |
| Fresh install | `pnpm install --frozen-lockfile` in a clean copy with an empty Electron cache | binary downloaded (151 MB zip), verified, `electron.exe --version` = v44.9.3 |
| Re-install keeps the dev fuse | `pnpm install` then `enable-dev-fuses.mjs --check` | `ON` |
| Mutation: binding check removed | isolation/swap test | failed as expected; passed after clean rebuild |
| Mutation: decrypt failure swallowed | decrypt-failure test | failed as expected; passed after clean rebuild |

Without `UGC_E2E_NATIVE_DIALOG=1` the native-dialog test is skipped (22 passed, 1 skipped).

New end-to-end tests (all with the cookie-encryption binary and no plaintext allowance):
- **Restart restore:** a session cookie is sealed (`v10` record), restored on two restarts in a row, accepted by the site, and shown in the UI. No file under userData contains the token or the canary.
- **Isolation:** two profiles' session cookies restore only into their own partitions. Swapped records are refused in both profiles.
- **Undecryptable records:** a tampered ciphertext gives `decrypt_failed` for that profile only (the other still restores and works, the UI still loads). Deleting `Local State` (key lost, as on another user or machine) gives `decrypt_failed` for all. The log has no canary and no OS error text.
- **No protected storage:** nothing is sealed, the restart honestly shows `expired`, and Clear or a re-import removes records.
- **R-10 characterization:** without the sealed record, Chromium still drops session cookies, and the profile shows `record_missing`.
- **Real file dialog:** Cancel changes nothing; picking the synthetic export imports it (`sealed`), status `appears_authenticated`, site window authenticated; after restart `restored` and authenticated; profile B is untouched throughout; Clear removes everything.

## 4. Remaining limitations

1. **Sealed at import only.** Session cookies that the site sets or rotates later, including those from an interactive login, are not captured. A rotated server session makes the record stale (the status check then shows `rejected`/`expired`).
2. **Not the Gate 3 vault.** It has one record per profile, no key rotation, no anti-rollback (an older record of the *same* profile copied back would restore), no migrations and no audit trail. The decrypted JSON is a JavaScript string and can't be zeroed.
3. **Lifetime extension.** Restoring a session cookie keeps a login that the site meant to end when the browser closes. Real platforms may reject it or bind it to a device or IP (R-05). Real-site behaviour is a Gate 2+ finding.
4. **Same-user access (R-19).** Any process running as the same Windows user can decrypt DPAPI data.
5. **Untested paths:**
   - "No protected storage" was simulated by stubbing `safeStorage` in the main process, not on a real machine without DPAPI.
   - The restore was not run on Linux or macOS in this pass.
   - The `unreadable` and `browser_rejected` branches have no dedicated test.
6. **A failed record is kept** until a re-import or Clear, so the profile shows `locked_unavailable` on every launch until then (deliberate, for diagnosis).
7. **Native-dialog test scope:**
   - It is opt-in: it needs an interactive desktop and takes focus.
   - It depends on the standard common-dialog control IDs (1148/1/2). On build 26300 those controls are exposed to UI Automation without patterns, so the helper uses `WM_SETTEXT`/`BM_CLICK`.
   - It drives the real dialog and buttons, but it is automation, not a person: **manually verified** remains none.
8. **pnpm on PATH.** The npm scripts call `pnpm`. `corepack enable` needs an admin shell on a default Node install; the alternative used here is a user-level shim directory (`corepack enable pnpm --install-directory %LOCALAPPDATA%\corepack-shims`, added to PATH).
9. **Test binaries.** Each Electron copy is about 370 MB, kept in `%TEMP%` (`ugc-electron-44.9.3-cookie-encryption-on|off`).
10. **Still open from Gate 1:** packaged build and production fuses (V-02, R-16), live Cookie-Editor export (V-03), partitioned cookies (R-11), non-cookie state (R-12).

## 5. Platform finding: Kalodata terms (R-03)

The owner reports that Kalodata's published Terms of Service, **section 4.1.8**, restrict automated scripts that collect information from or interact with the service. This is recorded as a **material integration risk** (R-03, now `blocking for automation`).

**Rule:** no Kalodata automation (scraping, scripted interaction or scheduled extraction) is built without written permission from Kalodata or an authorized alternative (for example an official API or data licence). Any Gate 2 scope that touches Kalodata needs the owner's explicit decision first.

## 6. Awaiting approval

Gate 2 is **not** started, and no real cookie was imported. Before authorizing it, the owner should decide:
- whether the restore prototype's limitations (§4) are acceptable for Gate 2;
- what the Gate 2 target is, given R-03;
- the open items D4, D6, D7, D8, D9, D12.
