# Flow Credit Accounting: Known Gaps (for a future milestone)

**Date:** 2026-10-23 · **Status:** recorded only. The accounting model is **not** changed; the Flow-identity fix of the same date only changed which accounts can be chosen.

## How it works today

- A **Flow identity** is a Flow-pool account, or any account whose own Google Flow session is configured (imported, restored or confirmed, and not reported logged out or rejected). It needs no credit history or saved settings; until settings are saved it uses the editable defaults (1,050 per month, reset day 1, 12 per clip, no daily limit).
- `flow_credit_events` gets **one entry per finished download** (`'download'`, that identity's *credits per clip*), charged to the Flow identity whose window produced the file, never to the destination TikTok account, plus the owner's balance corrections (`'adjust'`).
- A2's `production_events` records attempts (at *Send to Flow* or import), failed generations, unusable outputs, approved clips, failed joins and final decisions, **always with 0 credits**.
- Hand-off checks: attempts per clip, videos per product per day, and the Flow identity's monthly balance and optional daily limit (`canSpend`).

## Gaps

| # | Gap | Effect | Likely direction (to decide later) |
|---|---|---|---|
| 1 | **Failed generations aren't in the credit ledger** (refused, render error, no output) | If Google charges for some failures, the estimate runs high until corrected | Measure in the real test; if charged, record a credit event per failure type |
| 2 | **Only downloads cost credits**; generations finished but not downloaded (rejected takes, extra outputs per prompt) aren't counted | Under-count, worst with several outputs per prompt | Record outputs per prompt at hand-off, or count per attempt instead of per download |
| 3 | **Attempts and credits aren't linked**: no credit cost for "sent, never downloaded" | Can't see credits lost to failed attempts | Charge or reserve at hand-off, settle on download |
| 4 | **Imports with no hand-off** have no Flow identity and 0 credits | Credits invisible | Ask which Flow identity rendered an imported clip |
| 5 | **Re-downloading** the same Flow output creates a new job and charges again | Over-count | Detect duplicates by file hash per clip |
| 6 | **No reservation** for clips still in Flow; budget checks see only downloads so far | Can exceed a daily or monthly limit by the clips in flight | Reserve one clip's credits per open hand-off |
| 7 | **One fixed cost per identity** (`credits per clip`); model, length or upscale changes aren't seen | Wrong estimate after a Flow settings change | Record model and length per hand-off |
| 8 | **The daily figure counts downloads only**; corrections lower the month but not the day | Daily limit ignores corrected usage | Date-stamp corrections into the daily figure |
| 9 | **The oldest waiting clip claims a download** in that Flow window | With two clips waiting, B downloaded first is filed as A | One open hand-off per Flow window, or the owner picks the clip on arrival |
| 10 | **Google's real counter isn't read** (by design: Flow isn't automated) | All figures are estimates | Keep owner corrections; make drift visible per identity |

The real Affiliate Studio test should settle 1, 2 and 7: note Flow's own balance before and after every generation, including failures.
