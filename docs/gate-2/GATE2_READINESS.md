# Gate 2 Readiness Report (preparation only)

**Date:** 2026-10-22 · **Branch:** `ccr-aecbb29a-dleiwi` at `ceb64d6` (pushed; local = remote)
**Scope:** review and planning. No real cookie was imported, no Kalodata account was used, nothing was automated, and no code was changed. Gate 3 has not started.

> **Update (2026-10-22):** C1–C5 are implemented and tested on Windows. See [`PRE_GATE2_HARDENING_REPORT.md`](PRE_GATE2_HARDENING_REPORT.md). The procedure in §4 still needs the owner's authorization.

**Verdict (at the time of this report): not ready for real cookies yet.** Five small changes (§7, C1–C5) and two owner decisions (§8) come first. None of them needs the Gate 3 vault.

## 1. How the current restore handles rotated session cookies

The restore record is sealed **once, at import**. Cookies the site sets afterwards update only the browser's live jar. The problems:

| Site behaviour during a session | What happens at the next restart | Effect |
|---|---|---|
| Rotates a session cookie (new value) | The **old** value is restored | Server rejects it (status `rejected`). With refresh-token reuse detection, it may **revoke the whole login** or flag the account |
| Rotates a persistent cookie *and* a session cookie together | Persistent = new (Chromium saved it), session = old (record) | **Mixed generations**, e.g. a new session ID with an old CSRF cookie. Unpredictable server behaviour |
| Deletes a session cookie (logout, server-side expiry) | It is **resurrected** from the record | Zombie login state; the status would say `session_restored` for a session the site ended |
| Sets new session cookies (interactive login, step-up auth) | Not captured | Lost at restart |

Conclusion: safe for the synthetic site, which never rotates. **Not safe for a real platform.**

## 2. Proposed fix: seal the live jar, not the import

This is the smallest reliable method, about 80 lines in `session-restore.ts` plus tests:

1. **Snapshot, don't track.** Subscribe to `session.cookies.on('changed')` (Electron 44, confirmed in `electron.d.ts`) for each profile partition. Any change to an in-scope cookie schedules a **debounced (≈1 s) re-seal**. The re-seal reads the whole current jar (`cookies.get({})`), keeps the platform's in-scope, non-partitioned session cookies, and seals them as one record. A full snapshot can't drift from the jar the way per-event updates can.
2. **Removal is a state too.** If the snapshot has no session cookies, the record is deleted. Deleted or expired cookies are therefore never resurrected.
3. **Seal at shutdown.** The existing `before-quit` flush also runs a final re-seal, so the last rotation before exit is kept.
4. **Generation counter (anti-rollback).** Each record carries `generation = n`. The non-secret profile metadata stores the last generation written: the record is written first, then the metadata. Restore refuses any record older than the metadata (`stale_record`). This also closes R-20's rollback gap.
5. **No secrets on the event path.** The handler ignores `cookie.value` and logs only counts and causes. Re-seals are skipped when the content hash is unchanged (for example, the startup restore's own `set` calls).
6. **Crash window.** A crash within the debounce window can lose the last rotation. The next start then restores the previous generation. The site may reject it, and the status reports that honestly. This is accepted, and is what a normal browser does with session cookies anyway.

Tests to add (synthetic site, with new `/rotate` and `/logout` endpoints):
- rotation followed by a restart restores the new value;
- logout followed by a restart restores nothing;
- persistent and session cookies stay in the same generation;
- an older record copied back is refused;
- isolation and leak scans run with rotation active.

## 3. Kalodata terms: manual embedded browsing vs automation

I read the published terms myself: kalodata.com/terms-of-service, last updated **April 16, 2026**, Kalowave Technology Co., Limited. The relevant clauses, summarized:

| Clause | What it restricts | Effect on this project |
|---|---|---|
| **4.1.8** | Automated scripts that collect information from *or otherwise interact with* the Services; crawling and copying | Any app-initiated request to Kalodata counts, **including a status probe** like the synthetic `/whoami` check. Gate 2 status must be confirmed by the owner, not probed |
| **3.4**, 4.1.11, **14.7** | Account use limited to the registered user; no lending, sharing or multiple accounts to get around limits | Profile A must hold **only the owner's own account**. One Kalodata account per owner; no bundle sharing |
| **14.3(3)**, 14.4, 14.8 | Integrating data into internal systems, databases or dashboards requires an enterprise agreement (Charm Enterprise Package) | The future research module, as specified, needs that agreement |
| **14.5** | No systematic export into a persistent or reusable dataset | Same |
| **14.6** | No use of the data in AI/ML or LLM systems, *including via prompts or APIs*, without prior written consent | **Material product risk:** feeding Kalodata data to Claude, Gemini or Flow prompts breaches this without consent. Kalodata pages and data must also **not be pasted into Claude conversations** |
| 14.1 | Data limited to the package for the country of the business (Permitted Territory) | Indonesia package for Indonesian operations |
| 15.2 | Contact: customerservice@kalowave.com | Where to request written permission |

**My reading (not legal advice):**
- The owner browsing their own account by hand in the app's isolated window, after importing their own cookies, is ordinary use by the registered user, comparable to using a second browser. It is the only Gate 2 activity proposed.
- The app must not send any request to Kalodata on its own: no probe, no keep-alive, no page scripting, no extraction.
- Restoring cookies into the local jar is not an interaction with the Services.
- Anything beyond manual browsing needs either written permission from Kalowave or a Charm Enterprise agreement. That includes research automation and AI use of the data (D14, extended).

## 4. Authorized real-site validation procedure (owner-run)

**Preconditions:**
- C1–C5 are done and tested.
- The owner approves.
- `enable-dev-fuses.mjs --check` prints `ON`.
- A dedicated userData folder is used, separate from test runs.
- **Claude is not involved in steps 2–9.**

1. **Export.** In Chrome, on the owner's own logged-in Kalodata tab, use Cookie-Editor → Export → JSON. Save it to `C:\ugc-private\` (create this folder; it is outside the repo).
   - **Not** Desktop or Documents: on this laptop both sync to OneDrive. Downloads doesn't sync, but a dedicated folder is cleaner.
   - Cookie-Editor may go through the clipboard. Clipboard history and cloud sync are currently off on this laptop; keep them off.
2. **Import.** Start the app in the Kalodata configuration (C2) and import into Profile A with the file dialog.
3. **Delete the export** right away (Shift+Delete), and clear the clipboard.
4. **Observe manually.** Open Kalodata in Profile A; confirm logged-in by eye; browse 2–3 pages normally; mark the status `owner_confirmed` (C3). Then open Kalodata in Profile B and confirm it is logged out.
5. **Concurrency.** Stop using Kalodata in Chrome during the test, but don't log out there: logging out may end the same server session. Note whether Kalodata reports another device.
6. **Restart.** Restart the app and confirm Profile A is still logged in. Note whether its session cookies were restored or only its persistent cookies.
7. **Durability.** Repeat step 6 the next day, after Kalodata has had time to rotate cookies.
8. **Local audits.** Run the leak audit and the encryption audit (C4). Their output is counts only and may be shared with Claude.
9. **Finish.** Use Clear on Profile A. Record the evidence checklist (§5) in `docs/gate-2/`, as yes/no answers and counts only.

**Stop conditions** (stop, Clear the profile, and tell the owner): a Kalodata security warning, a forced logout, a CAPTCHA, an email about a new device, or any account notice. **Rollback:** Clear the profile. If anything looks wrong, log out of all Kalodata sessions in Chrome and change the password.

## 5. Evidence that would establish Gate 2

All of it is non-secret: yes/no answers, counts and codes. No screenshots of account data go into Git.

| # | Evidence | Shows |
|---|---|---|
| E1 | Import report: format `cookie-editor-json`, examined/imported/skipped/rejected counts, reason codes, and an in-scope domain census (domain names only) | Real export parses; scope is right |
| E2 | Browser-loaded count = imported count; session vs persistent count; no `rejected_by_browser` | Electron accepts real attributes |
| E3 | Owner confirms a logged-in UI in Profile A; Profile B is logged out at the same time | Import works; isolation holds on a real site |
| E4 | After restart: still logged in; restore state and count | Persistence |
| E5 | Next day: still logged in; number of rotation re-seals (count only) | Persistence survives rotation |
| E6 | Leak audit: 0 files under userData, logs or metadata contain any live cookie value | No plaintext leakage |
| E7 | Encryption audit: every Kalodata row has an empty `value` and a `v10` `encrypted_value`; sealed record is `v10` | Encrypted at rest |
| E8 | No security notice, forced logout or CAPTCHA; the Chrome session still works afterwards | No harm to the account |

## 6. Keeping real data out of Claude, the cloud, Git and logs

Confirmed from the current code and this laptop:

| Channel | Status | Control |
|---|---|---|
| **Claude conversations** | Anything Claude reads goes into the conversation (sent to Anthropic) | Rule: Claude never reads the export, the real userData folder, logs from the real profile, Kalodata pages or Kalodata data. The owner shares only E1–E8 summaries. The owner runs §4 steps 2–9 without Claude. (I read only Kalodata's *public* terms page, signed out.) |
| Cloud environments | Gate 2 is local only (D1) | No cloud session, no CI with real data |
| OneDrive | Desktop and Documents sync on this laptop | Export goes to `C:\ugc-private\`; repo and userData (`%APPDATA%\@ugc\desktop`) are not synced |
| Git | `.gitignore` covers exports, userData and vault; `pnpm check:secrets` passes | Add a pre-commit hook running `check:secrets` (C5) |
| App logs | Redacting logger; values never logged; Chromium error text dropped; no crash reporter, net-log, Chromium logging or console output in the app | Leak audit (C4) checks this against the real values |
| Renderer / bridge | Gets only non-secret summaries | Unchanged |
| Crash dumps | Windows Error Reporting local dumps are not configured | A crash dump could still contain memory. Accepted (local only) |

## 7. Changes required before real cookies (Gate 2, small)

| ID | Change |
|---|---|
| **C1** | Live-jar re-seal with generation anti-rollback (§2), with tests |
| **C2** | Per-platform configuration in place of the hard-coded synthetic one: cookie domains (Kalodata's login runs on `login.kalowave.com`, so `kalowave.com` is likely needed; confirm with the E1 census), start URL, allowed navigation hosts. Synthetic switches stay test-only |
| **C3** | Status method per platform. For Kalodata, **no app-initiated probe**: the owner marks `owner_confirmed` / `owner_reported_logged_out`. Statuses stay honest (`appears_authenticated` only from the owner's confirmation) |
| **C4** | Local audit command: the main process searches userData for the live jar's values and checks the cookie DB encryption, reporting **counts only**. Tested synthetically first |
| **C5** | Pre-commit hook running `pnpm check:secrets`; the importer report lists out-of-scope domain *names* (not cookie names or values) for the census |

## 8. Unresolved risks and decisions for the owner

- **R-03 (expanded):** 14.6 forbids AI/LLM use of Kalodata data without written consent; 14.3–14.5 require an enterprise agreement for system integration and persistent datasets. **This affects the core research→generation pipeline, not just automation.** Decision needed: write to Kalowave for permission, consider a Charm Enterprise Package, or pick another data source.
- **R-22 (new): concurrent sessions.** Using the same Kalodata session in Chrome and the app may be detected as account sharing (3.4) or a second device. Mitigation: §4 step 5; stop on any notice.
- **R-05:** a real session may be bound to device or IP. E4/E5 will show this for Kalodata on the same laptop only.
- **R-20:** closed by C1 apart from the crash window (§2.6). The other vault items remain Gate 3.
- **Before the full Session Manager (Gate 3):** the vault as source of truth (C1's records migrate into it), SQLite metadata, a per-platform status model, the account-bundle UI, the packaged build with production fuses (V-02, R-16), live Cookie-Editor format confirmation (V-03, satisfied by E1), and partitioned cookies (R-11) if Kalodata uses them (E1/E2 will show).

**Approval requested:** (a) implement C1–C5 on synthetic data only; (b) decide R-03 direction; (c) authorize the §4 procedure once C1–C5 pass.
