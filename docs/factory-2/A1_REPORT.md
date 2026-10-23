# A1 Report: Affiliate Products and Assisted Showcase

**Date:** 2026-10-23 · **Status:** implemented and tested with synthetic data. Waiting for review. F0 (Flow session pool) is next.
**Plan:** `A1_REVISED_PLAN.md` §2, approved with "product capture by IDs only (no Kalodata list import)".

## 1. The working interface

Dashboard → any **Affiliate UGC** row → **Products** (Ternak Akun accounts don't get it).

| Area | What you do |
|---|---|
| **Add products** | **Open Kalodata** (this account's window), open a product there, then **Use the product open in Kalodata**: the app reads only that window's **address** to get the TikTok product ID. Or paste TikTok product links/IDs, many at once. Short links (`vt.tiktok.com`) and non-product links are refused with the line and reason |
| **Today's selection** | **Select for today**, up to the daily limit (default 3, editable); resets each day |
| **Listing check** | **Open product** opens `tiktok.com/view/product/<id>` in this account's TikTok window. **This is the exact listing** / **wrong listing**. **Edit details**: title, shop, price, commission, **verified features**, sales-driving video links, notes. Summary built by fixed rules, e.g. "Rp89.000 · komisi 12,5% · toko … · 2 fitur terverifikasi · 0 video referensi" |
| **Can promote?** | Not checked / Can promote / Cannot promote (your observation) |
| **Add to Showcase** | Enabled only after the listing is confirmed. Opens TikTok's **Showcase Products** page (`shop.tiktok.com/streamer/showcase/product/list`) in this account's window and puts the product link on the clipboard. You add it with TikTok's own controls. Then **TikTok shows it in my Showcase** → "Added: TikTok confirmation seen by you". Also: Open Showcase page again, It failed, not eligible, removed from Showcase, reset |

The app never clicks, types or reads anything inside TikTok or Kalodata pages. "Added" is never shown without saying who confirmed it; the "confirmed by TikTok" state exists for a future official-API provider and no owner action can set it.

**Change from the plan:** instead of a toolbar beside the Kalodata window, the capture button is on the Products screen and reads the address of this account's open Kalodata window. Same result, no extra window chrome. V3 (whether Kalodata's address carries the TikTok product ID) is handled both ways: an `id` / `product_id` query value or a 15–20 digit path segment is used; otherwise the screen says so and you paste the product's TikTok link.

## 2. Isolation

Every page opens in the account's own partition through its dedicated proxy (Test Proxy must have passed in this run; fail closed). Products are per account: the same product in two accounts is two independent records with separate Showcase states. Logs carry ids, counts and states only, never product IDs or links.

## 3. Data (migration 6)

`affiliate_products` (account, TikTok product ID, source, verified facts, today's selection date, listing / eligibility / Showcase state, Showcase method and time) and a `daily_products` column on `production_targets`. No Kalodata data is stored.

## 4. Tests (synthetic only)

| Suite | Result |
|---|---|
| Typecheck | pass |
| Unit (vitest) | **332 passed** (19 files). New: `packages/core/test/affiliate.test.ts` (product link/ID parsing, address capture, list parsing, facts, summary, Showcase rules), `apps/desktop/test/affiliate.test.ts` (per-account isolation, address capture, affiliate-only, daily limit and reset, Showcase sequence, facts, no product IDs in logs) |
| E2E (Electron, fuse on) | **52 passed, 1 skipped** (opt-in native dialog). New: `apps/desktop/e2e/affiliate.spec.ts` (paste and capture, selection, listing window on the TikTok stand-in, details, Showcase page opened with the link on the clipboard, confirmation; every opened page went through the account's proxy exit IP); `security.spec.ts` updated for 12 new bridge methods |
| Secret scan | No secrets found |

## 5. Demonstration

1. Create (or open) an Affiliate UGC account with its proxy, TikTok session and Kalodata session.
2. **Products** → **Open Kalodata** → filter and open a product → **Use the product open in Kalodata** (or paste the product's TikTok link).
3. **Select for today** → **Open product** → check it → **This is the exact listing** → **Edit details** (price, commission, verified features).
4. **Add to Showcase** → in the TikTok window, add the product (link on the clipboard) → when it appears in Showcase Products → **TikTok shows it in my Showcase**.

Screenshots: `screenshots/01-affiliate-products.png` (selection and Showcase in progress), `screenshots/02-showcase-confirmed.png`.

**Please check in the real interface:** how the Showcase Products page adds a product (paste link or search), and whether Kalodata's product page address contains the product ID (V3).

## 6. Not in A1

Kalodata list import, any TikTok/Kalodata automation, the official Showcase API provider, Flow session pool (F0, next), product videos and posting.
