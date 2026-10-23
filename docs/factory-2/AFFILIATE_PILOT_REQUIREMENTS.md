# Affiliate Factory Pilot: Business Requirements (recorded, not implemented)

**Date:** 2026-10-23 · **Status:** requirement update from the owner, recorded for planning. **Nothing here is implemented yet**, and no publishing or new scheduling automation is to be built until approved.

## The pilot

| Item | Pilot value | Must be configurable |
|---|---|---|
| Affiliate accounts | **5**, one per category | Yes: the pilot is not a system limit |
| Categories | Beauty, Homecare, Electronics, Fashion, Pets | Yes (names and assignment per account) |
| Winning products per account per day | **1**, from the account's category | Yes |
| Approved finished videos per account per day | **10** | Yes |
| Video format | 2 coordinated 8-second Flow clips → ~16 s (A2) | — |
| Posting windows (WIB, UTC+7) | 5 posts 08:00–10:00, 5 posts 20:00–22:00 | Yes |
| Flow capacity | The **shared Flow pool**; not three Flow accounts per TikTok account | — |

## What the app already covers

- **Any number of accounts**; Affiliate accounts are independent of Ternak Akun accounts.
- **Products per day**: the Today's-selection limit is per account and editable (default 3, range 1–20); the pilot sets it to 1.
- **Videos per product per day**: editable in Affiliate Studio (default 10). The per-account target (`production_targets.daily_videos`, default 10) exists from T2, but the Affiliate screens don't show progress against it yet.
- **Shared Flow pool and per-identity credits**: any Flow-pool account or configured own Flow session can render for any affiliate account; credits are charged to the Flow identity (A2 and the 2026-10-23 fix).

## Gaps against the pilot (for A3 planning)

1. **No category field** on accounts or products, and no check that a product matches the account's category.
2. **No per-account daily video progress** in Affiliate screens (10 approved per account per day), and no five-account overview.
3. **No posting-window plan**: the 08:00–10:00 / 20:00–22:00 WIB slots aren't modelled. Posting stays manual; showing which approved video goes to which slot needs no automation.
4. **Batch hand-off**: today each clip is sent to Flow by hand, one at a time. 5 × 10 × 2 = **100 clip generations a day** at a 100% success rate.
5. **Pool capacity**: 100 clips × 12 credits = **1,200 credits a day**, about **36,000 a month**. One Google AI Pro account gives 1,050 a month (~35 a day, under 3 clips), so the pilot needs **about 35 Pro accounts at zero failures**. At 1.5 attempts per clip it is about 52. The pool screen should show pool-wide daily capacity against the target.
6. **Credit accounting gaps** (`CREDIT_ACCOUNTING_GAPS.md`) matter at this volume, especially failed generations, extra outputs and in-flight reservations.
7. **Unknown Flow limits per Google account** beyond credits (rate or daily caps) aren't known yet; the real test and a small ramp should measure them.
