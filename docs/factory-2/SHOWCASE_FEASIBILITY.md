# Add to Showcase: Session-Based vs Official API (Feasibility)

**Date:** 2026-10-23 · **Status:** investigation for approval. Nothing implemented. Supersedes the "assisted only" conclusion of `A1_PROPOSAL.md` §1.2.

## 1. Two architectures, and what they need

| | **Official API** | **Authenticated browser session** |
|---|---|---|
| How | Approved TikTok Shop Partner app calls `Add Showcase Products` / `Get Showcase Products` | Uses the account's own logged-in session in its isolated, proxied browser |
| Per-account setup | **No developer app per account.** One approved app; each creator clicks an authorization link once (creator-level OAuth, scopes granted per creator). App-level approval and creator-level authorization are separate | Cookie-Editor JSON import or "Log in here" (already built) |
| Approval | App-level, approval-gated for Indonesia (company ≥ 1 year, local qualification, track record) | None from TikTok for the session itself; the actions are governed by TikTok's Terms (§3) |
| Success signal | TikTok's API response per product, then `Get Showcase Products` | TikTok's own UI confirmation in the account window |
| Our infrastructure | Needs token storage (DPAPI, like proxy passwords) and an API client | **Already exists**: isolated Chromium partitions per account, dedicated proxy (fail closed), cookie import/sync, per-account windows |

## 2. What our account browser can do today (reviewed)

- One persistent partition per account and platform (TikTok, Kalodata, Flow, Shopee), all through the account's dedicated proxy; WebRTC leak blocked; navigation limited to the platform's domains; sandboxed, no node access.
- `openSiteWindow` can open **any URL inside the platform's allowed domains** in that account's partition, so the app can open a specific product or Showcase page in the right account.
- Window-level controls are possible without touching the site's page: the app can read the **address** of its own window and show its own toolbar next to the site.
- Missing for this flow: Tokopedia domains are not in TikTok's allowed list (Indonesian product pages may redirect there, V1), and there is no toolbar yet.

## 3. Where the Showcase action lives, and what TikTok's Terms allow

| Question | Finding |
|---|---|
| Is "add to Showcase" a user-facing web feature? | TikTok documents Showcase and the Affiliate Product Marketplace for creators, and official pages describe adding products from the marketplace to the Showcase, but none I found states whether **Indonesian** creators can do it on **desktop web** rather than the app. Third-party Indonesian guides describe the app flow. **Unverified: needs one check by you (V2)** |
| TikTok Terms of Service §5 | Prohibits "use automated scripts to collect information from or otherwise interact with the Services" and bypassing access measures. §4: keep your login confidential, don't disclose it to third parties |

So, within the session architecture there are three levels:

| Level | What the app does | Status |
|---|---|---|
| **S1 Assisted navigation** | Opens the right product or Showcase page in the account's window; **you click** TikTok's own Add button; TikTok shows its confirmation | Permitted (no automated interaction). Feasible **if** the web supports it (V2) |
| S2 Scripted UI clicks | The app clicks TikTok's buttons for you in the session (even one at a time on your command) | Technically easy with Electron, but it is an automated script interacting with TikTok (§5). **Not proposed** (your rule 8) |
| S3 Private web endpoints | The app calls TikTok's internal web requests directly with the session cookies, without a page | Undocumented endpoint use. **Excluded** (rule 8) |

**How the app you use probably works.** Cookie-only onboarding plus one member running 189 accounts with one-click Showcase points to **S2 or S3 run on its servers** (headless browsers or replayed web requests), because the official API needs a creator OAuth authorization, not cookies. This is an inference, not verified. It also means that app holds your session cookies on its servers. To check instead of guessing, I'd need from you (§6): its name, its onboarding screens, and whether any TikTok "authorize" screen ever appears.

## 4. Provider-neutral Showcase interface (design)

```ts
interface ShowcaseProvider {
  readonly id: 'assisted_session' | 'tiktok_shop_api';
  readonly verifiesWithPlatform: boolean;           // true only for the API
  request(account, product): Promise<ShowcaseStep>;  // assisted: opens the page; API: submits
  verify?(account, product): Promise<'listed' | 'not_listed'>; // API: Get Showcase Products
}
```

| State | Meaning |
|---|---|
| `not_requested` | Product selected for the account |
| `in_progress` | Assisted: page opened in the account's window. API: request sent |
| `added_confirmed_by_tiktok` | API returned no error for this product, or Get Showcase lists it |
| `added_seen_by_you` | Assisted: you saw TikTok's own "added" confirmation and confirmed it here. Shown as "TikTok confirmation seen by you", never as plain "Added" |
| `not_eligible` / `failed` (with reason) / `removed` | Recorded from TikTok's response or your report |

The app never sets an "added" state on its own click. In the assisted mode it does not read TikTok's page to detect success (that would be automated collection); the confirmation is TikTok's, attested by you. With the API provider, it is TikTok's response.

## 5. The intended flow with S1 (no manual product typing)

1. **Open Kalodata** in the account's window (its proxy), apply your saved filters, open a product.
2. Press **Use this product** in the app's own toolbar next to that window. The app reads only the **window's address** to get the product identity (V3: whether Kalodata's product URL carries the TikTok product ID; if not, the product page's "view on TikTok" link does). No Kalodata page content or metrics are read or stored (Kalodata §4.1.8/§14).
3. The product appears in the account's **today** list (up to 3).
4. Press **Add to Showcase**: the app opens that product in the account's **TikTok** window. You press TikTok's Add button and see TikTok's confirmation.
5. Press **TikTok confirmed it**: state `added_seen_by_you`. Later, the API provider can upgrade this to `added_confirmed_by_tiktok` automatically.

Steps 2–5 are a few clicks per product, all in the right account and proxy. Price, commission and verified features (needed later for scripts) are recorded from the TikTok listing you already have open.

## 6. Feasibility comparison

| Criterion | Official API | S1 Assisted session | S2/S3 (not proposed) |
|---|---|---|---|
| Permitted | Yes | Yes | No (TikTok §5) |
| Available now | No (approval) | Yes, if V2 passes | — |
| Clicks per product | 0 (batch of 20) | ~3 | 0 |
| Platform-confirmed success | Yes | Seen by you | — |
| Scales to 30+ accounts | Yes | Effort grows per account | — |
| Isolation risk | None (no cookies used) | None (local, per-account proxy) | Server-held cookies, ban risk |

**Recommendation:** build A1 on the provider interface with **S1 first**, keep the **official API as a second provider** to switch on if you or a partner obtain approval, and decide after V2.

## 7. Evidence: Vibot's Kalodata guide (video "Panduan Kalodata di vibotfarm", reviewed 2026-10-23)

Reviewed as still frames (every 10 s, reduced size); no credentials were visible or transcribed.

| Observed | What it shows |
|---|---|
| The product is **"Vibot Phonefarm"**: a desktop console with mirrored **Android phone screens** (TikTok's in-app **Affiliate Center**), and tools named Device List, Automation, Workflow, APK, Keyboard, Locked Apps, Video Manager | TikTok work runs on **real phones driven by automation**, not through cookies in a browser or the official API |
| Kalodata step: the user opens kalodata.com in a normal browser, applies filters, sets 50 rows per page, opens **DevTools → Network**, copies Kalodata's internal JSON response and pastes it into Vibot's "Paste JSON data dari Kalodata" box | No Kalodata cookies or API: a **manual copy of Kalodata's internal web response**. The narrator mentions avoiding Kalodata's detection or limits |
| Vibot then scores the 50 products ("FYP score", revenue, rating, "Alasan Potensial" reasons), the user picks products and saves them to a chosen account (e.g. an account for INDONESIA) | Product selection and account association happen in Vibot's own list |
| The narrator then mentions "videos and auto-upload" as the next step | Posting is also automated on the phones |
| The Add to Showcase step itself is **not shown** in this video | Still unverified, but the phone-farm design makes in-app UI automation on the phones the most likely method |

**What this means for us:**
- The "cookie JSON only" onboarding doesn't explain Vibot's Showcase action. It works through **automated control of the TikTok app on physical phones**: the same category as S2 (automated interaction, TikTok Terms §5), on phones instead of a browser. We can't reproduce it with our browser sessions, and it isn't a supported or authorized interface.
- The Kalodata half is reproducible without automation: pasting a product list into our app takes no automation at all. It is the same Kalodata terms question as importing an export (§14.3/14.5 storage; §14.6 if analysed by AI). Kalodata's own **Export** is a documented feature, so it is a cleaner source than copying an undocumented internal response from DevTools. The choice is yours; technically either takes about a day.
- To confirm the Showcase method, the next useful evidence is Vibot's video or screens for **Add to Showcase / Etalase** and **auto-upload**.

### 7.1 Evidence: Vibot's Add to Showcase tutorial (reviewed 2026-10-23)

Reviewed as still frames (every 10 s, reduced size). A cookie export appears briefly on screen; no value was transcribed.

| Observed | What it shows |
|---|---|
| The user signs in to **`https://shop.tiktok.com/streamer/showcase/product/list`** on desktop web: TikTok Shop's creator console with **Showcase → Showcase Products** (list with Hide / Edit / Remove), LIVE tools, Analytics, Account health | **Showcase management exists on desktop web** (answers V2). It is inside `tiktok.com`, so our account windows can open it today |
| The user exports that page's cookies with **Cookie-Editor (JSON)** and pastes them into Vibot, plus optional **"query params" copied from DevTools** (request-signing values such as msToken / X-Bogus) | Vibot reuses the session cookies **and TikTok's anti-bot request-signing values** |
| In Vibot: paste a product link (`https://www.tiktok.com/view/product/<id>`), **Fetch Produk** shows title, price and shop; **Add to Showcase <id>** returns a raw JSON response (`code: 0`, `message: "success"`, a per-product add status) and "Produk berhasil ditambahkan ke Showcase"; the product then appears at the top of the Showcase list on the web page | Vibot sends **TikTok's internal web request directly** (no page, no official API) and reads TikTok's own response as confirmation. Product link format confirmed (answers V1) |

**Conclusion.** Vibot is **S3**: undocumented internal endpoints called with copied cookies and copied anti-bot signing parameters. (Owner, 2026-10-23: Vibot is a Windows desktop app, so these requests are sent from the user's own PC, not from Vibot's servers as guessed in §3. It also manages many Google Flow cookie sessions.) That conflicts with TikTok Terms §5 (automated interaction; bypassing access-restriction measures) and with your rule 8, so we don't replicate it. It also explains the "cookie JSON only" onboarding.

**What changes for us (positive):**
- **S1 is fully feasible on desktop web**: the same Showcase page Vibot uses can be opened in each account's isolated, proxied TikTok window, where you add the product with TikTok's own controls.
- TikTok's own confirmation is visible to you on that page: the product appears in **Showcase Products**. That is the confirmation you attest to in the app (`added_seen_by_you`).
- The product link format is `https://www.tiktok.com/view/product/<id>`, which the app can validate and use to open the product in the right account.

**Updated S1 flow:** Kalodata (account window) → **Use this product** (product link/ID only) → **Add to Showcase**: the app opens `shop.tiktok.com/streamer/showcase/product/list` in that account's TikTok window and puts the product link on the clipboard → you add it with TikTok's controls → it appears in Showcase Products → **TikTok shows it in my Showcase**.

### 7.2 Evidence: Vibot's auto-upload with Google Flow tutorial (reviewed 2026-10-23)

The recording covers about 2:40 of an 8:40 tutorial (parts skipped), reviewed as still frames.

| Observed | What it shows |
|---|---|
| A **Workflow Marketplace** of ready workflows: "(ID) TikTok Upload (Google Flow)", "TikTok Upload (GROK AI)", "TikTok Upload (Generate AI)", "Shopee Upload (Google Flow)", and others | Production is packaged as per-platform workflows |
| "Automation #1 / #2" panels per account: workflow, **data mode "From Kalodata"** (the product queue saved earlier), target language Indonesia, account rules, **number of posts (15)**, **Select Devices** (phones), **START AUTOMATION**, live logs | One run takes N products from the account's queue and produces and posts N videos on a chosen phone |
| The phone's screen shows a **Google video-generation app** ("What do you want to make?") with the product image inserted and a long prompt ("…locked on the product stack. Absolutely NO extra floating text, NO TikTok overlays…"), then the generated clip; logs show UI-element selectors and click steps | The phone's **Google app is driven by UI automation** (Android accessibility/ADB style), not by an API |
| Narrator: posts go to the TikTok account automatically, "no matter how many accounts" | Posting is also UI automation of the **TikTok app** on the phone (with the product attached) |

**Fuller recording of the same tutorial (5:18 of 8:40, reviewed 2026-10-23)** confirms the whole loop on each phone:
1. Google Flow's **mobile app**: the product image is picked from the gallery, a prompt is typed (sound design, beat-matched cuts at 2 s, 5 s, 7.5 s), model "Omni Flash", generate, then download ("download complete").
2. TikTok app: upload from the gallery → **caption typed automatically** (Indonesian text and hashtags) → **Add link → Showcase**, the product found by its **product ID** and added → **Post**.
3. Two automations run at once on two phones (two accounts), 15 posts each, with live logs of each tap.

**Owner correction (2026-10-23):** Vibot uses **no physical phones**; it only asks for Cookie-Editor JSON sessions. The phone-sized screens are therefore sessions rendered in phone-sized views inside the desktop app (its panels are labelled "Upload Remot Phone" and "Upload Api"), not real devices. The classification below is unchanged: the logs show element-by-element taps and typing, i.e. automated UI interaction driven from cookie sessions.

**Conclusion.** Vibot's production is **automated UI interaction from cookie sessions** (originally read as a phone farm) of Google's consumer video app and the TikTok app, one phone per account. That gives each account its own real device and network, and full hands-off throughput. It is the same category as S2 (automated interaction with TikTok and Google consumer services), which TikTok's Terms §5 prohibit. It is also outside the decisions already on record for this project (D20: no real-Flow automation until permitted; no TikTok posting automation without authorization). We can't reproduce it with Electron sessions, and I don't recommend reproducing it on phones.

**Permitted routes to the same production targets (for the later pipeline):**

| Stage | Vibot | Permitted options for us |
|---|---|---|
| Video generation | UI automation of Google's app on phones | Manual Flow with app-prepared prompts and automatic library linking (T1, built), or **Veo through the Gemini API / Vertex AI** (official, paid per video, no browser) |
| Posting with product link | UI automation of the TikTok app | Manual posting in the account's window with app-prepared caption and product (T2, built), or **Post Shoppable Video** (official TikTok Shop API, same approval gate as Showcase) |
| Showcase | Internal web request (S3) | S1 assisted on the web Showcase page, or the official Showcase API |

## 8. Needed from you

| # | Item |
|---|---|
| E1 | Done: Vibot's Kalodata and Add to Showcase tutorials (§7, §7.1) |
| V1 | Done: `https://www.tiktok.com/view/product/<id>` |
| V2 | Answered by the tutorial: desktop web at `shop.tiktok.com/streamer/showcase/product/list`. Still worth one check in **our** account window: how you add a product there (button name, paste link or search) |
| V3 | Does a Kalodata product page's address contain the TikTok product ID (yes/no and the pattern, not real data) |
