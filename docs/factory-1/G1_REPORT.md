# G1 Report: Ternak Akun Posting Queue (Ready-made + AI-generated)

**Date:** 2026-10-23 · **Status:** implemented and tested with synthetic data and a test analyzer. **Not yet run against the real Gemini API or real videos.**
**Requirement:** Ternak Akun grows accounts with content inspired by what performs on the FYP. No permanent niche, no random topics. Two sources, one queue.

## How it works

Dashboard → Ternak Akun account → **Posting queue** (new, the main button). Prompt Studio and Growth Intelligence remain.

| Section | What happens |
|---|---|
| **AI analysis settings** | Gemini API key (sealed by Windows DPAPI; never shown again, never logged, never sent to the UI), model (default `gemini-3.8-flash`), your cost estimate per analysis (default $0.01) and monthly budget (default $10). Spend this month is shown; analysis stops at the budget with a reason. Opens by itself until a key is set |
| **1. Finished videos** | Drop MP4 files on the box, **Choose MP4 files…** or **Choose a folder…** (every `.mp4` directly inside). Each file is hashed; one already in this account's queue is skipped; non-MP4s or unreadable files are listed. Files are **copied** into the account's library; originals are never moved or changed. The same file in another account's queue is allowed but flagged |
| **Captions** | Each video is uploaded to Gemini (then deleted there) and described from what is actually seen and heard: an Indonesian caption and 3–6 hashtags. The model is told not to invent names, products, places or claims, and to say when it can't tell what the video shows. The file name is passed only as a hint ("use it only if it matches the video") |
| **Flags** (video goes to *Check caption*) | `unclear_video` (no caption is written), low confidence, generic caption, a caption too close to a recent one of this account, no hashtags, duplicate in another account. Unflagged videos go straight to *Ready to post* |
| **2. New videos from FYP references** | Add 1–5 reference videos you saved (with a rights tick). **Analyze format**: hook, beats, pacing, attention elements, audio, described as a format without the reference's people, brands or words. Choose **how many** original videos (default 3; never 10 unless you ask) → **Write original prompts**: new characters, setting and subject in the same format, avoiding earlier hooks. They land **queued** in Prompt Studio, ready for **I'm generating it in Flow** / the Flow pool. Templates in Prompt Studio still work as the other source |
| **AI-generated videos** | When a Prompt Studio prompt's video arrives (Flow download or provider), it joins the same queue as *AI-generated*, and its caption is written from the video plus the prompt it was made from |
| **3. Queue** | Tabs: To check / Ready to post / Posted / All. Each card: player, source, status, flags, editable caption and hashtags (**Save caption** marks it reviewed), **Caption is fine**, **Write caption again** (with an optional note), reject or restore |
| **Posting** | **Post on TikTok…** opens TikTok Studio's upload page in this account's window (its proxy and login), copies caption and hashtags, and shows the file in its folder to drag in. **You** post. **I posted it** (optional post link) records it; **undo** is available. The app never presses Post |
| **Today** | *posted today / daily target* (default 10, the existing per-account target, editable on *Ternak Akun today*). AI-generated posts also count there |

Statuses kept per video: source (ready-made / AI-generated), account, status (writing caption, check caption, ready, posted, rejected, no caption yet), caption and hashtags, edited-by-you, flags and duplicates, analysis error, posted time and link.

## Data (migration 10)

`post_queue` (unique per account and file hash), `fyp_references`, `analysis_settings`, `analysis_usage` (estimated cost per call). Videos reuse `generation_jobs` and the library, so the in-app player and "Show in folder" work unchanged. The key file is `userData/ai-secrets/gemini.sealed`.

## Tests

- Core `growth-media.test.ts`: answer validation (no caption without understanding), hashtag cleanup, flags, reference and variation validation, instructions (actual video only, no niche, originality), the FYP template rendering.
- `growth-queue.test.ts`: import (originals untouched, duplicates, non-videos, missing files), captions and the unclear flag, cross-account duplicate flag, review/post/undo, repetitive caption and re-analysis with a note, **real-provider path** (not configured → reason; key sealed, not plain text; budget stops the second call; retry), references → 3 original queued prompts → finished video joins the queue once with a caption → posting marks the prompt posted. **Gemini connection** against a mocked server: Files API upload, ACTIVE polling, `generateContent` with the file and JSON output, upload deleted, key only in a header.
- E2E `growth-queue.spec.ts`: choose 4 files (1 duplicate) → 2 captioned, 1 flagged and captioned by hand → **Post on TikTok…** opens the upload page through the account's proxy with the caption copied → **I posted it** (1/10) → reference → format → 2 original prompts in Prompt Studio → one produced → it appears in the queue, AI-generated, captioned. Screenshot `screenshots/06-posting-queue.png`.
- Totals: typecheck pass; unit 368 passed, 1 skipped; e2e 56 passed, 1 skipped (opt-in native dialog); secret scan clean.

## Not verified / limits

1. **Real Gemini calls haven't run.** The connection is built to Google's documented REST API and tested against a mock. The first real caption will show whether the model ID and answers are as expected. Pricing is your estimate; the app can't read Google's bill.
2. **Drag-and-drop** isn't covered by the automated test (Playwright can't drop real files); the same import path is tested through the file picker.
3. FYP references are files you supply. The app doesn't fetch or scrape TikTok.
4. Generating in Flow is still your click per prompt (supervised Flow helper not built yet).
5. Each video upload to Gemini counts as one call in the estimate, whatever its length.
