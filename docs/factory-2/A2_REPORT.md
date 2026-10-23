# A2 Report: Affiliate Creative Studio, Clip A/B Production, FFmpeg Stitching, Review and Video Library

**Date:** 2026-10-23 · **Status:** implemented and tested with synthetic data. Waiting for review.
**Plan:** `A2_PROPOSAL.md`, approved with amendments (D29, D30). Not in A2: TikTok posting, Showcase or yellow-basket browser scripts, paid Veo or stitching services, any automatic Flow interaction.

## 1. The working interface

| Where | What it does |
|---|---|
| **Products → a product → Create videos** | Opens the Affiliate Creative Studio for that exact product. Shows what is missing if the product isn't ready (listing not confirmed in TikTok, no title, no verified features) |
| **Settings** (collapsible) | Characters (the four starters *ibu rumah tangga 30-an*, *mahasiswa kos*, *bapak ojol*, *karyawan kantoran* plus your own), reactors, POVs, hooks, comedic setups, locations, punchlines, style, "Avoid" list, hashtags, **Clip B continuity** (*Seamless*, *Comedic cut*, or *Mixed*), plans per batch (default 10). **Limits:** attempts per clip (default **3**, editable) and finished videos per product per day (default 10, editable). **No daily credit figure is built in** |
| **Generate N plans** | Offline, deterministic: each plan is a coordinated **Clip A (8 s)** and **Clip B (8 s)** prompt (English prompt, Indonesian dialogue) plus a caption. Comedic setup and product demo in A; payoff and punchline CTA ("cek keranjang kuning") in B. No two plans repeat; the product block (name as on the listing, verified features only) is identical in both clips |
| **Plan card** | Edit any section or the caption. Edits are re-checked: a missing product block, a changed character in a seamless plan, or an unverified claim (discount, "original", health…) **blocks approval**. **Approve plan** is required before anything goes to Flow |
| **Clip A / Clip B** | **Send to Flow** (to the Flow pool, or a chosen Flow account: a pool account or an account's own Flow session) copies the prompt and opens that account's Flow window; you generate and download there. **Copy prompt**, **Generation failed** (refused, render error, no output), **Unusable** (wrong product, artifacts, audio, continuity, off-script), **Import clip file…** (for a clip downloaded some other way), **Export last frame** (PNG of Clip A's last frame for a seamless Clip B, only offered, never forced) |
| **Automatic** | Each arriving clip is checked with ffprobe and a full decode (MP4, 6–10.5 s, video stream). A bad file becomes *Unusable (invalid clip)*. When both clips are in, the app **joins them with the local FFmpeg** and checks the result |
| **Final review** | In-app player, duration, resolution, size. **Approve video**, or **Reject** with a reason and which clip to redo (A, B or both). Only an approved video counts as finished |
| **Video library** (from the Dashboard or Products) | Every video with its product ID and title, Showcase state, continuity, each clip's Flow account, attempts and credits, players for the source clips and the final MP4, **Show in folder**, last rejection reason. Filters: all, waiting for review, approved, in production |
| **Today** strip | Attempts, failed renders, unusable outputs, approved clips and approved videos today, kept apart |

## 2. Output

H.264 (libx264, CRF 20, yuv420p, faststart) + AAC 160 kb/s, **1080×1920, 30 fps**, about 16 s. Each clip is scaled and padded to 9:16, resampled to 30 fps and 48 kHz; a silent clip gets silence so the join never fails on a missing track. The joined audio is loudness-normalised (EBU R128 `loudnorm`, −14 LUFS, −1.5 dBTP). FFmpeg runs locally (`UGC_FFMPEG_DIR`, `PATH`, or `C:\ffmpeg*\bin`) with argument arrays, never a shell. Finals are written to `library/<account>/finals/<video>-v<n>.mp4`; a redo writes a new version.

## 3. Credits and limits (per Flow account, not per TikTok account)

- A **Flow account** is any account with a Google Flow session: a Flow-pool account or an affiliate/growth account's own Flow session. Credits are charged to the Flow account whose window produced the download (`flow_credit_events`), never to the TikTok account.
- Each Flow account has its monthly allowance (F0) and now an optional **daily credit limit** (blank = none), set on the Flow pool screen. Accounts with their own Flow session are listed there too.
- **Send to Flow** refuses when the attempt limit for that clip is reached, when the product's daily video limit is reached, or when the chosen Flow account has no credits left for the month or day (the pool picks only accounts that can spend).
- Every hand-off counts an **attempt**; failed renders, unusable outputs, approved clips, failed joins and final approvals/rejections are separate events (`production_events`).

## 4. Data (migration 8)

- `affiliate_videos`: account, product row and exact product ID, batch and position, template key/version, settings and product facts used, reference-image flag, continuity, plan axes, Clip A/B sections, caption, flags, status (draft → approved → producing → stitching → review → final approved, or rejected), final file, metadata, SHA-256, review note.
- `affiliate_clips`: one per slot (A/B) with status (waiting, in Flow, received, unusable, approved), the Flow account used, the job (downloaded or imported file), attempts and credits.
- `production_events`, `generation_jobs.affiliate_clip_id`, `flow_pool_settings.daily_credit_limit`, `production_targets.max_clip_attempts` and `daily_videos_per_product`.
- The download claim now takes the oldest of a waiting Prompt Studio prompt or a waiting clip for that Flow window.

**Your real database is still at migration 7.** Migration 8 runs on the next normal start; it only adds tables and columns. The pre-shakedown backup is at `C:\ugc-private\backups\ugc-v2-before-shakedown-20261023-125832.db`.

## 5. Security

- The in-app player loads videos from `app://ui/media/job/<id>` and `app://ui/media/final/<id>`: ids only, resolved by the app to an MP4 inside the library; anything else is a 404. CSP adds `media-src 'self'` (header and the page's meta tag); `connect-src` stays `'none'`.
- Product reference images are only accepted with your rights confirmation (same rule as T1).
- No TikTok, Showcase or publishing code was added. Flow is only opened in its window; nothing in it is read or clicked by the app.

## 6. Tests (synthetic only: no Flow credits, no TikTok, no Showcase changes)

| Suite | Result |
|---|---|
| Typecheck | Pass |
| Unit (Vitest) | 349 passed, 1 skipped (the "FFmpeg not installed" placeholder) |
| Core: `affiliate-creative.test.ts` | Readiness; 10 distinct plans with product identity verbatim and verified features only; seamless / cut / mixed continuity; custom characters; edit flags; settings validation; clip and final checks; stitch arguments |
| **FFmpeg integration** (`apps/desktop/test/affiliate-studio.test.ts`, real FFmpeg on FFmpeg-made clips) | Vertical slice: product → plan → Clip A through a pool Flow window → Clip B imported → stitched **16.1 s, 1080×1920, 30 fps, H.264/AAC** → reject and redo → approve → library. Failed renders, invalid files, attempt and daily limits, Flow budget refusals, approval blocks |
| E2E (Playwright, fused Electron) | 54 passed, 1 skipped (opt-in native dialog). New `affiliate-studio.spec.ts`: the demo below |
| Secret scan | No secrets found |

**The demonstrated workflow** (`e2e/affiliate-studio.spec.ts`): a synthetic affiliate account and Flow pool account with a synthetic proxy; a product with a confirmed listing; 10 plans generated; plan 1 approved; Clip A sent to the pool's Flow window (prompt on the clipboard), where the synthetic "Flow" download is a fake MP4, counted as an attempt and 12 credits, then marked unusable automatically. Real clips are imported (Clip A 720×1280 24 fps with audio, Clip B silent colour bars); the app joins them to a 16 s 1080×1920 video, which plays in the app. Requests for other media paths are refused. The first cut is rejected (continuity, redo Clip B), a new Clip B is imported, and the second cut is approved. The library shows the product, Showcase state, attempts and the final; the pool account shows 1,038 credits left.

Screenshots: `screenshots/04-affiliate-plans.png`, `05-affiliate-review.png`, `06-affiliate-video-library.png` (02 and 03 refreshed by the existing tests for the new buttons and Flow-pool fields).

## 7. Remaining blockers and limits

1. **Not tried with a real Flow account.** Real Omni Flash downloads (file names, container, duration) have only been simulated. The first real run should be one plan, watched, before any batch.
2. **Credits are still an estimate** from downloads made through the app (F0). Generations outside the app, failed generations Google still charges for, or a different model or length need a balance correction from Flow's own counter.
3. **Prompt quality is unproven.** The plans are deterministic templates; whether Omni Flash keeps the product identical across two separate generations, and whether the comedy lands, can only be judged on real output. Settings are editable for that reason.
4. **Seamless continuity is manual:** the app exports Clip A's last frame, but you upload it to Flow yourself.
5. **Product reference images** depend on your rights confirmation per image; none were used in tests.
6. **3 products × 10 videos** is supported by the limits and library, but there is no bulk generation; each clip is sent to Flow by you.
7. **Migration 8 on your real database** happens on the next start (backup in §4).
8. Posting, Showcase confirmation in TikTok and the yellow basket stay manual (out of A2 scope).
