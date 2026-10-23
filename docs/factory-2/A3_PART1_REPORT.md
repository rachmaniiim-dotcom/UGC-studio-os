# A3 Part 1: Paste a Link → 10 Videos

**Date:** 2026-10-23 · **Status:** implemented and tested with synthetic data; **not yet tried on a real TikTok listing.**
**Why:** the first real test showed the daily flow took longer than making videos by hand (typing product details, approving plans one by one, choosing clips one by one).

## The morning flow now

1. **Products → paste a product link → "Add and fill from TikTok".** The product opens in that account's TikTok window (its proxy, its login). The app reads the page and fills in the **title, shop, price, description** and **feature lines**; the listing counts as confirmed because the page showed that exact product ID. With **"Use the listing photo…"** ticked once (remembered), the main photo is saved as the product reference for Flow.
   - If TikTok shows a **security check**, the app waits up to 3 minutes while you complete it in that window, then reads the page. It never tries to get past it.
   - Products taken from Kalodata are filled the same way. **Fill from TikTok** on any product reads it again.
2. **Create videos → "Make 10 videos".** Plans the configured number and approves every plan without a blocking flag. (*"or plan 10 as drafts to review first"* and **Approve all drafts** remain.)
3. **"Send next clip to Flow"**: the next clip in order (Video 1 A, 1 B, 2 A …) is copied and Flow opens. Generate and download there; the clip lands by itself, and the pair is joined when both are in. Failed or unusable clips come back first while attempts remain. Only one clip is in Flow at a time, so every download is matched to the right clip.
4. Review and approve the finished videos as before.

**Default Clip B is now a comedic cut** (new angle or reactor), so no last-frame upload is needed in Flow. Seamless and mixed remain in settings. The settings panel is below the plans and closed.

## How the page is read

- Only the page you opened, in that account's own window. The reader runs in an **isolated world** (the page's scripts can't see or change it) and reads meta tags, embedded JSON and visible text. Nothing is clicked or submitted; no other page is requested.
- Rules: the product ID must appear in the page's address or data; promotions ("diskon", "gratis ongkir", prices) and links are left out of the features; headings ("Manfaat:") are skipped.
- The photo is fetched through the same account session and proxy: HTTPS, JPEG/PNG/WebP, at most 8 MB, checked by its file signature.
- **Unknown until the real test:** TikTok's real page layout. The reader tries JSON-LD, embedded product JSON, meta tags and the visible "Deskripsi" section. If it can't find a title it says so, and you can still type details in **Edit details**.

## Data

Migration **9**: `affiliate_products.image_asset_id` (the saved listing photo). It only adds a column. **Back up before the first start on this build.**

## Tests (synthetic)

- Core `affiliate-listing.test.ts`: embedded JSON (rich-text description), JSON-LD and meta tags, security check, wrong product, missing title, feature extraction, rupiah parsing.
- `affiliate-studio.test.ts`: listing applied (confirmed, photo kept, empty fields don't erase), one-click plans approved with the photo as reference, queue order (A then B, retry first, never two in Flow), approve all.
- E2E `affiliate-a3.spec.ts`: paste link → **security check completed in the TikTok window** → title, price, shop, 3 features and photo filled (all requests through the account's proxy) → **Make 3 videos** → **Send next clip** → Video 1 Clip A in the pool's Flow window with its prompt on the clipboard → the fake download is marked unusable and Clip A is next again. Screenshot `screenshots/07-a3-one-click-videos.png`.
- Totals: typecheck pass; unit 357 passed, 1 skipped; e2e 55 passed, 1 skipped (opt-in native dialog); secret scan clean.

## Not in Part 1

- **Part 2: supervised Flow helper** (pasting the prompt and pressing generate in Flow). It needs one look at the real Flow page first.
- Screenshot input (Windows' built-in text recognition) and a character sheet image.
- Showcase stays your click.
