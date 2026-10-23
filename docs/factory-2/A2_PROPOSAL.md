# A2 Proposal: Affiliate Creative Studio, Clip A/B Production, FFmpeg Stitching, Review and Video Library

**Date:** 2026-10-23 · **Status:** proposal for approval. Nothing implemented.
**Decisions applied:** local FFmpeg for joining clips (no paid service); Google Flow subscriptions stay the generation method (no Veo API); English Flow interface, Indonesian UGC; factories stay independent (D29, recorded on approval).
**Not in A2:** TikTok posting, Showcase browser scripts, yellow-basket linking, paid Veo, any automatic Flow interaction.

## 1. The vertical slice

```
Affiliate product (A1: listing confirmed, verified features)
  → Affiliate Creative Studio: generate N finished-video plans; each plan = Clip A prompt + Clip B prompt
  → approve plan
  → Clip A: Copy prompt → Flow (own window or Flow pool) → you generate and download   ┐ manual in Flow,
  → Clip B: same (optionally starting from Clip A's last frame, exported by the app)   ┘ your credits
  → clips arrive by download claim or "Import clip file…"; each clip validated
  → automatic FFmpeg stitch → ~16 s MP4 → automatic validation
  → your review (in-app player): approve, or reject with a reason and redo a clip
  → Affiliate Video Library: product, account, Clip A, Clip B, final, status, attempts, credits
```

Automatic: plan writing (offline templates), clip validation, stitching, output validation, linking, counting. Manual: everything inside Flow, and the final quality decision.

## 2. Creative model (Indonesian direct-selling comedy)

A new template **kind, `clip_pair`**, on the existing T1 engine (versioned, editable, duplicable). The starter **"Komedi Jualan 2×8 detik"** has three blocks:

| Block | Content | Rule |
|---|---|---|
| **Continuity** (in both prompts, word for word) | Character (look, age, wardrobe), environment, lighting, camera style, **product appearance** (name exactly as on the listing, colour/shape you verified), aspect 9:16 | Checked after edits like T1's consistency blocks; blocks approval if changed |
| **Clip A (8 s)** | Visual hook in the first second, comedic setup (a relatable problem), first product feature shown working, Indonesian dialogue (~15–20 words) | Features only from the product's **verified features** (A1) |
| **Clip B (8 s)** | Continues the same moment (same character, wardrobe, place, product), second feature or payoff, **punchline + CTA** in Indonesian (e.g. pointing down, "cek keranjang kuning") | CTA wording only; the actual yellow-basket link stays manual in TikTok |

**Variation per finished video** (planned like T1: no repeats, ≥2 differences per pair): character (account-editable pool, e.g. *ibu rumah tangga 30-an*, *mahasiswa kos*, *bapak ojol*, *karyawan kantoran*), POV (selfie talking, over-the-shoulder demo, reaction cut), hook type, comedic setup, location, feature focus, punchline style. **Product identity never varies.**

**Accuracy guard (deterministic):**
- prompts only mention features from the verified list;
- no price, discount, "original", health or performance claims unless typed in the product sheet;
- the product name appears verbatim in both clips;
- an "Avoid" block (no other brands, no text overlays unless chosen, no fake reviews or testimonials).

**Continuity aids (manual in Flow, prepared by the app):**
- **Product image** (a file you confirm you may use) listed as an ingredient to upload in both clips.
- **"Export Clip A's last frame"**: FFmpeg saves the final frame as a PNG, which you use as Clip B's starting frame in Flow (frames-to-video). Marked as a manual step.

## 3. Production tracking, failures and limits

| Event | Recorded as | Effect |
|---|---|---|
| Flow refused, failed or produced nothing (you press **Flow failed** on the clip) | **generation failure** (reason: refused / error / timeout / other) | Attempt +1; clip back to waiting |
| Clip file arrived but unusable (wrong product, artifacts, no audio, continuity) | **unusable output** (reason) | Attempt +1; credits counted; clip back to waiting |
| Stitch or validation failed | **stitch failure** (code) | Shown with the reason; re-stitch after fixing |
| Final rejected at review | **unusable output** on the chosen clip(s) | Those clips redone |

**Limits (configurable per affiliate account):**
- **attempts per clip** (default 3);
- **credits per day** (default 720 = 30 videos × 2 clips × 12);
- **finished videos per product per day** (default 10).

When a limit is reached, the hand-off buttons are disabled and say why. Credits are counted when a clip file arrives, using the Flow pool's credits per clip (default 12). Failures and unusable outputs are counted separately per day, product and account.

## 4. FFmpeg stitching and validation

- **FFmpeg location:** auto-detected on PATH or a configured folder (your machine has `C:\ffmpeg_2\bin`). The version is shown; it isn't bundled or downloaded. Run as a child process with argument arrays (no shell), only on files inside the account library, with a timeout.
- **Clip validation (ffprobe):**
  - one video stream (and audio, warned if missing);
  - 6–10 s long;
  - decodable;
  - resolution and frame rate recorded.
- **Stitch:**
  - each clip is scaled/padded to the output size (default 1080×1920, 30 fps);
  - optional trim of a few hundred ms at the start/end of each clip;
  - audio loudness-normalised (default −14 LUFS, true peak −1.5 dB); silence added for a clip without audio;
  - concat filter (re-encode, so mismatched clips still join);
  - H.264 yuv420p + AAC, fast start.
- **Output validation:**
  - duration about 16 s (12–20 s accepted, configurable);
  - both streams present;
  - full decode pass without errors;
  - SHA-256 and metadata stored.
- **Files:** clips in `library/<account>/clips/`, finals in `library/<account>/finals/`, last-frame PNGs in `library/<account>/frames/`. Nothing is overwritten: a re-stitch creates a new file and keeps the old one until you approve.

## 5. Screens

1. **Products → Create videos** (per selected product): Affiliate Creative Studio. Template and settings (character pool, POVs, number of videos; default 10, a slice can use 1), generate plans, Clip A/B text side by side, flags, Edit, Regenerate, Approve.
2. **Production queue** (same screen):
   - per plan, Clip A and Clip B cards with **Copy prompt**, **Generate in Flow pool**, **I'm generating it in Flow**, **Import clip file…**, **Flow failed**, **Export last frame**;
   - the attempt and credit counters;
   - **Stitch** (runs automatically when both clips are present).
3. **Affiliate Video Library** (new section on Affiliate accounts, and a per-account screen):
   - one row per finished video: product (title, ID), account, Clip A, Clip B, final, duration, status, attempts, credits;
   - **in-app player** for clips and final (served read-only from the account library through a restricted app protocol);
   - **Approve final** / **Reject** (reason, choose clip to redo), **Show in folder**.

Approved finals are listed as "ready to post" with the product link to attach by hand. The posting plan (5 windows × 6) is the next milestone, not A2.

## 6. Data (migration 8)

| Table / column | Purpose |
|---|---|
| `affiliate_videos` | One finished-video plan: account, product, batch, position, template and version, variation, Clip A/B content, caption, status (`draft` → `approved` → `producing` → `stitching` → `review` → `final_approved` / `final_rejected`), final file and metadata, review note |
| `affiliate_clips` | Clip A or B of a video: status (`waiting` / `in_flow` / `received` / `unusable`), Flow account used, job (file), attempts, credits |
| `production_events` | Separate log of generation failures, unusable outputs, stitch failures (account, product, video, clip, reason, credits, time) |
| `affiliate_limits` (or JSON on `production_targets`) | Attempts per clip, credits per day, videos per product per day |
| `generation_jobs.affiliate_clip_id` | Links a downloaded or imported file to its clip |

The download claim (T1/F0) is extended so a Flow window's next download goes to the oldest waiting **prompt or clip** sent to that window.

## 7. Batch readiness

Plans are generated per product (default 10). Three selected products give 30 plans per account per day. Counters and limits are per account, product and day, so later batch work (helper or scheduling) can use the same records. A2 itself stays one-video-at-a-time in Flow.

## 8. Tests (synthetic only, no credits)

- **Unit:**
  - clip-pair template validation and continuity check;
  - accuracy guard (unverified feature or claim → flagged);
  - plan diversity;
  - FFmpeg argument building and ffprobe parsing;
  - limits and counters;
  - failure vs unusable accounting;
  - claim routing for clips.
- **Integration (real FFmpeg on synthetic clips):**
  - the test generates two 8-second clips with FFmpeg's built-in test patterns (one with audio, one silent, different resolution);
  - stitches them; checks duration about 16 s, both streams and a clean decode;
  - checks last-frame export.
  - Skipped with an explicit reason if FFmpeg isn't installed.
- **E2E (Electron):** synthetic affiliate account and product → Create videos → approve one plan → Clip A received via the synthetic Flow download, Clip B via **Import clip file…** → automatic stitch → in-app player shows the final → reject with "continuity" → redo Clip B → approve → library row shows product, account, both clips, final, attempts 3, credits counted.
- **Isolation and security:** files only inside the account library; the media protocol refuses paths outside it; the bridge list is updated; no prompt or product text in logs.

## 9. Delivery steps (one milestone, reported together)

| Step | Delivers |
|---|---|
| A2a | `clip_pair` template kind, starter "Komedi Jualan 2×8 detik", accuracy guard, plan generation for a product |
| A2b | Migration 8, clip hand-off (own Flow / pool), claim routing, Import clip file, failure/unusable events, limits |
| A2c | FFmpeg locator, clip validation, stitch, output validation, last-frame export |
| A2d | Affiliate Video Library, media protocol, in-app player, review approve/reject/redo |
| A2e | Tests, report, synthetic demo, commit and push |

## 10. Decisions needed

1. **Output format:** 1080×1920, 30 fps, H.264/AAC, −14 LUFS: agreed?
2. **Defaults:** 3 attempts per clip; 720 credits per account per day; 10 videos per product per day: agreed?
3. **Character pool:** start with the four examples in §2 (you edit per account)?
4. **Product image** as a Flow ingredient: OK to require your confirmation that you may use it (e.g. listing images provided for affiliates)?
5. **Clip B from Clip A's last frame** (frames-to-video in Flow) as the default continuity method, with "independent Clip B" as the alternative?
