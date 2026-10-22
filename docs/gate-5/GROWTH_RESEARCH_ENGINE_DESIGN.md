# Gate 5 Design: Account Growth Research Engine

**Date:** 2026-10-22 · **Status:** approved with modifications (D21). **R1/R2 implemented** (`R1_R2_REPORT.md`): 3 tables instead of the 12 below; baselines and assessments computed on read. R3+ not started.
**Pipeline:** Trend Discovery → Outlier Scoring → Creative DNA → Original Concept → Google Flow → Video Library → Publishing → Performance Feedback.
This milestone covers **the first five stages up to the Flow hand-off**, plus the data model for the learning loop. Publishing stays out of scope.

## 1. Authorization findings (read 2026-10-22, primary sources)

| Source | What's authorized for you (a commercial creator in Indonesia) | Consequence |
|---|---|---|
| **TikTok Terms of Service** (updated 1 Dec 2025), §5 | Prohibits "use automated scripts to collect information from or otherwise interact with the Services" and bypassing access restrictions | **No automated collection from TikTok.** This includes the FYP, creator pages, search and Creative Center pages |
| TikTok ToS §7A and the Indonesia supplemental terms | TikTok content "may not be downloaded, copied, reproduced"; in Indonesia "you are allowed to download … your User Content (but not any other content)" | **No downloading other creators' videos.** Analysis of reference videos must not use copies of them |
| **TikTok Research API** | Academic and not-for-profit researchers in the US, EEA, UK, CH, CA and BR only; applicants must be "independent of commercial interests" | **Not available to you** |
| **TikTok Display API** (Login Kit, `video.list` / `video.query`) | Returns view, like, comment and share counts, create time and duration for **public videos of the user who authorized the app** | **Authorized route for your own accounts' performance data** (learning loop). Needs a registered TikTok developer app and OAuth per account |
| **TikTok Creative Center** | Public trend pages for manual viewing. No public data API was found; third-party scrapers exist and report being blocked | **Manual use only.** You can note what you see there; the app doesn't fetch it |
| **Kalodata** | ToS §4.1.8, §14.3–14.6: no automation, no AI processing of its data (D14, D16) | **Excluded** from automated research and from AI analysis |
| **Future third-party providers** | Only with a licence that permits commercial use, automation and AI processing | Pluggable behind the same interface, enabled only with a recorded authorization basis |

**Unattended research from TikTok is not available through any authorized integration today.** The engine keeps this as a provider capability: a provider may run unattended only if its recorded authorization permits automated retrieval (the existing `assertResearchUse` guard). Until then, discovery is **owner-assisted import** of references you find while browsing normally.

## 2. What exists today (inspected)
- **`account_bundles`:** `mode` (`affiliate_ugc` | `account_growth`) and a dedicated proxy.
- **`creative_settings`:** one prompt and video settings per bundle.
- **`generation_jobs` / `generation_events`:** one job at a time per bundle, outcomes, and the library link.
- **`VideoGenerationProvider`:** synthetic only; real Flow is manual plus library capture.
- **`ResearchProviderDescriptor` / `assertResearchUse`:** an authorization gate with no implementation yet.
- **Platform-neutral `packages/core`:** validation, redaction, models. The Linux worker can reuse it.

The research engine slots in **before** `creative_settings`: a concept becomes the Flow prompt of a generation job.

## 3. Architecture

```text
packages/core (pure, provider-independent, unit-tested)
  growth/strategy.ts      GrowthStrategy model + validation
  research/provider.ts    ResearchProvider v2: capability + authorization; returns CandidateVideo[] with provenance
  research/outlier.ts     baseline (median), outlier ratio, age handling, confidence, data-quality flags, explanation codes
  creative/dna.ts         CreativeDNA schema: every field is an Observation or a Hypothesis, with source and evidence
  creative/concept.ts     Concept schema + originality guard (similarity to source material, banned-likeness checks)
  learning/feedback.ts    hypothesis-tag performance summaries with sample-size caveats (no causal claims)

apps/desktop (main process)
  growth-store.ts         SQLite migration 3 (below)
  research-service.ts     runs providers (permitted ones only), stores candidates and metric snapshots, scores outliers
  analysis-provider.ts    AnalysisProvider port (LLM). Implementations: Synthetic (tests) + one real LLM provider (Q2)
  concept-service.ts      DNA → concepts → originality check → hand-off to creative_settings / generation job

providers (each with a recorded authorization)
  ManualImportProvider    owner pastes or imports references (URL, creator, metrics you saw, date seen) from a template
  SyntheticResearchProvider   deterministic datasets for tests
  DisplayApiProvider      (later) your own accounts' post metrics, via OAuth, for the learning loop
  LicensedThirdPartyProvider  (future) only with a commercial + automation + AI licence on record
```

**Hard boundaries in code:**
- **No provider without an authorization record.** `automated_retrieval` and `ai_processing` are checked before every run and before any data reaches an LLM.
- **No downloading of other creators' media.** Reference "content" is limited to URL, metadata, the metrics you saw, and your own observation notes.
- **The LLM sees only your notes and metadata.** Never Kalodata data (D16), never other creators' footage, audio or full scripts.

## 4. Data model: SQLite migration 3 (minimum additions)

| Table | Key columns (all non-secret) |
|---|---|
| `growth_strategies` | `bundle_id` PK · `niche` · `sub_niches` (JSON) · `audience` · `region` · `language` · `desired_followers` · `follow_reasons` (JSON) · `style_constraints` (JSON) · `min_views` · `min_engagements` · `window_days` · `outlier_threshold` (e.g. 3.0) · `daily_concepts` · `daily_videos` · `updated_at` |
| `reference_creators` | `id` · `bundle_id` · `platform` · `creator_handle` · `profile_url` · `note` · `added_at` |
| `research_runs` | `id` · `bundle_id` · `provider_id` · `authorization_basis` · `window_start` / `window_end` · `status` · `counts` (JSON) · `created_at` |
| `candidate_videos` | `id` · `bundle_id` · `run_id` · `source` (provider id) · `url` · `platform_video_id` · `creator_id` · `published_at` · `duration_s` · `provenance` (`owner_observed` / `api` / `licensed`) · `added_at` · UNIQUE(`bundle_id`, `platform_video_id`) |
| `metric_snapshots` | `id` · `candidate_id` · `observed_at` · `views` · `likes` · `comments` · `shares` (each **nullable**; never estimated) · `source` · `exactness` (`exact` / `rounded_display`, e.g. "1.2M") |
| `creator_baselines` | `id` · `bundle_id` · `creator_id` · `computed_at` · `window_days` · `sample_size` · `median_views` · `excluded` (JSON reasons) |
| `outlier_assessments` | `id` · `candidate_id` · `baseline_id` · `ratio` · `age_days` · `relevance` (0–1) · `relevance_method` (`owner_tag` / `keyword` / `ai_hypothesis`) · `confidence` (`low` / `medium` / `high`) · `quality_flags` (JSON) · `qualifies` · `reasons` (JSON codes) · `created_at` |
| `creative_dna` | `id` · `candidate_id` · `fields` (JSON: per dimension `{statement, kind: observation\|hypothesis, source: owner\|ai, evidence}`) · `created_at` |
| `concepts` | `id` · `bundle_id` · `dna_ids` (JSON) · `pattern_tags` (JSON, e.g. hook type, format) · `concept` · `hook` · `script` · `shots` (JSON) · `flow_prompt` · `visual_spec` · `caption` · `follow_proposition` · `originality` (JSON: max similarity, checks passed) · `status` (`draft` / `approved` / `rejected` / `sent_to_flow`) · `created_at` |
| `generation_jobs` (+1 column) | `concept_id` (nullable): links a video back to its concept and hypothesis |
| `published_posts` | `id` · `bundle_id` · `concept_id` · `generation_job_id` · `platform_video_id` · `published_at` · `published_by` (`owner`) |
| `post_metric_snapshots` | `post_id` · `observed_at` · `views` / `likes` / `comments` / `shares` (nullable) · `source` (`owner_entry` / `display_api`) |

## 5. Outlier scoring (deterministic, explainable)
- **Creator baseline = median views** of that creator's comparable videos:
  - inside the strategy's research window;
  - excluding the candidate itself;
  - only videos at least `min_settle_days` old (default 3), because young videos haven't finished accumulating views.
- **Minimum sample:**
  - **8+ videos** → baseline usable (confidence can be high);
  - **5–7** → usable at **low** confidence;
  - **under 5** → **no baseline**: the candidate is reported as `insufficient_baseline` and not scored.
- **Outlier ratio** = candidate views ÷ baseline median.
  - Qualifies when the ratio ≥ the strategy threshold, views ≥ `min_views`, and the video is at least the settle age.
  - Younger videos are flagged `too_recent`, never promoted.
- **Engagement ratios** (likes, comments and shares per view) are computed **only when those metrics exist**. Missing values are flagged, never filled in.
- **Confidence** goes down for:
  - a small sample;
  - display-rounded metrics (e.g. "1.2M");
  - stale snapshots (older than 7 days);
  - missing engagement data;
  - owner-observed metrics (vs API).
- **Relevance:** owner tags or niche-keyword matches first. AI relevance is stored as a **hypothesis** with its method.
- **Explanation** (generated from codes, not invented prose), e.g. *"412k views vs this creator's median of 38k across 12 videos in the last 30 days → 10.8×, above your 3× threshold; posted 9 days ago; engagement data available; confidence: high."*

## 6. Creative DNA
- **Dimensions:** opening hook, first-3-second visual, story structure, emotional trigger, pacing, editing rhythm, visual style, audio strategy, curiosity/payoff mechanism, replay potential, follow-worthy value proposition.
- **Every entry is labeled:**
  - **Observation:** you saw it, with an optional timestamp or note as evidence.
  - **Hypothesis:** an inference, by you or the AI, e.g. "the payoff is withheld until second 6 to drive completion".
  - AI output is always a hypothesis.
- **Input sources:** your structured notes made while watching in the account's TikTok session, plus the video's public metadata.
  - **Excluded:** footage, frames, audio, voice or full transcripts of other creators.
  - **Short descriptors only:** e.g. "question hook addressed to new homeowners", not their script.
- **Stored per candidate:** each candidate can have several DNA records (yours and AI-assisted), and concepts cite which ones they draw from.

## 7. Original concept generation
- **Output per concept:** concept, hook, short script, shot sequence, Google Flow prompt, visual references spec, suggested caption, and the account-specific follow proposition. Each is tagged with the patterns it applies (e.g. `hook:question`, `format:before_after`).
- **Originality guard, before a concept can be approved:**
  - text similarity against the source material (your notes and the reference's public caption) must be below a threshold;
  - no creator names, handles, recognizable likenesses, voices or branded characters in the Flow prompt;
  - no copied captions, audio or lyrics;
  - a failed check marks the concept `rejected` with the reason codes.
- **Hand-off:** you approve a concept → its Flow prompt becomes the bundle's creative brief → the existing generation path (manual Flow + library capture now, the supervised helper later) runs with `concept_id` recorded.

## 8. Learning loop (data model now, analysis once data exists)
- **Published posts are linked** to concept → patterns → generation job.
- **Your own post metrics come from:**
  - **your entries now;**
  - the **TikTok Display API later** (authorized, own accounts only, needs a developer app and OAuth).
- **Reports compare pattern tags within an account:** medians, ranges, counts. Each comparison is marked **"insufficient evidence"** until a minimum sample exists (e.g. 5 posts per pattern), and always says "associated with", never "caused".

## 9. Implementation sequence (each step synthetic-tested, then reviewed)

| Step | Delivers | Needs from you |
|---|---|---|
| R1 | Migration 3; growth strategy form per Growth bundle; reference creators list | Defaults for thresholds (Q4) |
| R2 | ManualImportProvider (paste or import a CSV/JSON template of references and observed metrics) + SyntheticResearchProvider; baselines and outlier scoring with explanations; candidates view | — |
| R3 | Creative DNA capture form (observations) + AnalysisProvider port with a synthetic implementation; AI-assisted hypotheses behind a switch | LLM provider choice (Q2) |
| R4 | Concept generation + originality guard + approve/reject + hand-off to creative settings and generation jobs (`concept_id`) | — |
| R5 | Published-post records and post metric entry; learning summaries with sample-size caveats | — |
| R6 (later) | Display API provider for your own accounts' metrics | A TikTok developer app (Q3) |

Not in this milestone: publishing, batch or scheduled generation, real Flow automation (the helper proposal is separate and pending), any TikTok scraping or FYP automation, engagement automation, and Kalodata research.

## 10. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| Q1 | Accept that research input is owner-assisted import (no automated TikTok collection) until an authorized provider exists? | Yes. It's the only compliant route today |
| Q2 | Which LLM for DNA hypotheses and concept generation? | A provider-agnostic port; first real implementation the Anthropic API (Claude), with its key DPAPI-sealed like proxy passwords. Paid per use; only your notes and metadata are sent. Model choice confirmed at R3 |
| Q3 | Register a TikTok developer app for the Display API (own-account metrics)? | Yes, but later (R6). Until then, enter metrics yourself |
| Q4 | Defaults: settle age 3 days; minimum baseline sample 8 (5 for low confidence); outlier threshold 3×; research window 30 days | As listed; editable per account |
| Q5 | Are any licensed third-party research providers available to you (with commercial + automation + AI rights)? | If so, name them and I'll check their terms before adding an adapter |

## Sources
- [TikTok Terms of Service](https://www.tiktok.com/legal/page/row/terms-of-service/en)
- [TikTok Research API](https://developers.tiktok.com/products/research-api/)
- [Display API: List videos](https://developers.tiktok.com/doc/tiktok-api-v2-video-list)
- [Display API: Video object](https://developers.tiktok.com/doc/tiktok-api-v2-video-object)
- Secondary, on Creative Center automation: [Apify Creative Center scraper](https://apify.com/datapeak/tiktok-creative-center), [Apify trends scraper changelog](https://apify.com/automation-lab/tiktok-trends-scraper/changelog), [ConductAtlas summary of TikTok's scraping clause](https://conductatlas.com/platform/tiktok/tiktok-terms-of-service/prohibition-on-scraping-and-data-extraction/)
