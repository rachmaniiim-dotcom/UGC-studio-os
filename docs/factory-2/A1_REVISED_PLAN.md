# A1 Revised Plan: Products, Showcase (S1) and the Flow Session Pool

**Date:** 2026-10-23 · **Status:** proposal for approval. Nothing implemented.
**Replaces:** `A1_PROPOSAL.md` §2 (link-only capture) in light of `SHOWCASE_FEASIBILITY.md` (Vibot evidence, desktop web Showcase page) and D26 (Flow account risk accepted; accounts are paid Google AI Pro).

## 1. Flow capacity (your numbers)

Google AI Pro: **1,050 credits/month**; Omni Flash: **12 credits per 8-second clip** → **87 clips ≈ 43 videos of 16 s** per Pro account per month.

| Plan | Clips/day | Credits/month (30 days) | Pro accounts needed |
|---|---|---|---|
| 1 affiliate account: 3 products × 10 videos × 2 clips | 60 | 21,600 | **~21** |
| 1 Ternak Akun account: 10 videos × 1 clip (8 s) | 10 | 3,600 | ~3.5 |
| 1 Ternak Akun account: 10 videos × 2 clips (16 s) | 20 | 7,200 | ~7 |

So credits come from **many Google accounts per TikTok account**: Flow sessions must be a **pool**, not one per TikTok account as today. (Worth comparing later with Veo through the official Gemini API at the same volume.)

## 2. Milestone A1: Affiliate products and Showcase (S1)

One screen, **Affiliate Products**, from a Products button on each Affiliate row.

1. **Capture from Kalodata, no typing.** In the account's Kalodata window, open a product and press **Use this product** in the app's own toolbar next to the window. The app reads only the window's **address** to get the TikTok product ID (V3: if Kalodata's address doesn't carry it, the toolbar instead takes the product link from your clipboard). Bulk paste of TikTok product links also works. *Optional, your decision:* importing a Kalodata product list (export file or pasted JSON, as Vibot does) is technically a day's work, but Kalodata's Terms §14.3/14.5 restrict storing it in another system.
2. **Today's selection:** up to 3 products per account (editable).
3. **Listing check:** **Open product** opens `https://www.tiktok.com/view/product/<id>` in the account's TikTok window (its proxy). You record what you verified: price, commission, shop, **verified features** (used later for scripts).
4. **Add to Showcase (S1):** opens `https://shop.tiktok.com/streamer/showcase/product/list` in that account's TikTok window with the product link on the clipboard; you add it with TikTok's own controls; when it appears in **Showcase Products**, press **TikTok shows it in my Showcase**. States: not requested → in progress → *added, TikTok confirmation seen by you* / not eligible / failed / removed. Provider-neutral, so the official API can be added as a second provider later (*added, confirmed by TikTok*).
5. **Data:** migration with **one table** (`affiliate_products`, per account and product ID); no Kalodata metrics stored. One window-toolbar addition and one IPC to open a URL inside the account's TikTok domains.
6. **Tests:** synthetic product links and stand-in TikTok/Kalodata hosts; statuses never show "added" without confirmation; per-account independence; e2e through the screen.

## 3. Milestone F0: Flow session pool (shared by both factories)

1. **Pool accounts.** A Flow-only Google account as its own item: name, **dedicated proxy** (same fail-closed rules), one isolated Google Flow session (Cookie-Editor JSON import or login), monthly credits (default 1,050) and reset day. Built on the existing Account Bundle code as a third kind, so proxy setup, Test Proxy, cookie import and session restore are reused unchanged (migration widens the account `mode` check).
2. **Credit ledger.** Credits per clip by model (Omni Flash 12, editable); each generation (manual download or helper job) deducts from the pool account that made it; remaining credits and reset shown.
3. **Assignment.** When a queued prompt is taken to Flow, the app picks the pool account with the most remaining credits (or you pick), opens **that** Flow window, and records the hand-off.
4. **Download routing.** A video downloaded in a pool account's Flow window is linked to the prompt waiting there and saved into the **target TikTok account's** library (today it can only go to the same account's library).
5. **Tests:** synthetic pool accounts and stand-in Flow host; credit arithmetic and resets; routing to the right library; pool isolation (no session or proxy sharing).

## 4. Next after A1 and F0 (separate approvals)

- **Supervised Flow helper (Gate 4b)** on pool sessions: Q5 accepted (D26). Still open: Q1 press Flow's download once (recommended yes), Q2 don't change Flow settings (recommended), Q3 daily cap per pool account (credit-based instead of 3?), Q4 Flow interface language.
- **A2:** product-specific two-clip concepts (Indonesian fast direct selling, verified features, comedic setup, punchline CTA) on the T1 template engine; merging the two 8-second clips locally.
- **Posting plan:** 30 posts across 5 windows, manual posting with app-prepared caption and product (T2), or the official Post Shoppable Video API if approved.

## 5. Decisions needed

1. Approve A1 (§2) and F0 (§3), in that order?
2. Kalodata list import (export or pasted JSON): include, given §14.3/14.5, or keep product capture to IDs only?
3. Answer V3 (Kalodata product page address pattern), or I build the clipboard fallback only.
