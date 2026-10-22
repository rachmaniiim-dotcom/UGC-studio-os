# T1 Report: Prompt Template Engine (Ternak Akun)

**Date:** 2026-10-22 · **Status:** implemented and tested with synthetic data. Waiting for review.
**Plan:** `PROMPT_TEMPLATE_ENGINE_PLAN.md` (approved with amendments). **Architecture:** `docs/TWO_FACTORY_ARCHITECTURE.md` (two independent factories; no lifecycle or graduation).

## 1. The working interface

Dashboard → any **Account Growth** row → **Prompt Studio** (Growth Intelligence stays as an optional button). Affiliate accounts don't get it, and nothing in Affiliate Factory or account isolation changed.

| Step | What you do |
|---|---|
| 1. Template | Pick a card: **ASMR / Relaxation**, **Grandma Messages**, **Trending Dance / Motion** (starters, read-only) or one of **your templates**. **Duplicate** any template; **Edit** your own |
| 2. Settings for this account | Character / world / style text (copied **word for word** into every prompt, with **Load saved…** and **Save as…** presets reusable across accounts), the varying lists (one option per line), fixed values, number of prompts (default **10**), aspect ratio, duration, hashtags, reference files. **Save settings** / **Generate N prompts** |
| 3. Prompts and production queue | Each prompt is a card: status, variation chips, flags, the full prompt text, caption, manual steps. Filters by status; **Approve all unflagged drafts**, **Queue all approved** |

**Prompt statuses (approval is separate from production):**

| Status | Meaning | Actions |
|---|---|---|
| Draft | Generated or edited, not reviewed | Approve · Edit · Regenerate · Reject |
| Approved prompt | Text accepted. **Not a video** | Queue for generation · Edit · Back to draft · Reject |
| Rejected | Kept for reference, excluded from duplicate checks | Restore to draft · Regenerate |
| Queued for generation | Waiting to be produced | Copy prompt for Flow · **I'm generating it in Flow** · Generate with provider (only when one is enabled, after a credit confirmation) · Remove from queue · Link a video already in the library |
| Generating | Taken to Google Flow by hand, or a provider job running | Copy again · Back to queue · Link a video |
| Video ready | A real video file in the account's library is linked | Show video in folder |

Only a linked video file makes a prompt "video ready"; no button does. In real use there is no automatic video provider, so production is: copy → generate in the account's Google Flow window → download there. The existing download handler saves the file to the account's library (unchanged) and now links it to the oldest prompt waiting in "Generating"; a download with no waiting prompt stays unlinked and can be linked from a queued prompt.

**Editing and regeneration:** editing any section or the caption returns the prompt to Draft. If the character/world/style text no longer appears exactly, the prompt is flagged and can't be approved until fixed or regenerated. **Regenerate** replaces one prompt with a combination not used elsewhere in its batch.

**Owner master templates:** sections (long structured text with `{{placeholders}}`), variables (consistency / pool / choice / text), per-prompt details, reference settings and caption strategy. **Save new version** never overwrites: each save is v+1, earlier batches keep the version they were made with, and invalid templates are refused with the reason (e.g. an unknown placeholder).

## 2. Prompt quality and diversity

- Starter prompts are complete Flow briefs (~1,700–2,500 characters): Scene, Setting, Action/Choreography/Dialogue, Camera, Lighting and style, Timing/Ending, Audio, Avoid. Grandma Messages has Indonesian dialogue lines; every character, location and dance is original and fictional.
- **Diversity:** combinations are planned so every two prompts in a batch differ in at least two variation axes (tested for all starters), options are used evenly, combinations are never repeated, and a new batch avoids combinations used recently for the account. If the lists can't provide enough distinct combinations, fewer prompts are generated and the screen says why.
- **Near-duplicates** are detected on what varies (the shared character/world text is ignored) and flagged "similar to #n"; flagged prompts are skipped by "Approve all unflagged drafts".

## 3. Reference files

Pick a file (JPG, PNG, WEBP, MP4, MOV, ≤ 200 MB) after ticking **I own this file or have the rights to use it**. The file's content is checked against its type, copied to `<userData>/references/<account>/`, hashed, and associated with the prompts generated with it. Reference files are never sent to a prompt generator. Every prompt that uses one lists its **manual action**: "upload in Google Flow" for images, and for motion references "**no verified Google Flow control**" (motion transfer stays manual).

## 4. Provider boundary

`ConceptProvider` (core) with the deterministic, offline **TemplateProvider** (no AI, no network, no cost). Requests are built from template text, the owner's creative values and the planned variations only; for remote providers a guard refuses any request containing account names, account ids, proxy hosts or observed IPs (`unsafe_payload`), and output is validated (no URLs, handles, placeholders, missing items). A tested leak found during T1: the provider seed contained the account id; it now uses the batch id.

## 5. Data (migration 4)

`prompt_templates` (owner templates, versioned) · `creative_presets` · `reference_assets` · `template_configs` · `prompt_batches` (template and settings snapshot, references, provider, shortfall) · `prompt_items` (status, edits, flags, near-duplicates, hand-off, job) · `generation_jobs.prompt_item_id`.

## 6. Tests (synthetic only)

| Suite | Result |
|---|---|
| Typecheck | pass |
| Unit (vitest) | **317 passed** (17 files). New: `packages/core/test/templates.test.ts` (34), `apps/desktop/test/prompt-studio.test.ts` (16) |
| E2E (Electron, cookie-encryption fuse on) | **50 passed, 1 skipped** (opt-in native dialog). New: `apps/desktop/e2e/prompt-studio.spec.ts`; `security.spec.ts` updated for 16 new bridge methods; the existing manual-download and generation specs still pass |
| Secret scan | No secrets found |

## 7. Demonstration (synthetic)

1. Start the app (`node apps/desktop/scripts/run-app.mjs`) and add an account named e.g. **Synthetic Ternak 01** with mode **Account Growth** (no proxy or session needed for Prompt Studio).
2. **Prompt Studio** → ASMR is selected → change the hands text → **Generate 10 prompts**.
3. Edit #1's caption, reject one, **Approve all unflagged drafts**, **Queue all approved**.
4. On one: **Copy prompt for Flow** → **I'm generating it in Flow**. The app has no automatic video provider in normal use, so there is no Generate button; the provider path (**Generate with Synthetic test provider…** → **Confirm** → **Video ready**) runs only in the automated tests and is shown in screenshot 02.
5. Grandma Messages → **Duplicate** → **Edit** → rename, add a message line → **Save new version** → generate 3.
6. Trending Dance → tick the rights box → **Add reference file…** → generate 2 → "needs manual action".

Screenshots (`screenshots/`): 01 generated batch · 02 queue with every status · 03 template editor · 04 dance with a motion reference marked manual.

## 8. Not in T1

Real Google Flow automation, TikTok publishing or scheduling, navigation redesign, AI/LLM provider, Affiliate Factory changes.
