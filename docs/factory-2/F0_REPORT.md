# F0 Report: Flow Session Pool

**Date:** 2026-10-23 · **Status:** implemented and tested with synthetic data. Waiting for review.
**Plan:** `A1_REVISED_PLAN.md` §3 (approved, D27). Shared infrastructure for both factories.

## 1. The working interface

| Where | What it does |
|---|---|
| **+ Add account → mode "Flow pool (Google Flow credits only)"** | A Flow-only Google account: its own **dedicated proxy** (same fail-closed rules, Test Proxy) and **one Google Flow session** (Cookie-Editor JSON or log in). No TikTok, Kalodata or Shopee sessions. A pool account can't be switched to a factory mode or back (different sessions) |
| Dashboard → **Flow pool** (shown once a pool account exists) | Per pool account: **credits left** (and roughly how many videos), videos this period, editable **monthly credits / reset day / credits per video** (defaults 1,050 / 1 / 12 for Google AI Pro with 8-second Omni Flash clips), **Correct balance** (type what Google Flow shows), **Open Flow**, **Proxy & session**. Totals on top |
| Prompt Studio → queued prompt → **Generate in Flow pool** | Picks the pool account with a proxy, a Flow session and the most credits left (at least one video's worth), copies the prompt to the clipboard and opens **that account's Flow window** (its own proxy). The card says which pool account it went to. You generate and download there |
| The download | Linked to that prompt and saved in the **prompt's account library** (not the pool account's), and that pool account's credits go down by one video. "I'm generating it in Flow" (the account's own Flow session) still works as before |

Prompt Studio now refreshes itself while any prompt is waiting for its video, so a manual download shows up as "Video ready" without reopening the screen (this also fixes the same gap in T1's own-session flow).

**Credits are an estimate:** allowance minus the videos downloaded through the app since the reset day. Anything generated outside the app, or a different model/length, isn't counted, so correct the balance from Flow's own counter when it drifts. Flow itself is never read or automated.

## 2. Data (migration 7)

- `account_bundles` rebuilt to allow the third kind `flow_pool` (SQLite can't change a CHECK in place): run with foreign-key enforcement paused around one transaction, `foreign_key_check` before commit, enforcement back on. Tested on a pre-F0 database with existing accounts, sessions and products: all kept, references valid.
- `flow_pool_settings` (monthly credits, reset day, credits per video) and `flow_credit_events` (downloads, once per job, and owner corrections).
- `generation_jobs.flow_bundle_id` (which Flow session produced the video) and `prompt_items.flow_bundle_id` (which pool account a prompt was taken to).

## 3. Isolation

Each pool account has its own partition and proxy; prompts are only claimed by the Flow window of the pool account they were sent to (or, if not sent to the pool, by the account's own Flow window). The e2e test checks that the pool download went through the pool account's proxy exit IP.

## 4. Tests (synthetic only)

| Suite | Result |
|---|---|
| Typecheck | pass |
| Unit (vitest) | **338 passed** (20 files). New `apps/desktop/test/flow-pool.test.ts`: migration on an existing database, pool sessions, settings validation, credit period and reset, once-per-job deduction, own-session downloads not counted, corrections up and down, picking order and exhaustion, prompt hand-off and claim routing |
| E2E (Electron, fuse on) | **53 passed, 1 skipped** (opt-in native dialog). New `apps/desktop/e2e/flow-pool.spec.ts`: pool account sessions, mode change refused, defaults on the pool screen, Generate in Flow pool → pool Flow window, download → prompt's account library and Video ready, credits 1,050 → 1,038, correction to 1,000; `security.spec.ts` updated for 4 new bridge methods |
| Secret scan | No secrets found |

Screenshot: `screenshots/03-flow-pool.png`.

## 5. Demonstration

1. **+ Add account** → name, mode **Flow pool** → proxy → import that Google account's Flow cookies (or log in) → Test Proxy.
2. Dashboard → **Flow pool**: check monthly credits, reset day and credits per video.
3. Prompt Studio on a Ternak Akun account → queue a prompt → **Generate in Flow pool** → in the Flow window that opens, paste the prompt, generate, download → the prompt shows **Video ready** and the pool's credits drop.

## 6. Not in F0 / next

Not in F0: automatic Flow interaction (the supervised helper is a separate approval; Q1–Q4 open), choosing a specific pool account by hand in Prompt Studio (automatic choice only), moving an unclaimed pool download to another account (it stays in the pool account's library), Affiliate product videos (A2).
