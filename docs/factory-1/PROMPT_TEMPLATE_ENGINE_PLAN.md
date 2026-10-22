# T1 Plan: Prompt-Template Engine (Ternak Akun)

**Date:** 2026-10-22 · **Status:** approved with amendments; **implemented** (`T1_REPORT.md`).
**Goal:** Open a Growth account → pick ASMR, Grandma Messages or Trending Dance → set character/world/style → choose a count (default 10) → generate distinct, original, structured prompts → review and edit → save approved prompts to the account's production queue or video settings.
**Not in T1:** Google Flow automation, TikTok publishing or scheduling, Growth Intelligence dependency, real AI provider, Affiliate Factory.

## 1. Template definition (data, versioned)

Templates are data objects in `packages/core/src/templates/builtin/`, validated by `validateTemplate()` at startup and in tests. A changed template gets a new version; batches record the version they used.

| Field | Content |
|---|---|
| `id`, `version`, `family`, `displayName`, `niche` | e.g. `asmr-relax` v1, family `asmr` |
| `variables` | Schema list: `key`, `label`, `type` (`text` / `choice` / `multi` / `number`), `required`, `default`, `options`, limits |
| `consistency` | Fields fixed for every prompt of an account: `character`, `world`, `style`, `camera`, `lighting`, `palette`, `avoid` (defaults supplied, owner edits) |
| `structure` | Ordered prompt blocks (`subject`, `setting`, `action`, `camera`, `lighting`, `style`, `audio`, `on_screen_text`, `avoid`) with `{{variable}}` placeholders |
| `variation` | Axes (variable keys with pools, e.g. trigger × object × setting) and rules: no repeated combination in a batch, minimum differing axes, optional per-account memory to avoid repeating recent combinations |
| `references` | `none` / `optional` / `required`, kinds (`image`, `video`, `motion`), and the rights confirmation text |
| `video` | Aspect ratio and duration defaults (9:16, 8 s) within the existing video-settings limits |
| `caption` | Pattern with placeholders, hashtag set, CTA style, max length |
| `content` | Optional phrase pools (e.g. message lines per theme) used by the deterministic provider |

**Initial families (one template each in T1):**

| Template | Key variables | Consistency | References |
|---|---|---|---|
| ASMR / Relaxation | trigger (tapping, crinkling, soap cutting, kinetic sand, pouring, brushing), object/material, setting, mood | hands-only or no person; macro camera; soft light; palette | optional (own texture/sound footage) |
| Grandma Messages | message theme (life advice, encouragement, family, money wisdom), tone, language (default Indonesian), time of day, home corner | the same grandmother: age, look, wardrobe, home; talking-to-camera framing | optional (an original character image the owner owns) |
| Trending Dance / Motion Transfer | dance style label, outfit variant, location, camera move | the same original character and world | **required**: motion reference the owner owns or has rights to; used only in the manual Flow hand-off, never sent to an AI provider |

## 2. Generation pipeline (pure and deterministic by default)

1. `planVariations(template, config, count, seed)` picks distinct axis combinations (seed = account + batch). If the pools can't give `count` distinct combinations, it returns fewer and says why; it never pads with duplicates.
2. `ConceptProvider.expand(input)` adds the creative details per variation (hook/opening moment, action beat, message line, caption idea). Provider-neutral interface; implementations in T1:
   - `TemplateProvider` (deterministic, free, offline, usable in real use): fills from the template's phrase pools;
   - `MockConceptProvider` (tests): scripted outputs including malformed, duplicate and unsafe responses.
   A real LLM adapter plugs in later behind the same interface (provider choice is a later decision).
3. **Payload whitelist + guard:** provider input contains only template fields, variable values, consistency settings and the variation; never account names or ids, proxy, cookies, session data, credentials, file paths or handles. A guard refuses any payload containing this installation's sensitive values (`unsafe_payload`).
4. **Output validation:** schema, length limits, no URLs/handles/control characters, language matches.
5. `renderPrompt(template, config, item)`: pure function from structured blocks to the Flow prompt text; **consistency blocks are copied verbatim** into every prompt (character/world identical across the batch). Caption rendered from the caption strategy.
6. **Distinctness check:** no two items share a combination; rendered texts pairwise below a similarity limit (word 5-gram Jaccard). Near-duplicates are flagged for editing.

## 3. Database (migration 4: three tables, one column)

| Table | Columns |
|---|---|
| `template_configs` | `id` · `bundle_id` · `template_id` · `template_version` · `config_json` (variables, consistency, count, video, caption overrides) · `updated_at` · UNIQUE(`bundle_id`, `template_id`) |
| `prompt_batches` | `id` · `bundle_id` · `template_id` · `template_version` · `config_snapshot_json` · `provider_id` · `seed` · `requested` · `created_at` |
| `prompt_items` | `id` · `batch_id` · `bundle_id` · `position` · `variation_json` · `prompt_json` · `rendered` · `caption` · `status` (`draft` / `approved` / `rejected` / `queued` / `used`) · `edited` · `updated_at` |
| `generation_jobs` **+ `prompt_item_id`** | nullable; set when a queued item is used for a job, for traceability item → video |

- The **production queue** is the account's `queued` items (no extra table), ordered by position/date.
- **"Use as video settings"** copies one approved item's rendered prompt and video settings into the existing creative settings (Gate 4), so the existing Generate button (synthetic) and the manual Flow path work unchanged.
- Prompts and captions are the owner's content: stored locally, never logged (logs carry ids, counts, template id, error codes).

## 4. Minimal UI

- **Dashboard:** Growth rows get a **Prompt Studio** button (Growth Intelligence button stays, labelled optional).
- **Prompt Studio** (one page per account):
  1. Template picker: three cards (name, what it makes, reference requirement).
  2. Configuration form generated from the template's variable schema, plus the consistency section (character/world/style) and count (default 10), aspect/duration, caption options; a required motion reference shows an attach-file field with the rights confirmation checkbox. Save configuration.
  3. **Generate prompts** → list of items: variation summary, structured blocks (editable), rendered prompt, caption, distinctness flags. Per item: Edit · Approve · Reject · Regenerate this one. Batch actions: Approve all unflagged.
  4. **Add approved to queue** and per item **Use as video settings**. Queue panel: queued items with **Copy prompt** (clipboard, for manual use in Flow) and status. No claim of automatic Flow generation or posting.
- Top-level navigation (Overview, Ternak Akun, Affiliate Factory, Accounts, Video Library, Settings) is **not** in T1, to keep it small; proposed as the next small milestone.

## 5. Tests (synthetic, deterministic)

- **Unit (core):** the three built-in templates validate; invalid templates rejected (unknown placeholder, empty pool, bad limits); variable validation; `planVariations` is deterministic per seed, gives 10 distinct combinations, returns fewer with a reason when pools are small; renderer determinism; identical consistency blocks in all items; caption limits; payload builder whitelist; guard catches planted sensitive values; output validation; distinctness check.
- **Service (SQLite + Mock provider):** save/load configs; batch generation stores template version and config snapshot; edits re-render and persist; approve/reject/queue; "use as video settings" writes the creative settings; affiliate accounts refused; malformed or unsafe provider output stores nothing; logs contain no prompt text; item → job link.
- **E2E (Electron, fuse on):** synthetic growth account → Prompt Studio → ASMR → configure → generate 10 → edit one → reject one → approve the rest → queue → use one as video settings → synthetic generation job carries `prompt_item_id`; Grandma and Dance smoke paths (Dance requires the rights checkbox). Security spec updated for new bridge methods; a payload-leak test with planted synthetic proxy credentials and cookies.

## 6. Delivery steps

| Step | Delivers |
|---|---|
| T1a | Core: template schema, validation, three built-in templates, variation planner, renderer, distinctness check |
| T1b | Provider port, payload guard, output validation, Template and Mock providers |
| T1c | Migration 4, PromptStudio service, IPC/preload/bridge |
| T1d | Prompt Studio UI, queue, "use as video settings", job link |
| T1e | Full suite, report with synthetic demo and screenshots, commit and push |

## 7. Decisions needed

1. Real AI provider: none in T1 (deterministic template provider only) — agreed?
2. Grandma Messages default language Indonesian, with lines from editable phrase pools in the template?
3. Reference/motion files: only assets you own or have rights to, kept local, never sent to an AI provider?
4. Navigation shell as the next small milestone after T1 (not inside T1)?
