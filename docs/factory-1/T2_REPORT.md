# T2 Report: Ready to Post and the Daily Ternak Akun Board

**Date:** 2026-10-23 · **Status:** implemented and tested with synthetic data. Waiting for review.
**Builds on:** T1 (`T1_REPORT.md`). Two independent factories; Affiliate Factory untouched.

## 1. What was added

| Where | What it does |
|---|---|
| Prompt Studio → **4. Ready to post** | Every video-ready prompt of the account that you haven't marked as posted, oldest first: caption, **Show video**, **Copy caption** (clipboard), optional TikTok post link, **I posted it**. Below: **Recently posted (marked by you)** with **undo** |
| Prompt cards | A video-ready prompt shows "Posted (marked by you) …" once recorded |
| Dashboard → **Ternak Akun today** (shown when a growth account exists) | One row per Account Growth account (Affiliate accounts are not listed): **videos today / daily target** with a progress bar, posted today, ready to post, queued, generating, drafts and approved to review, editable **daily target** (default 10, 1–50), **Open Prompt Studio**. Totals on top |

**What the numbers mean (nothing is estimated or fetched from TikTok):**
- *Videos today*: videos that arrived in the account's library today on this computer's clock (provider jobs or Flow downloads), counted when they completed.
- *Posted today*: posts you marked today. The app does not publish, schedule, or check TikTok; a post link is only stored if you paste it (full `tiktok.com/@…/video/…` links only; short links refused).
- The Ready to post section reminds you to switch on TikTok's AI-generated content label when posting realistic AI video.

## 2. Data (migration 5)

`post_records` (one per prompt: job, optional post link and video id, time marked) and `production_targets` (daily video target per account). Logs record that a post was marked, never the link or caption.

## 3. Tests (synthetic only)

| Suite | Result |
|---|---|
| Typecheck | pass |
| Unit (vitest) | **319 passed** (2 new: posting rules — no video, bad link, once only, undo, no link in logs; board — growth accounts only, today's counts, targets, the next day starts at zero) |
| E2E (Electron, fuse on) | **51 passed, 1 skipped** (opt-in native dialog). New: T2 test in `apps/desktop/e2e/prompt-studio.spec.ts`; `security.spec.ts` updated for 5 new bridge methods |
| Secret scan | No secrets found |

## 4. Demonstration (synthetic)

1. Account Growth account → **Prompt Studio** → generate, approve, queue (T1 steps).
2. Make a video in that account's Google Flow window and download it there after pressing **I'm generating it in Flow** (in the automated tests the synthetic provider does this step).
3. **4. Ready to post** → **Copy caption** → post it yourself in TikTok → paste the post link (optional) → **I posted it**.
4. **← All accounts** → **Ternak Akun today**: the account shows 1/10 videos and 1 posted; change its target and save.

Screenshots: `screenshots/05-ready-to-post.png`, `screenshots/06-ternak-akun-today.png`.

## 5. Not in T2

Publishing or scheduling, reading anything from TikTok, real Flow automation, the navigation redesign, Affiliate Factory work.
