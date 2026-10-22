# Pre-Gate-2 Hardening Report (C1–C5)

**Date:** 2026-10-22 · **Branch:** `ccr-aecbb29a-dleiwi`
**Environment:** Windows 11 Home Single Language build 26300, Node 24.18.0, pnpm 10.28.0, Electron 44.9.3, Playwright 1.64.1, Vitest 5.0.5.
**Data:** synthetic only. No real cookie was imported, Kalodata was never contacted, and nothing was automated against a real service. Gate 2 and Gate 3 have not started.

Approved in the owner's review of [`GATE2_READINESS.md`](GATE2_READINESS.md) (D15).

## 1. What changed

| Item | What it does now | Where |
|---|---|---|
| **C1 Session synchronization** | Watches each profile's jar (`cookies.on('changed')`). On any in-scope change (insert, rotation, overwrite, deletion), it re-seals the **whole current set** of session cookies after a short debounce (250 ms; 50 ms for deletions). Work is serialized per profile, and writes are atomic (temp file, fsync, rename). An empty set writes an "empty" revision and deletes the snapshot, so logout or Clear can't resurrect cookies. There is a final save on graceful quit. Each save bumps a **revision** stored three times: in the sealed snapshot, in a **separately sealed revision record** (`<id>.rev`), and in the profile metadata. Restore refuses anything older than the newest copy. Import and Clear run inside the sync queue. Sealing uses `safeStorage` (DPAPI-wrapped AES-GCM key on Windows) | `apps/desktop/src/main/session-sync.ts`, `packages/core/src/session/restore-payload.ts` (v2) |
| **C1 First-launch key guard** | Found during testing: on a brand-new profile, Chromium writes its encryption key to `Local State` only ~10.3 s after first launch (measured). A crash before then makes everything encrypted in that window unrecoverable, our snapshots and Chromium's own cookie DB alike. On Windows, imports are now refused with `protected_key_not_ready` until the key is on disk (always for real platforms; synthetic tests opt in) | `session-sync.ts` `osCryptKeyPersisted`, `ipc.ts` |
| **C2 Platform definitions** | `PlatformDefinition`: cookie domains (several allowed), navigation domains, pages, status-check method, authorization constraints and account boundary (one account per profile). Definitions are validated at startup, and the app refuses to start if one is invalid. They are reviewed source data, deliberately not a user-editable file. Built-ins: the synthetic site (probe or manual mode), and **Kalodata (provisional)** with `kalodata.com` + `kalowave.com`, manual status, `automation: not_permitted`, `aiDataUse: not_permitted`. Each profile records its platform; profiles of another platform are refused (`platform_not_active`). No platform-specific scraping or request code exists | `packages/core/src/platforms/definition.ts`, `apps/desktop/src/main/platforms.ts` |
| **C3 Authentication status** | New status `confirmed_by_user`, separate from `imported_unverified` and the probed `appears_authenticated`. `poc:confirm-status` records what the owner saw (`logged_in` / `logged_out`). For platforms without automation permission, `checkStatus` is refused (`automated_check_not_permitted`) and the probe code itself also refuses (two guards). The UI shows no "Check status" button there. A confirmation is withdrawn when the site deletes the session cookies (`expired / session_cookies_removed`) and after every restart (`imported_unverified / restarted_unverified` or `session_restored`) | `ipc.ts`, `status.ts`, `session-sync.ts`, renderer |
| **C4 Security check** | `pnpm security-check` starts the app in a read-only `--security-check` mode. It takes the live jar and snapshot values in memory, then searches userData and the `--scan` folders (raw and URL-encoded forms). It also counts plaintext rows in each cookie DB without selecting values, checks the fuse and protected storage, verifies each snapshot would restore, and flags the same secret in two profiles. It prints **only** check names, counts, profile labels and file paths, and writes nothing except a count-only log line. Needle buffers and pre-read DB bytes are zeroed afterwards. It refuses to run while the app has the same profile open (`app_running`) | `apps/desktop/src/main/security-check.ts`, `apps/desktop/scripts/security-check.mjs` |
| **C5 Git safeguards** | A pre-commit hook (`.githooks/pre-commit`, activated by `postinstall` via `core.hooksPath`) scans the **staged blobs**. This fixes a bug: `--staged` used to read the working tree. The hook blocks sensitive **paths** even if force-added: cookie exports, `.har`, `.env`, `*.sealed`/`*.rev`, `session-restore/`, `userData/`, `Partitions/`, `vault/`, `ugc-private/`, Chromium state files, profile metadata, app logs. `.gitignore` is extended to match. Found during testing: a bare `Cookies` ignore rule also hid the source folder `packages/core/src/cookies/` (git ignores case on Windows); it is now anchored, and a test guards it | `scripts/check-no-secrets.mjs`, `scripts/install-git-hooks.mjs`, `.gitignore` |
| **Kalodata constraints** | §4.1.8 and §14.3–14.6 are recorded as unresolved authorization constraints (R-03, R-03b, D16) in the Kalodata definition's `authorization.basis`. A research-provider boundary (`ResearchProvider` + `assertResearchUse`) throws unless a provider's recorded authorization allows `automated_retrieval` or `ai_processing`, so an authorized alternative can replace Kalodata behind the same interface. No provider is implemented | `packages/core/src/research/provider.ts` |

## 2. Test results (Windows, final run)

| Suite | Command | Result |
|---|---|---|
| Typecheck (source + tests) | `pnpm typecheck` | pass, 0 errors |
| Unit | `pnpm test:unit` | **172 passed**, 8 files |
| Secret scan | `pnpm check:secrets` | no findings |
| E2E, dev binary fuse **ON**, native dialog on | `UGC_E2E_NATIVE_DIALOG=1 pnpm test:e2e` | **34 passed** (2.7 min) |
| E2E, dev binary fuse **OFF** | same | **34 passed** |
| `pnpm install` keeps the fuse and hooks | `pnpm install --frozen-lockfile` | fuse `ON`; `core.hooksPath = .githooks` |
| Security check on the real (empty) app data folder + repo | `pnpm security-check` | PASS, 0 findings, 186 files scanned |
| Mutation: rollback floor removed | rollback test | failed as expected |
| Mutation: deletions not saved | logout/Clear crash test | failed as expected |
| Mutation: automation guard removed | no-automation status test | failed as expected |

After each mutation: clean rebuild (`tsc -b --force`), with the mutations confirmed gone.

New unit tests:
- snapshot v2 and revision record (binding to profile, partition and platform; versions; invalid revisions; whole-record rejection; no content in errors);
- platform validation (12 rejection cases, domain matching);
- research authorization;
- built-in platforms;
- the ignore rules (24 sensitive paths ignored, source not ignored);
- the path rules;
- the pre-commit hook in a real temporary git repository: it blocks a staged secret without printing it, checks the staged blob rather than the working tree, blocks force-added session data, and allows clean commits.

New end-to-end tests:

| Area | Test |
|---|---|
| Restart restoration | Restored on two successive restarts; `v10` files; no plaintext anywhere |
| Rotation | New generation (token + CSRF pair) saved as one snapshot and restored; the revoked old token proves it; the other profile is untouched |
| Crash | A saved rotation survives a process-tree kill. A crash 0/30/120/400 ms into a rotation restores **one consistent generation, never a mix** |
| Safe deletion | Logout (site deletes cookies) and Clear, then a crash: nothing restored; snapshot deleted, revision record kept |
| Rollback | Snapshot + revision record copied back: `stale_record`. All three copies rolled back: restored (the **documented residual**; the site rejects the old generation) |
| Failure | Tampered snapshot or revision record, either missing, records moved between profiles, `Local State` deleted: all fail closed with a reason code; the other profile still works; no OS error text in logs |
| No protected storage | Nothing written, nothing restorable; status honest |
| First-launch key | Import refused until the key is on disk; a crash before then fails closed |
| C2/C3 | Manual-status platform: automated check refused; **zero requests reached the site** across import, confirmation, restore and restart; confirmation withdrawn on cookie deletion and on restart. Kalodata definition (offline, no window, no network): own profiles, synthetic cookies rejected as out of scope, automated check refused |
| C4 | Clean encrypted profile: PASS and no new plaintext copies. Planted leaks (URL-encoded copy in userData, a forgotten export in a scan folder), plaintext DB rows and one account in two profiles: all reported by location and count; the output contains no value and no cookie name. Refuses to run while the app is open |
| Regression | Import, isolation (jar, server view, localStorage), persistence, fuse guard, plaintext-without-fuse characterization, encrypted DB, IPC/bridge/CSP/sandbox, redaction, real file dialog |

## 3. Remaining risks and limitations

1. **Rollback (residual, R-20).** Someone with this Windows user's access can restore all three copies (snapshot, revision record, profile metadata) from the same earlier moment, and it won't be detected. There is no hardware-backed monotonic counter: TPM wasn't detected on this laptop. All three files are sealed with the same DPAPI-wrapped key. Impact is limited: a rolled-back generation is usually already revoked by the site.
2. **Crash window.** A rotation within the last ≤250 ms before a crash may be lost; the previous complete generation is restored, and the site's answer shows whether it still works. The first-launch key window is closed by the import guard. A crash during that window only on a profile that has imported nothing is harmless.
3. **Only platform session cookies are kept.** Session cookies outside the platform's cookie domains are not saved. Partitioned (CHIPS) cookies can't be loaded by Electron 44 (R-11). Non-cookie state (localStorage etc.) is Chromium's to persist (R-12).
4. **Security check limits.** It skips values under 8 bytes, searches only raw and URL-encoded forms, doesn't search compressed files (git history) or files over 256 MB, and counts locked files as "unreadable". Values held as JavaScript strings can't be zeroed. It only searches folders it's given.
5. **Git safeguards.** `git commit --no-verify` bypasses the hook, and the hook can't protect history that's already pushed. There is no server-side or CI scan yet.
6. **Kalodata definition is provisional.** Its domain list must be confirmed by the Gate 2 import's domain census (E1) before it's relied on. Popups are denied, which may affect Kalodata's own login flow (only relevant if the owner logs in interactively).
7. **Kalodata authorization (R-03, R-03b, D16): unresolved.** §4.1.8 rules out any app-initiated interaction; §14.3–14.6 rule out system integration, persistent datasets and AI use of the data without permission. The research→AI pipeline as specified can't use Kalodata data until written permission or an enterprise agreement exists.
8. Carried over: packaged build and production fuses untested (V-02, R-16); same-user malware (R-19); device/IP binding (R-05); concurrent-session detection (R-22).

## 4. Gate 2 readiness

The engineering preconditions from the readiness report (C1–C5) are **done and tested on Windows with synthetic data**. Before the §4 procedure in `GATE2_READINESS.md` can run, it needs:
- the owner's authorization to import their own Kalodata cookies and browse **manually** (no automation; status by owner confirmation only);
- the owner's decision on R-03/R-03b for anything beyond manual browsing.

The owner runs the procedure without Claude; only the E1–E8 counts are shared back. **Stopped here: no real cookies imported, Gate 3 not started.**
