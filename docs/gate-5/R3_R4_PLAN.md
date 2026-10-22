# Gate 5 R3/R4 Plan: Creative DNA, Original Concepts, Google Flow Prompts

**Date:** 2026-10-22 · **Status:** on hold (superseded as the default Ternak Akun path by the prompt-template engine, `docs/TWO_FACTORY_ARCHITECTURE.md`). Its provider port, payload guard, Flow prompt structure, spend approval and traceability are reused there and in Affiliate Factory. Nothing implemented.
**Builds on:** R1/R2 (`R1_R2_REPORT.md`, provisionally accepted). **Out of scope:** real Flow browser automation, TikTok publishing, FYP scraping, scheduled or batch production.

## 1. The chain and how it stays traceable

```
reference video ──► creative analysis ──► creative pattern ──► concept ──► Flow prompt (per scene) ──► generated video
 (R2 shortlist      owner observations      owner-confirmed      original,     structured, versioned,     generation_jobs row
  or pinned)        + AI hypotheses         abstraction          account-fit   approved before spend     (+ flow_prompt_id)
                    (kept separate)
```

- Every arrow is a stored link (IDs), and each concept also stores an **immutable lineage snapshot**: reference URLs, creator handles, pattern names and the analysis version at the moment of creation. Deleting or editing a reference later never breaks or rewrites the history of a concept or video.
- A **Trace** view answers both directions: "which references led to this video?" and "what did this reference end up producing?"

## 2. Minimal UI

One new screen, **Creative Studio**, opened from Growth Intelligence (button "Analyze shortlist →") and from the dashboard row. Four steps, one page, left-to-right like the chain:

| Step | What the owner sees and does |
|---|---|
| **1. Analyze** | List of the account's **shortlisted and pinned** references (from R2; nothing else is offered). Select one → a form with six dimensions: **Hook, Pacing, Visuals, Emotional triggers, Payoff, Follow-worthy value**. Each has a few structured fields (e.g. hook type, hook length in seconds, cuts per 10 s, camera style, trigger type, payoff type, value type) plus a free-text observation. **"Suggest hypotheses"** asks the analysis provider; results appear in a separate, visibly different column labelled *AI hypothesis*, each with Accept / Reject. Accepting keeps it a hypothesis (it is never merged into observations) |
| **2. Patterns** | Select one or more analyses → **Create pattern**: a short owner-named abstraction ("Problem shown in first second, then 3-step fix, payoff = before/after"). Fields mirror the six dimensions, written as transferable rules, not as a description of one video. The provider can suggest a pattern; the owner edits and saves it |
| **3. Concepts** | Choose patterns → **Generate concepts** (count defaults to the strategy's daily concept target). Each concept card shows: title, hook line, beat-by-beat outline, on-screen text, caption, why someone would follow, language, the **fit check** (niche, audience, language, style constraints) and the **originality check**. Actions: Edit · Approve · Reject. Rejected concepts stay for learning (R5) |
| **4. Flow prompts** | For an approved concept: **Build Flow prompts** → one prompt per scene (each within the clip length), shown as structured blocks and the rendered text. Edit, then **Approve for generation**: a confirmation states *"This will use video-generation credits: N clips at Quality X, aspect 9:16"*. Only then: **Copy for Flow** (manual path, today) or **Generate** (provider path; synthetic in tests). Video library rows show "from prompt v2 · concept · pattern · reference" with a **Trace** link |

The account's **Visual & character sheet** (characters, wardrobe, setting, lighting, palette, camera, things to avoid) is a new section in the existing strategy form, because it belongs to the account, not to one concept.

## 3. Database (migration 4: four tables, one column)

| Table | Key columns | Notes |
|---|---|---|
| `creative_analyses` | `id` · `bundle_id` · `reference_id` · `observations_json` · `hypotheses_json` · `local_quotes_json` · `version` · `updated_at` · UNIQUE(`bundle_id`, `reference_id`) | Observations (owner) and hypotheses (AI) are **separate columns**. Each hypothesis records provider id, model label, created time and status (pending/accepted/rejected). `local_quotes_json` holds any verbatim hook/script text the owner types: used **only** by the local originality check, never sent to an AI provider |
| `creative_patterns` | `id` · `bundle_id` · `name` · `rules_json` (six dimensions) · `analysis_ids_json` · `origin` (`owner` / `ai_suggested_owner_edited`) · `created_at` · `updated_at` | |
| `concepts` | `id` · `bundle_id` · `pattern_ids_json` · `lineage_json` (snapshot) · `content_json` · `fit_json` · `originality_json` · `provider_id` · `status` (`draft` / `approved` / `rejected`) · `created_at` · `updated_at` | |
| `flow_prompts` | `id` · `bundle_id` · `concept_id` · `scene_index` · `version` · `prompt_json` (structured) · `rendered` (text) · `settings_json` · `status` (`draft` / `approved` / `sent` / `superseded`) · `approved_at` · `created_at` | A new edit creates a new version; approved versions are immutable |
| `generation_jobs` **+ `flow_prompt_id`** (nullable) | | Provider jobs require it (see §6); manual downloads get it from the pending hand-off |

The visual & character sheet extends the existing `growth_strategies.strategy_json` (no new table). The existing single "creative brief" (Gate 4) stays for accounts not using the Studio.

## 4. AI provider boundary

In `packages/core/src/creative/`:

```ts
interface CreativeProvider {
  readonly descriptor: { id: string; displayName: string; kind: 'deterministic' | 'mock' | 'llm'; authorization: AuthorizationConstraints };
  suggestHypotheses(input: AnalysisInput): Promise<ProviderResult<HypothesisDraft[]>>;
  suggestPattern(input: PatternInput): Promise<ProviderResult<PatternDraft>>;
  generateConcepts(input: ConceptInput): Promise<ProviderResult<ConceptDraft[]>>;
  draftScenes(input: SceneInput): Promise<ProviderResult<SceneDraft[]>>;
}
```

- **Inputs are built by one whitelist function per call** (`buildAnalysisInput`, …). They contain only: the owner's structured observations, the strategy (niche, sub-niches, audience, region, language, follow reasons, style constraints), pattern rules, the visual sheet, and numbers such as the outlier ratio. They **never** contain: account names or IDs, proxy data, cookies or session data, credentials, file paths, reference URLs, video IDs, **creator handles** (also prevents "in the style of @x"), or the local verbatim quotes.
- A final **payload guard** scans every outgoing input for known sensitive values of that installation (account display names, proxy hosts/usernames, handles, URLs, e-mail/token patterns) and refuses the call (`unsafe_payload`) instead of redacting silently.
- **Outputs are validated** like any untrusted input: schema, length limits, no URLs or @handles, no control characters, language matches the strategy. Invalid output → `provider_output_invalid`, nothing stored.
- Results are stored, **never logged**; logs carry IDs, counts, provider id and error codes only.
- **Implementations:**
  - `DeterministicCreativeProvider` (free, offline, usable in production): fills templates from pattern rules + strategy; never invents observations, returns no hypotheses ("not available without an AI provider").
  - `MockCreativeProvider` (tests only): scripted outputs, including malformed output, a refusal, a copy of a reference quote, a payload echo, and slow responses.
  - A real LLM adapter is **not** built in R3/R4. When chosen (D-question Q1), it plugs in behind the same interface with its key DPAPI-sealed like proxy passwords, and only for references whose source permits AI use (manual/CSV = owner-observed: yes; a licensed provider: only if `aiDataUse: 'permitted'`).

## 5. Originality and account fit (deterministic, local)

- **Originality check** on every concept and scene prompt:
  - word 5-gram overlap with the owner's local verbatim quotes and observations of the source references (threshold, e.g. any 8-word run or > 15 % 5-gram Jaccard → blocked);
  - no creator handles, names from the reference list, or "like/in the style of" phrasing;
  - concept must change at least the subject/product, the setting and the script wording relative to its sources (fields compared, not just text).
  - Result stored in `originality_json` with pass/fail per rule; a failed concept can't be approved until edited.
- **Fit check**: language equals the strategy language; niche/sub-niche named; target audience addressed in hook or caption; style constraints respected (e.g. "no talking head"); duration fits the account's video settings. Shown as ticks/warnings; hard failures (wrong language, banned element) block approval.

## 6. Flow prompts and the spend gate

- `prompt_json` per scene: `characters` · `setting` · `action` · `camera` · `lighting` · `style` · `on_screen_text` · `audio` · `negative` · `duration_s` · `aspect`.
- **Consistency is enforced by code, not by the AI:** the character, wardrobe, setting, lighting and palette blocks are copied **verbatim** from the account's visual sheet into every scene; the provider only writes action, camera and text. The renderer is a pure function (same structure → same text), with a fixed block order Flow users expect.
- **Approval before spending credits:**
  - only `approved` prompt versions can be copied for Flow or generated;
  - `generation.start(bundleId, flowPromptId, { confirmSpend: true })` refuses without both an approved prompt and the explicit confirmation from the dialog (`prompt_not_approved`, `spend_not_confirmed`); each re-generation asks again;
  - the existing daily cap, single-job rule and challenge handling stay unchanged.
- **Manual Flow path (today):** "Copy for Flow" marks the version `sent` and records it as the account's pending hand-off; the next manual download in that account's Flow window is linked to it, and the owner can re-link it in the video list if it was a different clip. No Flow page is automated.

## 7. Implementation sequence

| Step | Delivers |
|---|---|
| R3a | Migration 4; observation form (six dimensions) on shortlisted/pinned references; Visual & character sheet |
| R3b | `CreativeProvider` port, payload builder + guard, output validation; Deterministic and Mock providers; hypotheses column with accept/reject |
| R3c | Patterns from analyses (owner-created, provider suggestion) |
| R4a | Concept generation, fit check, originality check, approve/reject/edit, lineage snapshot |
| R4b | Scene prompt builder and renderer, versioning, approval with spend confirmation |
| R4c | `flow_prompt_id` on jobs, gate in `GenerationService.start`, manual hand-off linking, Trace view |

One delivery at the end with a report, as for R1/R2, unless you want a checkpoint after R3.

## 8. Testing (synthetic only)

- **Data:** the R2 synthetic CSV plus synthetic observations; synthetic proxy credentials and cookies planted in the test account so leaks are detectable.
- **Unit (core):** observation and pattern validation; payload builder whitelist; payload guard catches each planted sensitive value; output validation (URLs, handles, wrong language, oversize); originality rules (copied quote, handle mention, style-of phrasing, field-change rule); fit check; renderer determinism and identical character blocks across scenes; lineage snapshot.
- **Service (SQLite + Mock provider):** observations and hypotheses stay separate through accept/reject; malformed or copying output rejected and nothing stored; only shortlisted/pinned references can be analyzed; prompt versioning immutability; generation refused without approval or spend confirmation; manual download linked to the pending hand-off; Trace in both directions after deleting a reference; logs contain no strategy text, observations, prompts or handles.
- **E2E (Electron, fuse on):** import synthetic CSV → analyze the outlier → mock hypotheses → pattern → concepts → approve → prompts → approve with confirmation → synthetic generation → video row shows its trace; plus the mock provider's recorded payloads contain none of the planted secrets, account names or handles. Security spec updated for the new bridge methods.

## 9. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| Q1 | AI provider for hypotheses/concepts in real use | Ship R3/R4 with the **deterministic provider only** (free). Choose an LLM later; options include a local model (e.g. via Ollama: free, nothing leaves the laptop, weaker quality) or a paid API. Same interface either way |
| Q2 | Originality thresholds (8-word run, 15 % 5-gram overlap) | As proposed; editable later if it blocks too much |
| Q3 | Scenes per concept and clip length | Default: up to 3 scenes, 8 s each (Flow clip length), 9:16 |
| Q4 | Should the owner be allowed to type verbatim hook/script text? | Yes, kept local for the originality check only, capped at 300 characters per reference |
| Q5 | Delivery | Single R3+R4 delivery, or a checkpoint after R3 |
