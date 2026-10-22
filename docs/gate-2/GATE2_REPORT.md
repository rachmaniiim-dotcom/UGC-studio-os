# Gate 2 Report: manual Kalodata session validation

**Date:** 2026-10-22 · **Branch:** `ccr-aecbb29a-dleiwi` (test run at `238254b` plus the launcher)
**Scope (approved):** the owner imported their own Kalodata Cookie-Editor export locally and checked authentication by eye in the isolated embedded browser. No automation, no automated status checks, no Kalodata data used anywhere. Claude never read, opened or received the export, the cookies or the profile data. Only sanitized outputs (counts, codes, file locations, attribute flags) were exchanged.

## Pre-flight (verified)
| Check | Result |
|---|---|
| Repository | `ccr-aecbb29a-dleiwi` at `238254b`, clean, same as GitHub |
| Cookie-encryption fuse (development Electron) | ON |
| Windows protected storage | available (DPAPI) |
| Private folder `C:\ugc-private` | outside the repo, not synced by OneDrive |
| Launcher `run-gate2.mjs` | refuses an unfused binary and data folders inside the repo or OneDrive; clears synthetic/test switches; discards the app's console output. Tested |
| Encryption key of the test profile | on disk before the import (no `protected_key_not_ready`) |

## Results
Only results the owner observed directly on the real site are marked **CONFIRMED**. Anything else is **PENDING**, even when technical evidence points one way. Synthetic test results are never counted as real-site evidence.

| Evidence | Result | Source |
|---|---|---|
| E1/E2 import | **PENDING** (counts not recorded). Seen by the owner in the app, not transcribed. The later security check shows 61 cookies in A's jar (61 DB rows) | owner; security check |
| E3 authenticated in Profile A in the app | **CONFIRMED** by the owner: "logged in both in Chrome and app" | owner, directly observed |
| Profile B unauthenticated on the real site | **PENDING**: not personally confirmed. (Context only, not evidence: the security check found no cookie value shared between A and B, and B holds 33 cookies, consistent with anonymous visits) | owner to confirm |
| E4 Kalodata login persists after closing and reopening the app | **PENDING**: not personally confirmed. (Context only, not evidence: A's sealed session snapshot is valid) | owner to confirm |
| E7 encrypted at rest | All cookie rows encrypted: A 61/61 `v10`, B 33/33 `v10`, **0 plaintext** | security check |
| E8 no account harm | **CONFIRMED** by the owner: no warning, extra verification or rejection reported; the Chrome session still works ("logged in both") | owner, directly observed |
| Export file deleted | **Yes**, on the second check: the first check found it still in `C:\ugc-private` (20 matches) and the owner deleted it | security check |

## Security check findings (open)
- **No HttpOnly cookie value appears outside the encrypted cookie store.**
- **Script-readable** cookie values appear in plaintext in Chromium's site storage and cache for both profiles:
  - Local Storage logs;
  - the HTTP cache (`Cache_Data`);
  - Kalodata's IndexedDB;
  - one `TransportSecurity` file.

  The matching cookies are `kalodata.com` cookies (including one script-readable **session** cookie from the sealed snapshot) and analytics cookies (`hm.baidu.com`, `naver.com`).
- These copies are written by the site's own pages, the same as in Chrome; the app doesn't create them.
- Per the owner's Gate 3 requirement they are treated as **potential secondary exposure of sensitive data**, not declared harmless. Mitigations are in the Gate 3 plan: clear the HTTP cache on exit (Q6), recommend full-disk encryption, keep reporting them in `security-check`.

## Tooling changes made during Gate 2
- `security-check` now:
  - reports each match's non-secret cookie attributes (domain, HttpOnly, session/persistent), never names or values;
  - searches folders given twice only once;
  - reads the cookie DB before Chromium locks it.
- Window and page title: "Session Manager".

## Verdict
**Confirmed on the real site:** Cookie-Editor JSON → validated import → authenticated in the isolated browser (Profile A), with no account warning. Encryption at rest was measured by the sanitized check (all rows `v10`). **Pending real-site confirmation:** login persistence after restart (E4) and Profile B staying unauthenticated. They must be observed by the owner, for example during the first Gate 3 account setup, before they're marked confirmed. The Session Manager is ready to build the Gate 3 account interface on, under the Gate 3 plan's conditions (dedicated proxy, fail closed).

Kalodata research automation and AI use of Kalodata data remain blocked (D14, D16).
