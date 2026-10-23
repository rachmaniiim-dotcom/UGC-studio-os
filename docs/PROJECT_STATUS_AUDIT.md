# UGC Production OS — Project Status Audit

**Date:** 2026-10-23 · **Branch:** `ccr-aecbb29a-dleiwi` · **Commit audited:** `fa868c4` (working tree clean; local = remote)
**Method:** read the current code (not earlier reports), ran every available check, launched the built app in a **separate temporary synthetic profile** to capture screens. No live TikTok, Kalodata or Flow action, no credits spent, no real data, cookies, proxy credentials or sessions touched. The only access to your real data folder was a read-only query of its schema version (§6.4).

Legend used throughout:
**WORKING** implemented and verified · **PARTIAL** some parts missing · **MANUAL** you do it by hand (the app assists) · **MOCK/SYNTHETIC** only works with fake data or the test provider · **NOT BUILT** · **BLOCKED** needs an external authorization, dependency or technical answer.
"Verified" below means verified by automated tests on synthetic stand-ins **unless it says "verified on your real account"**. Only three things have ever been verified on a real account (§6.4).

---

## 1. Executive summary

UGC Production OS is a Windows desktop app that keeps many TikTok-related accounts **isolated from each other**: each account has its own proxy and its own encrypted browser sessions (TikTok, Google Flow, Kalodata, Shopee), set up by importing Cookie-Editor JSON or logging in inside the app.

On top of that it has **planning and tracking tools**, not production automation:
- **Ternak Akun:** Prompt Studio writes complete, distinct Google Flow prompts from templates; you generate the videos **by hand in Google Flow** inside the account's window; downloaded videos are saved to the right account and linked to their prompt; a "Ready to post" list and a daily board track progress; **you post by hand**.
- **Affiliate Factory:** you collect product IDs (pasted, or from the Kalodata window's address), pick today's 3, check the listing, and add them to the Showcase **by hand on TikTok's own page**, then confirm in the app. **Nothing after that is built for Affiliate**: no product videos, no 2-clip stitching, no yellow-basket linking, no posting plan.
- **Flow pool:** several Google accounts can supply Flow credits; the app tracks an estimated balance and routes downloads back to the right account.

**Nothing is published, scheduled, generated or clicked automatically on TikTok, Kalodata or Google Flow.** The only automatic video generation is a synthetic test provider. And **only the Gate 2–4 basics (session import/login, a real Flow download into the library) have been confirmed on your real accounts**; everything built since (Prompt Studio, board, Affiliate Products, Flow pool, Growth Intelligence) has only run against synthetic data. Your real data folder has not been opened by any version newer than Gate 4.

---

## 2. Feature inventory (verified against the code)

| # | Feature | Status | What you can do today | Real accounts/data? | Missing | Evidence |
|---|---|---|---|---|---|---|
| 1 | Account Bundles (add/edit, name, mode) | WORKING | Create accounts as **Account Growth (Ternak Akun)**, **Affiliate UGC** or **Flow pool**; rename; switch between the two factory modes | Built for real use; not yet run on your real profile in this version | Delete account | `profiles.ts` (BundleStore), `ipc.ts accounts:*`, `AccountEditor.tsx`; e2e `accounts-ui.spec.ts` |
| 2 | Dedicated proxy per account | WORKING (synthetic); real proxy **not yet validated** | HTTP/HTTPS/SOCKS5 proxy per account, password sealed with Windows DPAPI, **Test Proxy** shows the exit IP; every site window refuses to open until the proxy passed in this run (fail closed) | Real proxies never tested by you (Gate 3 report §"Real proxy validation: not done") | Real-proxy check | `proxy.ts`; e2e `proxy-isolation.spec.ts` |
| 3 | Isolated sessions (TikTok, Google Flow, Kalodata, Shopee) | WORKING | One persistent, encrypted browser partition per account and platform; no sharing; WebRTC leak blocked; navigation limited to the platform's domains | Kalodata session **verified on your real account** (Gate 2 E3) | — | `sessions.ts`, `windows.ts`; e2e `isolation.spec.ts`, `security.spec.ts` |
| 4 | Cookie-Editor JSON import (paste or file) | WORKING | Import per session; report of imported/skipped cookies; refuses if cookie encryption is off | **Verified on your real Kalodata account** (Gate 2) | — | `core/cookies/import.ts`; e2e `import.spec.ts` |
| 5 | Session restore after restart (session cookies) | WORKING (synthetic); real restart **PENDING** | Session cookies re-sealed on every change and restored at start | Gate 2 E4 and Flow T6 (still logged in after restart) **not confirmed** by you | Your check | `session-sync.ts`; e2e `session-sync.spec.ts`, `persistence.spec.ts` |
| 6 | Session status (logged in / out) | MANUAL | You open the window and press "I'm logged in / logged out"; real platforms are never probed (their terms) | Yes | — | `status.ts`; e2e `platform-status.spec.ts` |
| 7 | Local security check | WORKING | `pnpm security-check` scans folders for leaked cookie values | Yes (run on real folders in Gate 2) | — | `security-check.ts`; e2e `security-check.spec.ts` |
| 8 | Video generation framework | MOCK/SYNTHETIC | Jobs, daily cap, "needs you" outcomes; **only a synthetic test provider** generates. In normal use there is **no** automatic provider ("Automated Google Flow generation is not enabled") | No | A real provider (Flow automation or Veo API) | `generation.ts`, `main.ts:108` (`provider: config.synthetic ? … : null`) |
| 9 | Manual Flow download → account library | WORKING / MANUAL | Download an MP4 in an account's Flow window: saved to that account's library (MP4 check, 512 MB cap) | **Verified on your real Flow account** (Gate 4 T5) | — | `downloads.ts`; e2e `generation.spec.ts` |
| 10 | Video library UI | PARTIAL | List, state, "Show in folder", "from a Prompt Studio prompt" — **only on Ternak Akun accounts** | Ternak: yes (T5) | **No video list for Affiliate accounts** (their Flow downloads are saved but not shown); no preview/review/"unusable" marking | `AccountEditor.tsx:90`, `VideoSection.tsx` |
| 11 | Prompt Studio: starter templates (ASMR, Grandma, Dance) | WORKING | Choose a template; complete ~1,700–2,500-character Flow prompts | Prompts are real text you can use; app not yet run on your real profile | — | `core/templates/starters.ts`; tests `templates.test.ts` |
| 12 | Custom master templates (duplicate/edit/versions) | WORKING | Duplicate a starter, edit sections/variables/lists, save as v2, v3… | Same | — | `TemplateEditor.tsx`, `prompt-studio.ts saveTemplate` |
| 13 | Character/world consistency | WORKING | Character/world/style text copied word-for-word into every prompt; edits that break it block approval; reusable presets | Same | — | `engine.ts contentFlags` |
| 14 | Prompt diversity / near-duplicates | WORKING | 10 distinct combinations, ≥2 differences per pair, near-duplicate flags, recent combinations avoided | Same | — | `engine.ts planVariations/nearDuplicates` |
| 15 | Prompt approval & production statuses | WORKING | Draft → Approved → Queued → Generating → Video ready (only a real file makes it "ready"); edit, regenerate, reject | Same | — | `core/templates/model.ts PROMPT_ACTIONS` |
| 16 | Getting prompts into Flow | MANUAL | **Copy prompt for Flow**, then "I'm generating it in Flow" (own session) or **Generate in Flow pool**; you paste and generate in Flow yourself | Flow itself: yes (T5); this flow: not yet on your profile | Automatic submission (BLOCKED, §8) | `PromptStudio.tsx` |
| 17 | Linking downloads to prompts | WORKING / MANUAL | The next download in that Flow window is linked automatically; or link a library video by hand | Not yet on your profile | — | `prompt-studio.ts claimManualPrompt/linkVideo` |
| 18 | Reference files for templates | WORKING (local) / MANUAL in Flow | Attach your own image/video (rights checkbox); prompts list the manual Flow step; motion references marked "no verified Flow control" | Same | Flow-side use is manual | `prompt-studio.ts addReference` |
| 19 | Ready to post + "I posted it" | MANUAL | Copy caption, show file, record that you posted (optional post link) | Not yet on your profile | Posting itself | `PromptStudio.tsx ReadyToPost` |
| 20 | Ternak Akun today board | WORKING (counts only) | Per growth account: videos today vs target (default 10), posted today, ready, queued, generating, to review | Same | — | `ProductionBoard.tsx`, `prompt-studio.ts board()` |
| 21 | Growth Intelligence (optional research) | WORKING (owner-entered data) | Strategy, thresholds, reference creators, manual/CSV reference metrics, creator-median outlier scoring, shortlist | Data is whatever you type/import | Creative-DNA analysis (R3/R4, on hold) | `growth.ts`, `core/research/*` |
| 22 | Affiliate: product capture | MANUAL (one click) | Paste TikTok product links/IDs, or **Use the product open in Kalodata** (reads only the window's address) | Not yet on your profile; **Kalodata address format unverified (V3)** | Kalodata list import (deliberately excluded) | `affiliate.ts`, `core/affiliate/product.ts` |
| 23 | Affiliate: today's 3 products | WORKING | Select up to the daily limit (default 3), resets daily | Same | — | `affiliate.ts select` |
| 24 | Affiliate: listing check & product sheet | MANUAL | Open product in the account's TikTok window; confirm exact listing; type price, commission, shop, verified features, reference video links; rule-based summary | Same | Descriptions/assets are typed, not fetched; no asset storage per product | `AffiliateProducts.tsx` |
| 25 | Add to Showcase | MANUAL (assisted) | App opens TikTok's Showcase page in the account's window with the product link on the clipboard; **you add it with TikTok's controls**; you confirm "TikTok shows it in my Showcase" | **Never tried on a real account**; how the real page adds a product (paste/search) is unverified (V2 detail) | Official API provider (BLOCKED, §8) | `ipc.ts affiliate:open-showcase` |
| 26 | Affiliate product videos (prompts, 2×8 s clips, stitching) | NOT BUILT | Prompt Studio **refuses** Affiliate accounts; no 2-clip structure; no stitching | — | A2 | `prompt-studio.ts:243` |
| 27 | Yellow-basket product link on posts | NOT BUILT / BLOCKED | — | — | Manual in TikTok, or Post Shoppable Video API (approval-gated) | no code |
| 28 | Scheduling / posting windows / publishing | NOT BUILT / BLOCKED | — | — | Scheduler, posting plan; publishing needs TikTok authorization | grep: no publish/schedule code |
| 29 | Flow pool | WORKING (estimates) | Flow-only Google accounts with own proxy/session; credit estimate per account (1,050/12 defaults), corrections, auto-pick, downloads routed to the prompt's account | Not yet on your profile | Manual pool choice; unclaimed downloads stay in pool library | `flow-pool.ts`, `FlowPool.tsx` |
| 30 | Flow render failures / unusable outputs / retry caps | NOT BUILT | Only failed **downloads** are recorded | — | Per-video failure/unusable marking, retry and credit caps per product | — |
| 31 | Supervised Flow helper | NOT BUILT (proposal; risk accepted D26) | — | — | Q1–Q4 answers, implementation | `docs/gate-4/SUPERVISED_FLOW_HELPER_PROPOSAL.md` |
| 32 | AI analysis/generation provider | NOT BUILT (by decision) | Deterministic template engine only; provider interface exists | — | A real LLM, if wanted | `core/templates/provider.ts` |
| 34 | Older single-prompt "Video generation" section (Gate 4) in the Ternak account editor | MOCK/SYNTHETIC | One saved prompt + **Generate one video**: only works with the test provider; in normal use the button is disabled | — | Superseded by Prompt Studio | `VideoSection.tsx`, screenshot 08 |
| 33 | Packaged installer | NOT BUILT | Started with `node apps/desktop/scripts/run-app.mjs` (data in `C:\ugc-private\ugc-userData`) | — | Installer, production fuse set (V-02) | `run-app.mjs` |

---

## 3. How the app works today (step by step, for a non-technical owner)

**Start:** in a terminal in the project folder run `node apps/desktop/scripts/run-app.mjs`. It refuses to start unless cookie encryption is on and the data folder is private. *(Manual; no installer yet.)*
**Before the first start of this version:** copy `C:\ugc-private\ugc-userData\ugc.db` somewhere safe. The app will upgrade it from version 2 to 7 on start (§6.4).

### 3.1 Account setup (all manual, one-time per account)
1. Dashboard → **+ Add account** → display name → mode: **Account Growth (Ternak Akun)**, **Affiliate UGC** or **Flow pool** → **Save draft**. *(Works.)*
2. **Proxy**: protocol, host, port, username/password → **Save proxy** → **Test Proxy**: shows the exit IP. Every window refuses to open until this passes in the current run. *(Works on synthetic; your real proxies untested.)*
3. **Sessions**: for each platform (TikTok, Google Flow, Kalodata, Shopee; a Flow pool account has only Google Flow) paste the Cookie-Editor JSON or choose the file → import report. Or open the window and log in there. *(Works; verified on your real Kalodata in Gate 2.)*
4. **Open** a session window; check you're logged in; press **I'm logged in**. *(Manual by design.)*
5. Close and reopen the app: sessions are restored from encrypted snapshots. *(Works in tests; please confirm on a real account: E4/T6 pending.)*

### 3.2 Factory 1 — Ternak Akun
| Step | Buttons / screen | Status |
|---|---|---|
| Select account | Dashboard row → **Prompt Studio** | Works |
| Choose template | ASMR / Grandma Messages / Trending Dance → **Use** | Works |
| Custom template | **Duplicate** → **Edit** → **Save new version** | Works |
| Configure | Character/world/style, lists, number (10), aspect, duration, hashtags, reference files → **Save settings** | Works |
| Generate & approve | **Generate 10 prompts** → per prompt Edit / Regenerate / Reject / **Approve prompt**, or **Approve all unflagged drafts** | Works (automatic text generation, offline) |
| Queue | **Queue for generation** / **Queue all approved** | Works |
| Generate the video | **Copy prompt for Flow** + **I'm generating it in Flow** (account's own Flow window) or **Generate in Flow pool** (opens the pool account's Flow window, prompt on clipboard) → **you paste, generate and download in Flow** | **Manual** (Flow is not automated) |
| Link video to prompt | Automatic on download in that Flow window; or "Link a video already in the library…" | Works (automatic linking) |
| Review video | **Show video in folder** (opens Explorer); no in-app player, no "unusable" marking | Partial |
| Ready to post | Section **4. Ready to post** → **Copy caption** → post in TikTok yourself → paste post link (optional) → **I posted it** | **Manual posting**; recording works |
| Daily board | Dashboard → **Ternak Akun today**: videos today/10, posted, ready, queued, target editable | Works (counts what the app saw) |

Automated in Factory 1 today: prompt text generation, duplicate checks, routing/linking of downloads, counters. Everything that touches Flow or TikTok is done by you.

### 3.3 Factory 2 — Affiliate Factory
| Step | What you do | Status |
|---|---|---|
| Open account | Dashboard row → **Products** | Works |
| Open Kalodata | **Open Kalodata** (account's isolated session and proxy) | Works (real Kalodata session verified in Gate 2) |
| Research & filters (yesterday's sales > 0, < 50 creators, growth > 30 %) | You apply them **inside Kalodata** | **Manual**; the app has no filter settings and stores no Kalodata data (by decision, Kalodata §14) |
| Select 3 products | **Use the product open in Kalodata** (reads the address) or paste product links → **Select for today** | Works; real Kalodata address format **unverified (V3)** |
| Product summaries | Rule-based line from what you type | Partial (no automatic descriptions) |
| Add to actual Showcase | **Add to Showcase** → TikTok's Showcase page opens in the account's window, link on clipboard → **you add it** → **TikTok shows it in my Showcase** | **Manual (assisted)**; never tried on a real account |
| Confirm membership | Your confirmation of TikTok's list | Manual (app cannot see it) |
| Descriptions & reference assets | Type verified features; paste reference video links | Manual; no product asset storage |
| Analyse sales-driving videos | — | **Not built** |
| Product sheets | Facts + verified features per product | Partial |
| Product-specific UGC (2×8 s, Indonesian comedy) | — | **Not built** (Prompt Studio refuses Affiliate accounts) |
| Associate videos with product | — | **Not built** |
| Yellow basket | — | **Not built / blocked** |
| Schedule / publish | — | **Not built / blocked** |

---

## 4. Requirements vs current implementation

| Requirement | Implemented | Gap |
|---|---|---|
| **F1** independent from Affiliate | Yes (separate modes, screens and gates) | — |
| F1 reusable broad-niche templates; ASMR/Grandma/Dance starters | Yes | — |
| F1 custom templates; character/world consistency | Yes | — |
| F1 default 10 videos/account/day | Target 10 on board and prompt count 10 | Production is manual Flow work |
| F1 optional reference-video analysis | Growth Intelligence (owner-entered metrics, outlier scoring) | No creative/visual analysis (R3/R4 on hold) |
| F1 no mandatory graduation | Yes (none exists) | — |
| **F2** affiliate accounts enter directly | Yes | — |
| F2 3 products/account/day | Yes (daily selection, limit 3) | — |
| F2 10 finished videos/product, 30/account/day | **No** | Product prompts, generation, library for affiliate |
| F2 each video = two coordinated 8 s clips stitched to ~16 s | **No** | Two-clip prompts, local stitching |
| F2 Indonesian direct-selling comedy (hook, feature demo, setup, punchline CTA); varied characters/POVs; consistent product identity | **No** | Affiliate template family, product variables |
| F2 account-specific Showcase | Assisted manual flow + states | Real-page check; API provider blocked |
| F2 yellow-basket association | **No** | Manual in TikTok or gated API |
| Posting windows 08–10, 12–13, 15–16, 18–19, 21–22 WIB; 6 posts/window, 2 per product | **No** | Posting plan/queue per window; publishing itself blocked |
| Flow render failures and unusable outputs tracked separately | **No** (only failed downloads) | Per-video outcome marking |
| Credit and retry caps | Partial: pool credit estimate; synthetic provider daily cap 3 | Per-product/account credit budget, retry cap for Flow |

*Note: earlier docs (`TWO_FACTORY_ARCHITECTURE.md`) list affiliate posting as "12 videos in 4 × 3 batches"; your current requirement (30 posts in 5 windows) supersedes it and isn't implemented either way.*

---

## 5. Gap analysis and roadmap

### A. Factory 1 (essential)
| Item | Priority | Depends on | Smallest next milestone | Acceptance |
|---|---|---|---|---|
| Real-profile run of T1/T2/F0 | **critical** | your DB backup | You start the current app on your real profile and run one prompt → Flow → download → Ready to post | One real video linked to its prompt and recorded as posted |
| Video review: in-app preview, "usable / unusable" mark | high | — | Mark a downloaded video unusable (reason) and send its prompt back to the queue | Unusable videos excluded from Ready to post and board counts |
| Flow generation help (supervised helper) | high | Q1–Q4 | Helper types the prompt and presses Generate once, in a pool window, while you watch | One supervised job ends with the MP4 in the right library |

### B. Factory 2 (essential)
| Item | Priority | Depends on | Smallest next milestone | Acceptance |
|---|---|---|---|---|
| Affiliate video library | **critical** | — | Show the Video list for Affiliate accounts | Flow downloads visible per affiliate account |
| A2 product prompts: 2 × 8 s clip pairs, Indonesian comedy, verified features only | **critical** | A1 product facts; template engine | Affiliate template family + Prompt Studio for Affiliate accounts, per product | 10 distinct clip-pair prompts per selected product, product facts verbatim, no unverified claims |
| Clip pairing + local stitching (~16 s) | **critical** | A2; a local video tool | Link two downloaded clips to one video and stitch them on the PC | One 16 s MP4 in the library linked to product and prompt |
| Video ↔ product association | high | A2 | Each finished video carries its product ID | Ready-to-post shows the product link to attach |
| Posting plan (5 windows × 6, 2 per product) | high | A2 | A daily plan per account with slots; manual posting and "posted" record | 30 slots filled from ready videos, recorded as posted by hand |
| Showcase real-page check | high | you | Try the assisted flow on one real account | Product visible in Showcase, state confirmed |

### C. Shared infrastructure
| Item | Priority | Smallest milestone | Acceptance |
|---|---|---|---|
| Render-failure / unusable tracking, credit and retry caps | high | Outcome per video + per-day credit budget per pool | Board shows failures separately; generation refused when budget exhausted |
| Manual pool choice; moving unclaimed pool downloads | medium | Dropdown + "assign to prompt" | — |
| Installer and production fuses (V-02) | medium | Package once | App starts without a terminal |
| HTTP cache clearing on exit (R-31) | medium | Clear cache on quit | Security check clean after use |

### D. External integrations needing verification or authorization
| Item | Status | Needed |
|---|---|---|
| Google Flow automation | BLOCKED by decision until supervised helper is approved (risk accepted D26; Q1–Q4 open) | Your answers; possible CAPTCHA/"unusual activity" stops it |
| Veo via Gemini API / Vertex | Not evaluated | Cost comparison at 60 clips/account/day |
| TikTok Showcase API, Post Shoppable Video API | BLOCKED (approval-gated: company ≥ 1 year, track record) | Partner Center application or an approved partner |
| TikTok posting/scheduling via web automation | Not permitted (TikTok Terms §5) | — |
| Kalodata list import / AI use | BLOCKED (Kalodata §14.3/14.5/14.6) | Written permission or enterprise agreement |

### E. Can wait
Growth Intelligence R3/R4 creative analysis; LLM provider; navigation redesign (Overview/tabs); Shopee.

### Critical paths
1. **One finished Ternak Akun video (real):** back up DB → start app → account with proxy + Flow session → Prompt Studio → approve → Copy prompt → generate in Flow → download → Video ready → post → I posted it. *All exists; only needs your real run (manual Flow and TikTok steps).*
2. **One finished 16 s Affiliate video with a verified Showcase product:** A1 real check (Showcase) → **affiliate video library** → **A2 clip-pair prompts** → generate two clips in Flow → **stitch** → associate with product → post with yellow basket **by hand** in TikTok. *Bold items are not built.*
3. **Scale to daily batches:** generation is the bottleneck (60 Flow clips/affiliate account/day ≈ 21 Google AI Pro accounts per account per month; F0 math) → supervised helper or Veo API → posting plan; publishing stays manual unless TikTok authorizes an API.

---

## 6. Tests and security (run during this audit)

| Check | Command | Result |
|---|---|---|
| TypeScript typecheck (all workspaces and tests) | `pnpm typecheck` | **pass** (exit 0) |
| Unit tests (vitest) | `pnpm test:unit` | **338 passed, 0 failed** (20 files) |
| Electron end-to-end (Playwright, cookie-encryption fuse on) | `pnpm test:e2e` | **53 passed, 0 failed, 1 skipped** (3.7 min) |
| Secret scan (repository) | `pnpm check:secrets` | **No secrets found** |
| Local security check (leaked cookie values) | `pnpm security-check` | **PASS, 0 findings**; fuse on; OS protected storage available; 372 files scanned in the repo and the app's default development data folder (not your private profile) |
| Database migrations | unit `store.test.ts`, `flow-pool.test.ts` | pass; migration 7 (account table rebuild) tested on a pre-F0 database with accounts, sessions and products: data kept, references valid, foreign keys back on |
| Browser/profile isolation | e2e `isolation.spec.ts` (3), `proxy-isolation.spec.ts` (9), `security.spec.ts` (8), `session-sync.spec.ts` (9) | pass |

**Skipped:** `native-dialog.spec.ts` (1 test) only runs with `UGC_E2E_NATIVE_DIALOG=1`: it drives the real Windows file dialog with UI Automation and takes over the screen, so it wasn't run during the audit. It passed when last run in Gate 1.

**What the tests do not prove:** every automated test uses synthetic stand-in sites, a synthetic proxy and a synthetic video provider. They prove the app's logic and isolation, not that TikTok, Kalodata, Flow or your proxies behave the same way (§6.4).

### 6.4 Real-account verification record
| Item | Result | Source |
|---|---|---|
| Kalodata session import and logged in (Gate 2 E3), no account harm (E8) | **CONFIRMED by you** | `docs/gate-2/GATE2_REPORT.md` |
| Real Flow download saved to the right account library (Gate 4 T5) | **CONFIRMED by you** | `docs/gate-4/FLOW_FEASIBILITY.md` |
| Login persists after restart (E4, T6); Flow CAPTCHA/warnings (T3); credits per video (T7); real proxies | PENDING | same |
| Anything from Gate 5 onward (Growth Intelligence, Prompt Studio, board, Affiliate Products, Flow pool) | **Never run on your real profile** | Your real `ugc.db` has migrations **1–2** applied (read-only check, 2026-10-23); the current build will apply 3–7 on its next start |

---

## 7. Current automation level

| Category | Today |
|---|---|
| **Fully automatic** | Session cookie sealing/restore; proxy enforcement (fail closed); prompt text generation (offline templates); duplicate/consistency checks; linking a Flow download to its prompt and account; credit estimates; daily counters |
| **One click (you trigger)** | Generate prompts; approve/queue all; open product/Showcase/Kalodata/Flow windows in the right account; capture product ID from the Kalodata window; copy prompt/caption; Test Proxy |
| **Manual inside the app's embedded browser** | Logging in (if not imported); applying Kalodata filters; pasting the prompt and generating in Flow; downloading the video; adding a product to the Showcase; checking listings; (posting, if you do it in the account's TikTok window) |
| **Outside the app** | Running the launcher from a terminal; reviewing videos in Explorer; stitching clips (no tool in the app); writing a Kalodata export is not used |
| **Blocked by platform rules/authorization** | Automated TikTok actions (posting, Showcase, yellow basket) without TikTok API approval; Kalodata automation/data import/AI use without permission; Flow automation pending your helper approval |

**Feasible vs authorized:** an imported session makes it *technically* possible to script TikTok, Kalodata or Flow pages (Vibot does this with internal requests and UI automation). It is **not** authorized: TikTok Terms §5, Kalodata §4.1.8/§14 and the project decisions (D14, D16, D20, D27) exclude it, except the Flow helper for which you accepted the account risk (D26) and which still awaits approval.

---

## 8. Top five blockers to end-to-end operation
1. **Affiliate production pipeline not built** (A2 clip-pair prompts, stitching, product association, affiliate video list).
2. **Video generation is manual**: no approved Flow automation (helper pending) and no paid API decision; 60 clips/affiliate account/day is not feasible by hand at scale.
3. **Publishing, scheduling and yellow basket**: no authorized interface (TikTok approval-gated); posting stays manual.
4. **No real-account run of anything built after Gate 4** (DB at migration 2): the whole workflow is unproven on real accounts, real proxies and the real Showcase page.
5. **No output-quality loop**: no in-app review, unusable/failed-render tracking, or credit/retry caps.

## 9. Recommended next milestone
**R0 – Real-profile shakedown (no new code):** back up `ugc.db`, start the current app on your real profile, set one Ternak Akun account and one Affiliate account with real proxies, and run critical path 1 plus the Showcase step of path 2. It proves migrations 3–7, real proxies, session restore and the manual flows on real accounts. **Then A2** (affiliate clip-pair prompts + affiliate video list + stitching), the smallest code that creates the first finished affiliate video.

## 10. Questions that need your input
1. Supervised Flow helper: Flow interface language (Q4), and confirm defaults (press download once; don't change settings; cap based on credits).
2. Stitching two clips: is a local tool (ffmpeg, free) acceptable for producing the 16 s file?
3. Volume: is manual Flow work acceptable until the helper exists, or should we price Veo API for the affiliate volume?

---

## Appendix: screenshots

Captured from the current build in a **temporary synthetic profile** (fake accounts "Demo …", synthetic stand-in sites and proxy), in `docs/audit/screenshots/`. Your real profile was not opened. The status badges read "Draft: proxy not validated" because the screenshot run did not press Test Proxy.

| File | Screen | Operational? |
|---|---|---|
| `01-dashboard.png` | Dashboard: three account kinds, Flow pool, Ternak Akun today, + Add account | Operational |
| `02-add-account.png` | Add account | Operational |
| `03-edit-account-affiliate.png` | Affiliate account editor: proxy, four sessions. **No video section for Affiliate accounts** | Operational (gap visible) |
| `04-prompt-studio-templates.png` | Prompt Studio: templates and settings | Operational |
| `05-template-editor.png` | Template editor (copy of Grandma Messages) | Operational |
| `06-prompt-queue-statuses.png` | Prompts: queued, one "Video ready" (made by the **synthetic test provider**, which doesn't exist in normal use), one sent to the Flow pool, one in the account's own Flow window | Operational; the generated video is synthetic |
| `07-ready-to-post.png` | Ready to post | Operational (manual posting) |
| `08-video-library-ternak.png` | Ternak account editor: the older Gate 4 "Video generation" single-prompt section and the **Video library** | Operational; the older section only generates with the test provider |
| `09-ternak-akun-today.png` | Ternak Akun today board | Operational |
| `10-growth-intelligence-empty.png` | Growth Intelligence (optional) | Operational |
| `11-affiliate-products-showcase.png` | Affiliate Products: pasted products, one captured from the Kalodata stand-in's address, listing confirmed, Showcase "Adding in TikTok…" | Operational; Kalodata and TikTok pages here are **synthetic stand-ins** |
| `12-flow-pool.png` | Flow pool | Operational (estimates) |

Not captured because they **don't exist**: scheduling/posting-window dashboard, affiliate video production, clip stitching, yellow-basket linking, publishing.
