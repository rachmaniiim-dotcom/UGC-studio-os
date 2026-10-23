# A2 Real-World Validation: One Affiliate Video

**Date:** 2026-10-23 · **Commit:** `6f8a2d3` · **Profile:** `C:\ugc-private\ugc-userData`
**Rules:** no automatic credit spending, no Showcase additions, no publishing, no batches. Every Flow generation is started by you.

## Part 1: Safety checks before the test (done by Claude)

| Step | Result |
|---|---|
| App closed before the backup | Confirmed: no Electron process; no `ugc.db-wal`/`-shm` files |
| Fresh backup at version 7 | `C:\ugc-private\backups\ugc-v7-before-a2-20261023-143644.db`. SHA-256 identical to the live file (`848c3ea0…`); opens read-only; version 7; `integrity_check` ok; 0 foreign-key problems. Hash re-checked after the rehearsal: unchanged |
| Migration 8 rehearsal (scratch copy, app's own migrator) | Version 8; integrity ok; 0 foreign-key problems; **all 19 existing tables identical** to the backup (every row, original columns); new tables `affiliate_videos`, `affiliate_clips`, `production_events` |
| Normal start (`node apps/desktop/scripts/run-app.mjs`) | Live database at version **8**, integrity ok, 0 foreign-key problems. Log: `app_ready`, `ffmpeg_located`, no warnings or errors |
| Accounts, sessions, partitions | 1 account (Account Growth), 4 sessions: ids, account links and **browser partitions identical** to the backup; 4 partition folders present. 17 of 19 tables byte-identical; the 2 that changed are explained below |
| What changed on start (by design) | **Proxy:** test status reset to "untested" (status, observed IP, diagnostic endpoint cleared) so windows stay closed until **Test Proxy** passes in this run; protocol, host, port and the sealed credentials are unchanged. **Sessions:** TikTok, Google Flow and Kalodata **restored from their sealed snapshots** (all "restored", no errors); their status moves from "confirmed by you" to "restored, check needed" until you confirm them again. Shopee: never configured |
| Files | Sealed proxy secret (1), session snapshots (6), library video (1) all present |
| Production data | Nothing modified or deleted by Claude. Values were compared by hash and never printed |

**To roll back:** close the app and copy the v7 backup over `C:\ugc-private\ugc-userData\ugc.db` (works with commits up to `fa868c4`).

## Part 2: Blocker found before the real test

**No Flow account can be chosen in Affiliate Studio on this profile.** The studio's *Flow account* menu lists (a) Flow-pool accounts and (b) accounts' own Flow sessions **only once they have credit history or settings**. This profile has 0 pool accounts, 0 credit events and 0 Flow settings, and the Flow pool screen (where settings are made) only appears once a pool account exists. A new Affiliate account with its own Flow session would not be offered, and **Send to Flow** to the pool would fail with "no pool account available".

Ways around it:
- **A. Small fix (recommended):** list every account that has a Google Flow session in the menu and on the Flow pool screen, whether or not it has history. UI availability only; the credit model is untouched. Needs a rebuild and restart.
- **B. No code change:** create a Flow-pool account (its own proxy and a Google Flow session of a **different** Google account from the one already used).
- **C. Import only:** generate in any Flow window and use **Import clip file…**. This works, but the clip is **not linked to a Flow account and no credits are counted** (a gap in itself, see Part 3).

**Resolved (2026-10-23, fix A applied):**
- Every account whose Google Flow session is **configured** (imported, restored or confirmed, and not reported logged out or rejected) is now a Flow identity: offered in Affiliate Studio and listed on the Flow pool screen. It needs no credit history or saved settings.
- A new identity starts from **editable default settings** (badge "default settings: edit and save"), which you can save as they are or change.
- Flow-pool accounts stay selectable. The pool option is disabled when no pool account exists, and the studio then preselects the first own session.
- The Flow pool screen is reachable from the Dashboard whenever any account exists.
- Proxy test, partition isolation and Google's own login are still required to open the Flow window. A pool account without a configured session is listed but never picked.
- Credits are still charged to the Flow identity, never to the TikTok account.
- Regression tests: unit (new Flow session with zero history; pool accounts with and without a session) and e2e (own session offered next to the pool; default settings saved on the Flow pool screen).

## Part 3: Flow credit accounting (examined, not changed)

How it works now: `flow_credit_events` gets **one entry per finished download** (`reason = 'download'`, the account's *credits per clip*, default 12), charged to the Flow account whose window produced the file, plus your manual balance corrections (`'adjust'`). A2's `production_events` records attempts, failed generations, unusable outputs and approvals, **always with 0 credits**.

| # | Gap | Effect |
|---|---|---|
| 1 | **Failed attempts are not in the credit ledger.** "Generation failed" (refused, render error, no output) is a production event only. Whether Google charges for a failed or refused generation is unknown; the app assumes it doesn't | If Flow charges for failures, the estimate runs high until you correct the balance |
| 2 | **Only downloads cost credits.** A generation that finished in Flow but wasn't downloaded (a rejected take, or a second output of the same prompt) is never counted | Under-count; worst if Flow makes more than one output per prompt |
| 3 | **Attempts and credits are separate.** An attempt is counted at *Send to Flow*, a credit at download; nothing links "sent, never downloaded" to a credit cost | Can't see credits lost per failed attempt |
| 4 | **Imports with no hand-off** have no Flow account and 0 credits | Credits for those clips are invisible |
| 5 | **Re-downloading the same Flow video** creates a new job and charges again | Over-count |
| 6 | **No reservation for clips still in Flow.** The budget check looks only at downloads so far, so several clips sent to one account at once can pass a daily or monthly limit | Can overshoot a limit by the clips in flight |
| 7 | **One fixed cost per account** (`credits per clip`). A different model, length or upscale is not seen | Wrong estimate if settings change in Flow |
| 8 | **The daily figure counts downloads only**; a balance correction lowers the month but not the day | The daily limit ignores corrected usage |
| 9 | **A download is claimed by the oldest clip waiting** in that Flow window. If two clips are waiting and you download B first, it is filed as A | Wrong clip association (avoid by sending one clip at a time) |

The real test should tell us 1, 2 and 7: note Flow's own credit counter **before and after each generation**, including any failed one.

## Part 4: Guided real test (you act; Claude verifies read-only from the database)

Record *Worked? / Manual intervention / Notes* for each step.

| # | Step | What to do | Worked? | Manual intervention | Notes |
|---|---|---|---|---|---|
| 0 | Re-confirm sessions | Account Growth: **Test Proxy**, then check the restored sessions you'll use | | | |
| 1 | Affiliate account | **+ Add account**, mode *Affiliate UGC*, its own proxy → **Test Proxy**; TikTok session; a Google Flow session (own, or via a Flow-pool account per Part 2) | | | |
| 2 | Product | **Products → Add products**: one product ID. **Open product** → **This is the exact listing**; **Edit details**: title + at least one verified feature. Showcase not needed for the test | | | |
| 3 | Plan | **Create videos** → set *Plans per batch* to **1** in Settings → **Generate 1 plan** → read and edit Clip A/B → **Approve plan** | | | |
| 4 | Flow before | Note Flow's credit balance. In Flow, set outputs per prompt to **1** if offered; Omni Flash, 8 s, 9:16 | | | |
| 5 | Clip A | Choose the Flow account → **Send to Flow** (prompt copied, Flow opens) → paste, generate **yourself** → download in that window | | | |
| 6 | Clip B | Same. Seamless plan: **Export last frame** first and upload it in Flow yourself | | | |
| 7 | Flow after | Note Flow's balance after each clip and any failed generation | | | |
| 8 | Stitch | Automatic once both clips are in: status *Waiting for review*, ~16 s 1080×1920 | | | |
| 9 | Play | Play the final in the app | | | |
| 10 | Review | Product identical in both clips? Dialogue continuous? Joke lands? CTA clear? | | | |
| 11 | Decision | **Approve video**, or **Reject** with reason and clip to redo | | | |
| 12 | Library | **Video library**: product, Flow account, attempts, credits, final | | | |

## Part 5: Results

*(Filled in after the test.)*
