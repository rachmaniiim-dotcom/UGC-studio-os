# Gate 5 R1/R2 Report: Growth Intelligence

**Date:** 2026-10-22 · **Status:** implemented and tested with synthetic data. **Waiting for approval before R3/R4.**
**Design:** `GROWTH_RESEARCH_ENGINE_DESIGN.md` (approved with the Q1–Q5 modifications in `docs/DECISIONS.md` D21).

## 1. What was built

One screen, **Growth Intelligence**, opened from the **Growth Intelligence** button on any Account Growth row of the dashboard. Affiliate accounts don't get it.

| Area | What it does |
|---|---|
| Account strategy (R1) | Per-account niche, sub-niches, target audience, region, language, desired followers, follow reasons, style constraints, daily concept/video targets. Saved per account; every field validated with a field-level message |
| Research thresholds (R1) | Editable per account. Defaults: **3× outlier threshold, 30-day window, 8-video recommended baseline**, 5-video minimum, 3-day settle age, 10,000 minimum views, metrics stale after 7 days. Saving re-scores everything immediately |
| Reference creators | Add by `@handle` or profile link, with a note; shows how many reference videos each has; remove |
| Reference video entry | Full video link + the numbers the owner sees. Accepts `125000`, `125,000`, `125.000` (exact) and `1.2M`, `3,4 jt`, `1,2 rb`, `52K` (stored as **rounded**, never as exact). Short links (`vm.tiktok.com`, `/t/…`) are refused because resolving them would be automated access. Empty metric = missing, never guessed |
| CSV import | Paste or pick a file (main process reads it, 2 MB cap). Header row, any order, only `url` required; comma or semicolon; up to 2000 rows. Per-row result: added / updated / rejected with the reason. Re-importing updates by video id and **keeps the owner's relevance, note and pin** when the row leaves them blank |
| Outlier scoring (R2) | Deterministic. Candidate views ÷ **median views of the same creator's other videos** that have views, are inside the window and are at least the settle age. Verdicts: **Outlier**, **Not an outlier** (with the failed gate), **Unverified** (baseline under the minimum: no ratio is computed, qualitative analysis still allowed by pinning), **Missing metrics** |
| Confidence | High only with a recommended-size baseline and no data problems; medium with one problem; low otherwise (minimum-size baseline, rounded numbers, stale metrics, incomplete engagement) |
| Data-quality flags | no views · engagement incomplete · no date · rounded numbers · stale metrics · inconsistent (e.g. more likes than views) · too recent · outside window · baseline rounded |
| Explanation | One sentence per reference built only from the numbers and codes, e.g. *"150k views vs this creator's median of 20k across 10 comparable videos in the last 30 days → 7.4×, above your 3× threshold; posted 6 days ago. Confidence: high."* |
| Shortlist | Outliers (highest ratio first), then pinned references. "Not relevant" removes a reference from the shortlist even if it is an outlier |
| Editing | Per row: relevance, pin/unpin, edit metrics (records a new observation date), remove |

Nothing on this screen contacts TikTok. There is no FYP scraping, Flow automation, publishing or AI concept generation in this milestone.

## 2. Provider-neutral retrieval (Q1, Q5)

`ResearchProvider.search()` returns rows in the same shape as a manual/CSV entry, and `GrowthService.importFromProvider()` runs them through the same validation. It refuses any source whose recorded authorization doesn't permit automated retrieval (`source_not_authorized`, tested both ways). No real provider is registered: a licensed source can be added once its automated access, storage and AI-analysis rights are confirmed.

## 3. Data model (proportional: 3 tables, migration 3)

| Table | Holds |
|---|---|
| `growth_strategies` | One row per account: the validated strategy + thresholds as JSON |
| `reference_creators` | Handle + note per account (unique per account) |
| `reference_videos` | URL, video id, creator, date, duration, metrics JSON (each metric `{value, exactness}` or null, plus `observedAt`), relevance, pin, note, source; unique per account + video id |

Baselines and assessments are **computed on read** (pure function), so there is nothing to keep in sync. The design's metric-history, run and assessment tables are deferred until a feature needs them (R5 learning loop).

## 4. Tests (all synthetic)

| Suite | Result |
|---|---|
| Typecheck (all workspaces + tests) | pass |
| Unit (vitest) | **267 passed** (15 files). New: `packages/core/test/research.test.ts` (strategy validation, URL/metric/CSV parsing, scoring: baselines, unverified, missing metrics, every gate, confidence, explanations, editable thresholds, determinism); `apps/desktop/test/growth.test.ts` (SQLite service: synthetic CSV scenarios, upsert/re-import, owner input preserved, edits, strategy re-scoring, creators, non-growth refusal, provider authorization refusal/permission, no research data in logs) |
| E2E (Playwright + Electron, cookie-encryption fuse on) | **49 passed, 1 skipped** (the opt-in native-dialog test). New: `apps/desktop/e2e/growth.spec.ts` drives the whole screen; `security.spec.ts` updated for the 9 new bridge methods |
| Secret scan | No secrets found |

The synthetic dataset (`packages/test-fixtures/src/research.ts`) uses `synth.*` handles and `7000000000…` video ids, with dates relative to the run date.

## 5. Demonstration with synthetic data

1. Start the app, add an account with mode **Account Growth**, go back to the dashboard and press **Growth Intelligence**.
2. Optionally fill the strategy and press **Save strategy**.
3. **Import CSV file…** → `docs/gate-5/demo/synthetic-references.csv` (25 rows, dated around 2026-10-22; scores shift as the dates age, regenerate with the fixture if needed).

Expected result (default thresholds, on 2026-10-22):

| Row(s) | Verdict |
|---|---|
| `synth.kitchen.lab` …010 (150k) | **Outlier 7.4×, high confidence** (10-video baseline, median ≈20k) |
| `synth.clean.daily` …026 (52K, rounded) | **Outlier 4.3×, low confidence** (7-video minimum baseline, rounded numbers) |
| `synth.kitchen.lab` …011 (210k, 1 day old) | Not an outlier: too recent |
| `synth.kitchen.lab` …012 (160k) | Not an outlier: marked not relevant |
| `synth.clean.daily` …027 | Not an outlier: inconsistent (more likes than views), below minimum views |
| `synth.new.creator` …040, …041 | Unverified: only 1 comparable video |
| `synth.new.creator` …042 | Missing metrics |
| 2 rows | Rejected: short link; "lots" as views |

Screenshots: `screenshots/01-growth-intelligence.png` (after import), `screenshots/02-growth-after-edits.png` (after a pinned manual entry, a metric fix, a relevance change, threshold changes and a re-import).

## 6. Limits and what's next

- Metrics are only as accurate as what the owner copies (R-34). Rounded display values lower confidence rather than being rejected.
- Video links are not checked against TikTok (by design); a wrong but well-formed link is accepted.
- **R3** (Creative DNA capture + provider-neutral analysis port, deterministic/manual first) and **R4** (concepts, originality guard, hand-off to video settings) are **not started** and wait for your approval.
