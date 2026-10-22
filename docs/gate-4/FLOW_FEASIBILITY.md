# Gate 4 Feasibility: automated Google Flow video for Account Growth

**Date:** 2026-10-22 · **Status:** assessment done; owner decision recorded (§5); manual interactive test **partly confirmed** (§6: T5 confirmed by the owner, others pending). No real-Flow automation code written; Claude has not used the owner's Google account.
**Sources:** read on 2026-10-22 from Google's public pages, signed out (links at the end). Claude never used the owner's Flow session.

## 1. Verdict

| Question | Answer |
|---|---|
| Is there an official Flow API? | **No.** Flow is a consumer web app (now at `flow.google.com`). Its help pages describe no API, scripting or bot use |
| Do Google's terms forbid automating it? | **Not explicitly.** The Terms of Service (effective 2026-07-30) forbid automated access that ignores machine-readable instructions, and `labs.google/robots.txt` allows everything except `/404`. They also forbid bypassing protective measures and interfering with services, and allow suspension for breaches |
| Does Flow actively guard against automation? | **Yes.** The page loads **reCAPTCHA Enterprise** (invisible risk scoring). The help center describes rate limits ("requesting generations too quickly") and "Unusual activity" blocks, and tells users to **disable VPNs or proxies** when blocked |
| Can it run unattended reliably? | **Unproven, and unlikely to stay reliable.** The UI changes without notice, risk scoring can block a session at any time, and challenges must never be solved by the app. Each of these stops the job and needs you |
| Is there an authorized programmatic route to the same model family? | **Yes: the Gemini API.** Veo 3.1 API models shut down **today (2026-10-22)**; the replacement is **Gemini Omni Flash** (`gemini-omni-1.1-flash`, Interactions API): 9:16, 720p–4K, audio, image-to-video, about **$0.10 per second** at 720p, no free tier, API key billing. No browser, cookies, proxy or CAPTCHA involved |

**Conclusion:**
- **Flow browser automation:** feasible to attempt as a **supervised, single-task proof of concept** with strict stop rules. It is not a dependable unattended production path.
- **Unattended generation:** the dependable route is the **authorized Gemini API** (paid per second).
- **Recommended structure:** one provider interface, and both behind it.

## 2. Specific risks for your setup
1. **Proxy conflict.** Every bundle's sessions go through its dedicated proxy (fail closed), while Flow's help treats proxies as a cause of "Unusual activity". A stable, consistent proxy IP per Google account is the least-bad option. Expect Google to challenge the session the first time it appears from the proxy IP (R-28).
2. **Imported Google cookies in Electron.** Your bundle's Flow session shows **Imported, not yet confirmed**. Google may reject imported sessions or embedded browsers (R-02). Changing the app's browser identity (user agent) to get past that would be evading a security control; **the app won't do that**.
3. **Credits.** Every generation spends your plan's AI credits (Veo 3.1 Lite: 10 credits for non-Ultra). Failed generations aren't charged. Automation must cap spending and never retry automatically.
4. **Downloads are blocked today.** Every platform partition blocks downloads by design. Saving a Flow MP4 needs a narrow, job-scoped exception.
5. **Content and data rules.** Flow and Gemini outputs fall under the Generative AI Prohibited Use Policy, carry SynthID watermarks, and Labs interactions may be reviewed by Google. Don't put confidential information in prompts.
6. **Account suspension.** The Labs FAQ says breaches may get an account suspended. It's your Google account, so the stop rules below are deliberately conservative.

## 3. Proposed milestone boundaries (to approve before coding)

**In scope**
- **A. Provider interface** in `packages/core`: `VideoGenerationProvider` (Gate 0 §20) with `submit`, `status`, `fetchOutput` and `cancel`, and a normalized request: prompt, aspect ratio (9:16), duration, quality tier, optional reference image. Normalized outcomes: `completed`, `waiting_for_user(reason)`, `quota_exhausted`, `policy_rejected`, `auth_required`, `interface_changed`, `transient`.
- **B. Growth creative settings per bundle:** saved prompt and video settings (non-secret, SQLite), editable in the account screen.
- **C. One generation job at a time per bundle.** States: `pending → running → completed | waiting_for_user | failed`. Every transition goes to an append-only, non-secret audit trail, including any required user intervention. No queue, no scheduler, no bulk.
- **D. Video library per bundle:** `library/<bundleId>/<jobId>.mp4` in the private data folder, with size, SHA-256 and the job record. MP4 only, with a size cap.
- **E. Synthetic Flow stand-in for automated tests:** a local Flow-like web app on the synthetic site with a prompt, generate, progress, download, a "challenge" page and a "quota" message. Tests drive the real orchestration through the bundle's proxy and partition: submission, progress, the download exception, library storage, and stopping at a challenge.
- **F. Flow browser provider, supervised PoC.** It's built in two steps because I can't see Flow's signed-in screens myself (I won't use your session):
  1. **Dry run:** the app opens Flow in the bundle's window, finds the prompt box, settings and Generate button by their visible labels, highlights them, and **does not submit**. You confirm it found the right controls.
  2. **One real task**, with you watching the visible window: fill the saved prompt, press Generate once, track progress, download the MP4 into the library, record the outcome.
- **G. Stop rules** (all enforced in the main process):
  - any CAPTCHA, challenge, "Unusual activity", sign-in page, rate-limit or quota message → stop at once, `waiting_for_user`; **never** solve, retry or work around;
  - one Generate press per job, no automatic retry;
  - a daily per-bundle cap you set (default 3);
  - downloads accepted only from Flow's domains, during an active job, MP4, under the size cap, into that bundle's library only;
  - browser identity unchanged (no user-agent spoofing or fingerprint changes);
  - no session or proxy sharing between bundles.
- **H. Optional authorized fallback:** `GeminiApiProvider` (Omni Flash), built only if you approve the paid API. The API key is stored DPAPI-sealed like proxy passwords.

**Out of scope (this milestone):** TikTok publishing, bulk or scheduled generation, unattended runs before the supervised PoC proves out, Kalodata research, anything that solves or evades CAPTCHAs or detection.

## 4. What I need from you before coding
1. **Gate (manual, about 5 minutes):** in UGC Production OS, open the account's **Google Flow → Open browser**, and check by eye:
   - are you signed in?
   - can you generate one short video by hand there?
   - does any "Unusual activity" or verification appear?

   If Google refuses the session or challenges it, browser automation through this setup is not viable, and the API route is the alternative.
2. **Decisions:**
   - Q1: build the Flow browser PoC (F) as proposed: dry run first, then one supervised task?
   - Q2: also build the authorized Gemini API provider (H) as the unattended path (paid, about $0.80 per 8-second 720p clip)?
   - Q3: daily cap per bundle (default 3).
   - Q4: library location (default `C:\ugc-private\ugc-userData\library`).

## 5. Owner decision (2026-10-22)
- **Google Flow stays the preferred production provider.** No paid Gemini API at this stage.
- **Goal:** use the existing Flow subscription with minimal daily intervention, only through the platform's permitted workflows.
- **Order:**
  1. Validate the interactive browser experience by hand first.
  2. Build the platform-independent generation interface with a synthetic provider. **Done (§7).**
  3. No automatic interaction with the real Flow website until permitted use and technical feasibility are established.
- **Not in this milestone:** bulk generation, TikTok posting, scheduled publishing.

## 6. Manual interactive test (owner-controlled): **partly confirmed**
The owner runs it alone in UGC Production OS. Claude reads no credentials, cookies, prompts or videos. Only the yes/no answers and codes below are recorded.

**Recording rule:** only results the owner reported directly are CONFIRMED. A result that is merely implied by another stays PENDING until reported.

**Owner report (2026-10-22):** "The real Google Flow manual validation succeeded in downloading an MP4 directly into the correct UGC Production OS account library."

| # | Check | Result |
|---|---|---|
| T1 | The Google Flow window opens through the account's proxy (Test Proxy passes; no "proxy not ready") | PENDING (implied by T5, not separately reported) |
| T2 | Signed in to Google in Flow, without signing in again | PENDING (implied by T5, not separately reported) |
| T3 | Any CAPTCHA, verification, "Unusual activity" or proxy warning? (if yes: stop; note the wording category only) | **PENDING: not reported** |
| T4 | One short video generated by hand in the normal Flow interface | PENDING (not separately reported; T5 shows an MP4 was obtained from Flow) |
| T5 | Downloaded MP4 appears in the account's Video library as "Downloaded from Flow · Saved" | **CONFIRMED by the owner** (real Google Flow, real account, correct account library) |
| T6 | After closing and reopening the app, Flow is still signed in | **PENDING: not reported** |
| T7 | Credits used for the one video (as Flow shows them), or "not noted" | PENDING: not reported |

Also observe: whether Flow tries to open pop-up windows (the app blocks pop-ups) and whether any step needed a page that didn't load.

## 7. Built in this milestone (synthetic-tested, no real-Flow automation)
- **Platform-independent interface** in `packages/core` (`VideoGenerationProvider`):
  - creative settings (prompt, aspect ratio, duration, quality) with validation;
  - a forward-only job lifecycle (`pending → running → completed | waiting_for_user | failed`);
  - normalized outcomes; challenge, sign-in, quota, rate limit and changed interface all mean "needs you";
  - an MP4 check.
- **Storage (SQLite migration 2):**
  - creative settings per account;
  - jobs with no prompt copy, no provider text and no page content;
  - an append-only event trail;
  - per-account video library `library/<accountId>/<jobId>.mp4` (written atomically, size and SHA-256 recorded).
- **Generation service:**
  - Account Growth accounts only, one job at a time, a daily cap of 3;
  - **no automatic retry**;
  - after a restart, interrupted jobs are closed as failed and never resumed;
  - the prompt never reaches the log.
- **Synthetic provider for tests:** covers success, every error outcome, a midway failure, invalid output and timeout. In real runs **no automated provider exists**; the screen says so and explains generating by hand.
- **The one download exception:** a video the owner downloads by hand **in an account's Google Flow window** is saved, without a dialog, into that account's library.
  - **Accepted only:** MP4 only, from Google's own domains, under 512 MB.
  - **After download:** the file must pass the MP4 check, or it is deleted. Interrupted downloads are deleted.
  - **Everything else stays blocked,** including every other platform and any non-MP4.
- **Google Flow home page** updated to `flow.google.com`.
- **UI:** "4 · Video generation (Account Growth)" with the creative brief, Generate one video (synthetic runs only), and the video library (state, size, plain-language outcome, Show in folder).
- **Tests (Windows, final run before commit):** typecheck clean; unit **237/237**; end-to-end **49/49 with the dev fuse ON and 49/49 with it OFF**; secret scan (all files and staged) clean. New end-to-end coverage: the UI generation flow, failure display, daily cap, Affiliate refused, manual Flow download through the proxy (MP4 saved; non-MP4 refused; fake MP4 deleted; TikTok session still blocked), and real mode showing no provider.
- **Git guard:** videos (`*.mp4`, `*.mov`, `*.webm`, partial downloads) and `library/` folders are ignored and blocked by the pre-commit hook. No video, account data, cookie or proxy credential is in the repository.

## 8. Next implementation decision (after §6)
| If the manual test shows | Then the next decision is |
|---|---|
| T1–T6 all pass, no challenge | Whether to approve a **supervised Flow browser provider** limited to: dry run first (find controls, highlight, no submit), then one owner-watched task per click, using the §3G stop rules. Unattended operation is only considered after a recorded run of supervised tasks with no challenges |
| A challenge, proxy warning or sign-in loop appears (T2/T3) | Flow automation through the proxied embedded browser is **not viable as tested**. Options: keep Flow **manual + library capture** (works today), or revisit the API route later |
| Generation works but download/library fails (T5) | Fix the download path (likely an unexpected media host); no automation decision until it works |
| The session doesn't survive restart (T6) | Flow sessions need re-login each run; affects any "minimal intervention" design |

## Sources
- [Google Terms of Service](https://policies.google.com/terms)
- [labs.google robots.txt](https://labs.google/robots.txt)
- [Get started with Google Flow](https://support.google.com/flow/answer/16353333?hl=en)
- [Manage your Google Flow credits](https://support.google.com/flow/answer/16526234?hl=en)
- [Where you can use Google Flow](https://support.google.com/flow/answer/16353544?hl=en)
- [Generative AI Additional Terms](https://policies.google.com/terms/generative-ai)
- [labs.google FAQ](https://labs.google/fx/faq)
- [Gemini API: video generation](https://ai.google.dev/gemini-api/docs/video)
- [Gemini API: Omni](https://ai.google.dev/gemini-api/docs/omni)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Flow public page `flow.google.com/about`: loads `www.google.com/recaptcha/enterprise.js` (observed signed out)
