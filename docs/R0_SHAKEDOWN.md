# R0: Real-Profile Shakedown

**Date:** 2026-10-23 · **Commit:** `fa868c4` · **Profile:** `C:\ugc-private\ugc-userData`

## 1. What was done (by Claude, no live site actions)

| Step | Result |
|---|---|
| App closed before starting | Confirmed (no Electron process) |
| Backup | `C:\ugc-private\backups\ugc-v2-before-shakedown-20261023-125832.db` (SHA-256 identical to the original; opens read-only; `integrity_check` ok) |
| Baseline (from the backup) | Database version 2; **1 account** (Account Growth) with a proxy and 4 sessions (TikTok, Google Flow, Kalodata, Shopee); 1 completed Flow download in the library (3.5 MB); 4 sealed session snapshots; 1 sealed proxy secret. **No Affiliate account exists in this profile.** |
| Rehearsal | Migrations 3–7 applied by the app's own code to a scratch copy of the backup: integrity ok, foreign keys valid and on, account/proxy/sessions/video kept |
| Live migration | Started the app with the normal launcher (`node apps/desktop/scripts/run-app.mjs`): database now at version **7**, integrity ok, 0 foreign-key problems |
| Associations | Sessions, browser partitions, account name, mode and proxy settings **identical** to the backup (compared, not printed); 4 sessions still linked to the account; library file, session snapshots and proxy secret still present |
| Not done | No site opened, no credits spent, no Showcase change, nothing posted, no cookies or proxy secrets read |

**To roll back:** close the app, then copy the backup file over `C:\ugc-private\ugc-userData\ugc.db`. Version 2 works with commit `1110638` (Gate 4) only.

## 2. Guided test A: one real Ternak Akun video (your actions)

The app is open. Everything that touches Flow or TikTok is your own action; generating in Flow **spends your Flow credits**.

1. **Accounts** → your account → **Open** → **Test proxy**. Expect "Passed" and the exit IP.
2. Google Flow session → **Open**. Are you still signed in to Google/Flow without signing in again? *(Settles pending items T2/T6.)* Any CAPTCHA, "unusual activity" or proxy warning? If yes, **stop** and note only the kind of message (T3).
3. TikTok session → **Open**. Still logged in? (Gate 2 E4 equivalent.)
4. **← All accounts** → **Prompt Studio** → keep **ASMR** (or choose another) → **Number of prompts** `3` → **Generate 3 prompts**.
5. Read prompt #1. **Approve prompt** → **Queue for generation** → **Copy prompt for Flow** → **I'm generating it in Flow**.
6. In the Flow window: paste the prompt, choose your usual model (e.g. Omni Flash, 9:16, 8 s), generate, then **download** the clip in that window.
7. Back in Prompt Studio, prompt #1 should change to **Video ready** within a few seconds. **Show video in folder**: does it play correctly? (T7: how many credits did Flow show for it?)
8. **4. Ready to post** → **Copy caption**. Posting is optional: if you post it yourself in the account's TikTok window (switch on TikTok's AI-generated label), press **I posted it**.
9. **← All accounts** → **Ternak Akun today**: expect "1/10" videos today (and 1 posted if you posted).

## 3. Guided test B: Affiliate Kalodata and Showcase (your actions)

There is **no Affiliate account** in this profile yet, so this test starts by creating one.

1. **+ Add account** → name → **Affiliate UGC** → **Save draft** → its **dedicated proxy** → **Save proxy changes** → **Test proxy**.
2. Import that affiliate account's **TikTok** cookies (Cookie-Editor JSON) and its **Kalodata** cookies, or use **Log in here**. *Using the same Kalodata login in Chrome and the app at the same time may look like account sharing (R-22).*
3. **← All accounts** → that account → **Products** → **Open Kalodata**. Apply your filters in Kalodata (yesterday's sales > 0, < 50 creators, growth > 30 %) and open one product's detail page.
4. Back in the app: **Use the product open in Kalodata**. Does it add the product (V3)? If it says no product ID was found, copy the product's TikTok link and paste it under **Add products**. *(Please tell me which happened; for V3, only "yes"/"no" and the address pattern without real IDs.)*
5. **Select for today** → **Open product**: does the product page open in the TikTok window (or redirect, e.g. to Tokopedia, and get blocked)?
6. If it's the right listing: **This is the exact listing** → **Edit details** (price, commission, verified features) → **Save details**.
7. **Add to Showcase**: TikTok's Showcase page opens in the account's window and the product link is on your clipboard. **How does that page add a product: a paste-link field, a search, or something else?** Add it with TikTok's controls (your direct action).
8. When it appears in **Showcase Products**, press **TikTok shows it in my Showcase**.

## 4. What to report back (no secrets, no account names)

| # | Question | Answer |
|---|---|---|
| A1 | Test proxy passed? | |
| A2 | Flow still signed in after restart? Any challenge/warning? | |
| A3 | TikTok still logged in? | |
| A4 | Prompt → Flow → download → "Video ready" worked? Credits used per clip? | |
| A5 | Board showed 1/10? | |
| B1 | Affiliate account set up; proxy passed; sessions logged in? | |
| B2 | "Use the product open in Kalodata" worked (V3)? | |
| B3 | Product page opened in the TikTok window, or redirected/blocked? | |
| B4 | How the Showcase page adds a product; did it appear in Showcase Products? | |
| B5 | Anything confusing or broken | |
