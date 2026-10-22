# Proposal: Supervised Google Flow generation helper (Gate 4b)

**Date:** 2026-10-22 · **Status:** proposal for approval. Nothing implemented.
**Builds on:** `FLOW_FEASIBILITY.md` (owner decision §5; T5 confirmed, T3/T6 pending), the committed generation framework (`111063873d6c`).

## 1. Goal
Generate one video at a time in your own Google Flow account, from an Account Growth bundle's saved brief, with you watching. It has two phases.
- **Dry run:** the helper finds and highlights the prompt box and the Generate control in the bundle's Flow window. **It doesn't type, click or submit anything.** You confirm it found the right controls.
- **One supervised job**, only after you approve the dry run:
  1. You press "Generate one video (supervised)".
  2. The helper types the saved prompt and presses Generate **once**.
  3. It watches progress.
  4. The finished MP4 goes to the bundle's library.
  5. The outcome is recorded.

  No automatic retries, no batches, no schedule.

## 2. What stays the same
- **Isolation:** the bundle's own Google Flow partition, behind its dedicated proxy (fail closed; Test Proxy must pass in this run). No session or proxy sharing between bundles.
- **Visible window:** you can see everything the helper does.
- **Browser identity:** unchanged. No user-agent spoofing, fingerprint changes, "stealth" plugins or headless mode.
- **Content:** your prompt, Flow's page content and your videos are never logged or sent anywhere; the helper reports only codes, counts and which control rule matched.
- **Generation framework:** jobs, the daily cap, "needs you" outcomes, the library, and the Flow download handler (MP4 only, Google domains, 512 MB cap, signature check).

## 3. How the helper works

**Finding controls without reading your content**
- The helper runs in an **isolated script world** inside the Flow window: Flow's own scripts can't see or call it, and it can't see theirs.
- It looks for controls by **accessibility role and label**, never by brittle page structure:
  - a text box with an accessible name or placeholder like "prompt" / "describe";
  - a button named like "Generate" / "Create";
  - English and Indonesian labels, depending on your Flow language (Q4).
- It returns only:
  - which rule matched;
  - the element's role and label;
  - its position on screen;
  - a **match count** (exactly one match is required, or the dry run fails as ambiguous).
- It never reads input values, prompt history, project names or video titles.

**Highlighting**
- A temporary outline and a small "UGC helper: prompt box" / "UGC helper: Generate" tag are drawn over the matched controls.
- They're removed when you close the dry run.

**Approval record (non-secret, SQLite)**
- A fingerprint of *which rules matched* (not page content) and the time you approved it, per bundle.
- If Flow's page changes so that different rules match, the approval is void, the job stops as `interface_changed`, and a new dry run is needed.

**The supervised job, in order:**
1. **Pre-checks**, any failing one stops the job before Flow is touched: proxy passed, approval fingerprint still matches, daily cap not reached, no job already running, no challenge visible on the page.
2. **Type the prompt** into the prompt box as normal keyboard input, not through the clipboard.
3. **Press Generate exactly once.**
4. **Watch for progress, completion or a stop condition**, polling about every 3 s with a 15-minute limit.
5. **Download:** the helper presses the finished video's own download control once, or you download it (Q1). Either way the existing download handler saves it into the library.
6. **Record the outcome:** `completed`, `waiting_for_user(reason)` or `failed(reason)`. Never retried.

## 4. Stop conditions (enforced in the main process; the job ends, the window stays open for you)

| Detected | Outcome |
|---|---|
| A reCAPTCHA/verification frame, "Unusual activity", "verify it's you", or any challenge text | `waiting_for_user: challenge_required`. The helper never clicks, types into or otherwise touches a challenge |
| Redirect to Google sign-in, or a signed-out state | `waiting_for_user: auth_required` |
| "Not enough credits", out of daily generations | `waiting_for_user: quota_exhausted` |
| "Requesting generations too quickly" or similar | `waiting_for_user: rate_limited` |
| Prompt refused under the content rules | `failed: policy_rejected` |
| Prompt box or Generate not found, more than one match, or a changed fingerprint | `waiting_for_user: interface_changed` (new dry run needed) |
| No completion within 15 minutes | `failed: transient` (nothing is pressed again) |
| Download missing, not MP4, or fails the signature check | `failed: output_invalid` |
| Proxy not ready / app restarted mid-job | `proxy_not_ready` before start / `failed: transient (interrupted_by_restart)` |

**Credit limits:**
- **Daily cap per bundle:** 3, changeable (Q3).
- **One Generate press per job.**
- **No model changes:** the helper **doesn't change Flow's model, aspect ratio or quality settings** (Q2). You choose them in Flow, so credit use stays under your control.
- **Credits used:** the job records the credits Flow shows only if you choose to note them. The helper doesn't read your credit balance.

## 5. Tests (synthetic only; no real Flow in automated tests)
A **Flow stand-in page** on the synthetic site, with a prompt box, a Generate button, progress, a finished tile with a download control, and variants for challenge, sign-in, out of credits, rate limit, policy refusal, changed layout and two Generate buttons. The tests check:
- **Dry run:** the controls are highlighted, and the site records **zero** generate requests and zero typing.
- **Approval:** recorded; a changed layout voids it.
- **One job:** the site records **exactly one** generate request; the MP4 lands in the right bundle's library through that bundle's proxy; nothing is retried after a failure.
- **Stop conditions:** each variant ends in the right outcome; nothing is clicked in the challenge variant.
- **Isolation:** two bundles with two proxies; each helper acts only in its own window and partition.
- **Data:** the prompt, page text and video never appear in logs, the database (apart from your saved brief) or the bridge responses.

## 6. Risks you accept by approving
- **Account risk:** Flow's terms don't forbid this kind of automation (robots.txt allows it), but Flow scores activity with reCAPTCHA Enterprise and may challenge or rate-limit it. A suspension is possible if Google considers it abuse. Mitigations: human pace, single actions, visible window, immediate stop on any challenge.
- **Brittleness:** Flow's interface can change at any time. The fingerprint check turns that into a "new dry run needed" stop, never a wrong click.
- **Not yet known:** T3 (challenges) and T6 (restart persistence) are still **pending**. The dry run reports a visible challenge, and T6 is worth checking before relying on minimal intervention.

## 7. Decisions needed
| # | Question | Recommendation |
|---|---|---|
| Q1 | After completion, does the helper press Flow's download control once, or do you download by hand? | **Helper presses it once**: same handler, completes the 8-step workflow |
| Q2 | Does the helper change Flow's model/aspect/quality settings? | **No** in this milestone: you set them in Flow; fewer clicks, less fragility, credit use stays in your hands |
| Q3 | Daily cap per bundle | **3** |
| Q4 | Which language is your Flow interface in? | Tell me (English/Indonesian/other) so the label rules match |
| Q5 | Do you accept the risks in §6 for your Google account? | Required before real use |

**Out of scope:** TikTok publishing, batch generation, scheduling or daily automation, unattended runs, Kalodata, and any CAPTCHA solving or detection evasion.
