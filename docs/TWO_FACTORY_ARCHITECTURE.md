# Two-Factory Architecture

**Date:** 2026-10-22 · **Status:** approved (D23). T1 implemented (`docs/factory-1/T1_REPORT.md`).
**Model:** two **independent operating modes** on shared infrastructure. An account is created directly in either factory. Moving a Ternak Akun account to Affiliate Factory is an optional, owner-controlled reassignment.

## 1. Removed from the previous proposal

| Removed | Why |
|---|---|
| Seven-stage graduation state machine (milestone → notification → application → approval pending → permission confirmed → eligible → graduated) | Factories are not a sequential lifecycle |
| Milestone **L1 "Lifecycle foundation"** | Not built |
| `account_lifecycle` and `lifecycle_events` tables, backfill of affiliate accounts to a stage | No lifecycle history needed |
| `account_metric_snapshots` (follower snapshot infrastructure) | Deferred until a concrete feature (e.g. an authorized follower data source) needs it |
| Graduation board / Graduation tab | No mandatory graduation |
| Locking the editable production mode | Mode stays editable; that *is* the reassignment |
| Evidence-gated entry into Affiliate Factory | Existing affiliate accounts enter directly |
| Making the R3/R4 Creative Studio the default path for Growth accounts | Ternak Akun runs on templates; research/analysis is optional |

## 2. The two factories

| | **Factory 1: Ternak Akun** | **Factory 2: Affiliate UGC** |
|---|---|---|
| Account entry | Created with mode `account_growth` | Created with mode `affiliate_ugc`, directly; no history required |
| Sessions | TikTok, Google Flow | TikTok, Google Flow, Kalodata (when used), Shopee (optional) |
| Core workflow | Account → template → variables → 10 original prompts → produce in Flow → posting queue | Kalodata research (owner) → product → sales-driving references → exact listing → eligibility → Showcase → product-specific UGC → product link → scheduled shoppable post → verification |
| Intelligence | **Prompt-template engine** (default); Growth Intelligence outlier research (optional, advanced) | Affiliate intelligence: product identity, price, eligibility, commission, sales-driving creative patterns (separate scoring model) |
| Target | 10 videos/account/day | 12 videos/account/day: 4 batches × 3, ~08:00/12:00/18:00/21:00 WIB, 10–15 min spacing |
| Account signals | Follower progress where authorized data exists; owner-confirmed monetization/eligibility notes | Product associations, Showcase status, link verification |

**Optional reassignment (Ternak Akun → Affiliate):** the owner changes the mode in Edit Account after confirming eligibility themselves. Same account id, proxy, sessions, library, jobs, Growth data and notes; nothing is copied or duplicated. The Affiliate configuration becomes available. Never triggered automatically (no follower-count rule). Factory-specific data from the other mode stays as read-only history. Account sale/transfer is out of scope.

## 3. Reused as is (shared infrastructure)

- Account Bundles with **editable mode**, dedicated proxy (fail closed), DPAPI-sealed credentials, Test Proxy.
- Isolated platform sessions, Cookie-Editor import, session sync/restore, owner-confirmed status.
- Video generation port, job states, daily cap, challenge handling, synthetic provider.
- Per-account video library and the manual Google Flow download handler.
- Platform authorization constraints and `assertResearchUse`; redacting logger; secret scanning and git guards.
- Growth Intelligence (R1/R2) as an optional Ternak Akun tool.
- From the R3/R4 plan: the provider-neutral AI port with payload whitelist and guard, Flow prompt structure with verbatim consistency blocks, approval before spending credits, and traceability. These become shared pieces (template engine now, Affiliate Factory later).

## 4. Minimal new models

| Model | Milestone | Notes |
|---|---|---|
| Prompt template definitions (versioned) | **T1** | Built-in data, validated at startup; not a DB table yet |
| Per-account template configuration | **T1** | `template_configs` |
| Generated prompt batches and prompt items (the production queue) | **T1** | `prompt_batches`, `prompt_items`; queue = items with status `queued` |
| `generation_jobs.prompt_item_id` (nullable) | **T1** | Traceability prompt → video |
| Owner-confirmed eligibility/monetization notes | later | Small `account_notes` table when the UI needs it |
| Affiliate product associations, Showcase status, product link on videos | Affiliate milestones | Designed then; Showcase "added" shown only after platform confirmation |

## 5. Navigation

```
Overview │ Ternak Akun │ Affiliate Factory │ Accounts │ Video Library │ Settings
```

- **Overview:** account counts per factory; today's output vs target per factory; accounts needing attention (proxy, session).
- **Ternak Akun:** growth accounts with their template, queue size and today's x/10; per account → Prompt Studio (templates) and, optionally, Growth Intelligence.
- **Affiliate Factory:** affiliate accounts; batches and products once built (shown as not yet available until then).
- **Accounts:** today's account list and editor (proxy, sessions, mode), shared.
- **Video Library:** videos across accounts, filterable by account and factory, with trace links.
- **Settings:** targets, defaults.

No Graduation tab.

## 6. Next milestone

**T1: Prompt-template engine for Ternak Akun.** Plan: `docs/factory-1/PROMPT_TEMPLATE_ENGINE_PLAN.md`. Independent of Growth Intelligence.

Then, in order to be agreed: Affiliate Factory milestones (A1 product entries and identity, A2 Showcase assisted action after verification, A3 product-specific prompts), Video Library/Overview navigation, and publishing/scheduling only after authorization.

## 7. Authorization and technical blockers

| # | Blocker | Effect now |
|---|---|---|
| B1 | **TikTok ToS §5** bans automated collection; Research API is academic-only | No automated TikTok research; references are owner-supplied |
| B2 | **Reference and motion assets** (e.g. a dance video for motion transfer) are someone's copyright, and real people's likeness is involved | Templates accept only assets the owner confirms they own or have rights to |
| B3 | **Google Flow automation** not established (no API, reCAPTCHA, proxy sensitivity; R-32); motion-reference support in Flow not verified | Prompts are produced by the app; videos are made in Flow by the owner (manual download already lands in the library). Generate in-app only with the synthetic provider |
| B4 | **Publishing/scheduling**: Content Posting API needs an approved app and audit; yellow-basket product links on scheduled/API posts unproven (R-01); UI automation risks the terms (R-04) | "Posting queue" = prepared, approved items; no publishing |
| B5 | **Add to Showcase**: no verified authorized operation | Assisted action with accurate status, after a verification spike |
| B6 | **Kalodata** (R-03, R-03b): no automation, no persistent dataset or AI use of its data without agreement; a logged-in session is not permission | Owner browses manually; owner-entered product ids |
| B7 | **Follower/eligibility data**: no authorized source yet (Display API needs a developer app) | Owner-confirmed notes only |
| B8 | **Platform integrity**: realistic AI video must carry TikTok's AI-generated label; multi-account high-volume posting carries enforcement risk | Recorded for the publishing design |
| B9 | **Throughput**: single job per account, cap 3/day, laptop runtime, no scheduler | 10/12 per day are targets for prepared prompts, not automated production |
