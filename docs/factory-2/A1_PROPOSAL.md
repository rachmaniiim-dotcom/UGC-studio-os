# A1 Proposal: Affiliate Products, Account Association and Showcase Confirmation

**Date:** 2026-10-23 · **Status:** proposal for approval. Nothing implemented.
**Factory:** Affiliate UGC (Factory 2), independent of Ternak Akun. Accounts are used as created (mode `affiliate_ugc`); nothing requires a Seedling history.

## 1. What I verified

### 1.1 Kalodata → app: what is offered and what is permitted

| Finding | Source |
|---|---|
| Kalodata offers **Data Export (PC only)** of the **Product List** (and creator lists). It also sells "customized data export reports" | Kalodata Knowledge Base, "Common Features 7" and FAQ 10 (read 2026-10-23) |
| No public Kalodata API or official integration was found | Kalodata site and knowledge base |
| Kalodata's Terms (2026-04-16), already recorded as **R-03 / R-03b / D16**: §4.1.8 forbids automated interaction; **§14.3 requires an enterprise agreement to integrate Kalodata data into internal systems or databases; §14.5 forbids systematic export into a persistent dataset; §14.6 forbids any AI/LLM use of the data without written consent** | `docs/gate-2/GATE2_READINESS.md` §3 |

**Consequence.** The lowest-friction path (Export → app imports the file) is technically simple, but storing exported Kalodata rows in the app's database is "integration into an internal database" under §14.3. A logged-in Kalodata session is not that permission. So:

- **Permitted now, without automation of Kalodata:** you research in Kalodata (in the account's isolated Kalodata window or anywhere), and bring into the app only the **TikTok Shop product identity** (product link or ID: TikTok's identifier, not Kalodata analytics), plus facts you **verify on the TikTok Shop listing itself** (price, commission, features).
- **Possible with written permission or an enterprise agreement:** a one-click **Kalodata export import** (the owner clicks Export in the account's Kalodata window; the app takes that file, previews it, and stores only the products you pick). I propose building this as **A1b, behind a recorded permission**, so it can't run by accident before permission exists. I can draft the permission request.
- **Never without written consent:** sending Kalodata-derived data to any AI (summaries, scripts). Product summaries in A1 are therefore built by fixed rules from fields, not by AI.

### 1.2 Showcase: an official interface exists, but access is approval-gated

| Finding | Source |
|---|---|
| **Add Showcase Products** `POST /affiliate_creator/202405/showcases/products/add` (by product ID, up to 20, or by product link), scope `creator.showcase.write`; per-product errors are returned, so success is verifiable. Also **Get Showcase Products** (`creator.showcase.read`), **Get Open Collaboration Product List By Product Ids**, **Map Tokopedia to TikTok Shop Product IDs**, and **Post Shoppable Video** (`creator.video.write`) | TikTok Shop Partner Center API reference, Affiliate creator (read 2026-10-23) |
| Each creator authorizes the app by OAuth (`shop.tiktok.com/alliance/creator/auth`), granting scopes; tokens per creator | Creator authorization guide |
| **Indonesia (local sellers) is open** for the Creator Collaboration category, but access is **approval-gated**: a company registered ≥ 1 year with local business qualifications, capability evidence, and a collaboration track record (e.g. TAP/CAP GMV > USD 12,500/month or > 100 creators); review ~7 working days, then per-API scope approval | Affiliate (Creator Collaboration) developer onboarding & termination rules |
| SEA creators need 5K+ followers to be TikTok Shop Creator Affiliates (your accounts already are) | Affiliate Creator API overview |

**Consequence.** Automatic "Add to Showcase" is technically supported by TikTok, but only for an approved Partner Center app. Until you have (or partner with) one, A1 provides an **assisted** Showcase action with honest statuses. The A1 data model already has a slot for the API path so it can be switched on later without rework.

## 2. Smallest functional A1 (what it does)

One new screen, **Affiliate Products**, opened from a **Products** button on each Affiliate row of the dashboard (no new dashboard).

1. **Add products fast.** Paste one or many TikTok Shop product links or IDs (one per line, e.g. three from today's research). The app extracts and validates each product ID, rejects short links it can't resolve offline, removes duplicates, shows a preview, and adds them **to the selected account only**.
2. **Daily selection.** Mark up to **3 products as today's selection** for that account (target editable, default 3). The same product in two accounts is two independent records (each account's Showcase is separate).
3. **Listing check (exact identity).** **Open listing in this account's TikTok window** opens the product page in that account's isolated, proxied TikTok session. You confirm it is the right listing and fill the facts you see: title, shop, price, commission, and **verified features** (each feature marked as checked on the listing). Status: *Unverified → Listing confirmed by you* (or *Mismatch*).
4. **Concise summary** (rule-based, no AI): e.g. "Rp 89.000 · komisi 12% · toko X · 4 fitur terverifikasi · 3 video referensi".
5. **Sales-driving references.** Paste TikTok video links of videos that sell the product (from your research); validated with the existing TikTok link parser; stored with the product for the later script step. No video is downloaded.
6. **Can this account promote it?** You record *Can promote / Cannot promote / Unknown* after checking in the account's TikTok Shop view.
7. **Showcase (assisted).** Statuses: *Not added → Action requested (opened in the account's window) → **Added, confirmed by you** (with the time and an "I can see it in this account's Showcase" confirmation) / Not eligible / Failed / Removed*. The word "Added" never appears without "confirmed by you" (assisted) or "confirmed by TikTok" (API, later).

## 3. Repository reuse and changes

| Reuse as is | For |
|---|---|
| Account Bundles, dedicated proxy, isolated TikTok/Kalodata sessions, `openSiteWindow` (opens any URL inside the platform's allowed domains, in the account's partition) | Account association; opening the listing in the right account and proxy |
| `parseTikTokVideoUrl`, CSV/RFC 4180 parser (`core/research/reference.ts`) | Sales-driving video links; later export parsing |
| Research-source authorization check (`assertResearchUse`) | Gate for the A1b Kalodata import (storage permission) |
| Error/notice patterns, Badge, bridge style; security-check and secret-scan guards | UI and safety |

| New (small) | Notes |
|---|---|
| `core/affiliate/product.ts` | Product link/ID parser and validator, status rules, rule-based summary |
| **Migration 6: one table `affiliate_products`** | `bundle_id`, `platform_product_id` (UNIQUE per account), `listing_url`, `title`, `shop_name`, `price_idr`, `commission_pct`, `features_json`, `references_json`, `selected_on`, `listing_state`, `eligibility_state`, `showcase_state`, `showcase_method` (`assisted` / `api`), `showcase_confirmed_at`, `source` (`link` / `kalodata_export`), `notes`, timestamps. No Kalodata metrics stored in A1 |
| `main/affiliate.ts` service + IPC (`affiliate:*`), one new IPC to open a product URL in the account's TikTok window (TikTok domains only) | Refuses Ternak Akun accounts, as Prompt Studio refuses Affiliate ones |
| `AffiliateProducts.tsx` + a Products button on Affiliate rows | No other dashboard |

## 4. Tests (synthetic only)

Product link/ID parsing (valid formats, short links, duplicates, wrong domains); status rules (no "added" without confirmation; listing must be confirmed before Showcase confirmation; daily limit); per-account independence; affiliate-only; the listing opens only inside the account's TikTok partition and allowed domains (synthetic `tiktok.ugc-poc.test`); A1b import refused while no permission is recorded; logs contain ids and counts only; e2e through the screen; security spec for new bridge methods.

## 5. Later pipeline (design constraints A1 prepares for)

| Target | Per affiliate account per day | Implication |
|---|---|---|
| Products | 3 | A1 daily selection |
| Finished videos | 10 per product = **30** | Concepts per product from **verified features only** (A1 stores them) |
| Flow clips | 2 coordinated 8-second clips per video = **60** | Extend the T1 template engine with a two-clip structure (shared character/product block in both clips; clip 1 = comedic setup + hook, clip 2 = demonstration + punchline CTA), Indonesian fast-paced direct selling |
| Posts | **30 across 5 daily windows** (6 per window) | Replaces the earlier 4 × 3 = 12 plan; posting needs the product link attached |

Constraints to settle before those milestones: 60 manual Flow generations per account per day (Flow automation not established, R-02/R-32; Flow quotas per Google account); posting with the product link needs **Post Shoppable Video** (same approval gate as Showcase) or manual posting in each account's session; 30 posts a day per account is high-volume posting with TikTok integrity and AI-label obligations (R-04, B8/B9); scripts may only use Kalodata-derived information if §14.6 consent exists.

## 6. Blockers and validation items

| # | Item | Needed from you |
|---|---|---|
| V1 | Indonesian product link formats (TikTok Shop vs Tokopedia after the merger) and whether a product page opens on TikTok web | Paste one public product link format you use (not account data) |
| V2 | **Can a creator add a product to Showcase on TikTok web**, in the account's isolated window? If only the mobile app can, the action runs on your phone's network and device, outside the account's proxy isolation | A manual check on one account |
| B1 | Kalodata §14.3/14.5/14.6: import of exports and any AI use need written permission or an enterprise agreement | Decide whether to ask Kalodata (I can draft the request) |
| B2 | TikTok Shop Creator Collaboration API access: company and track-record requirements | Decide whether to apply as a company, or work with an approved partner app later |

## 7. Decisions needed

1. Build A1 as in §2 (link-based capture, assisted Showcase, no Kalodata data stored), with A1b (Kalodata export import) only after permission is recorded?
2. Daily selection default of 3 products per account, editable?
3. Proceed with V1/V2 manual checks before coding (they change URL handling and the Showcase action), or code A1 with the link formats configurable?
4. Confirm the posting plan change to 30 posts in 5 windows (replacing 12 in 4 × 3).
