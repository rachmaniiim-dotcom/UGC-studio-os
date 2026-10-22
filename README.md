# UGC Production OS

Multi-account AI UGC research, production and publishing platform. Windows desktop first (Electron); a Linux automation backend later.

**Current stage: Gate 3, Account Setup and Session Manager.** Account Bundles (one TikTok identity each) with a dedicated proxy and isolated sessions for TikTok, Google Flow, Kalodata (optional) and Shopee (optional). Automated tests use synthetic data only. See [`docs/gate-3/GATE3_IMPLEMENTATION_REPORT.md`](docs/gate-3/GATE3_IMPLEMENTATION_REPORT.md).

- Spec: `MASTER_SPEC.md` (kept by the product owner)
- Architecture: [`docs/gate-0/ARCHITECTURE_REPORT.md`](docs/gate-0/ARCHITECTURE_REPORT.md)
- Gate 1 results: [`docs/gate-1/GATE1_REPORT.md`](docs/gate-1/GATE1_REPORT.md) · Windows validation and hardening: [`docs/gate-1/WINDOWS_HARDENING_REPORT.md`](docs/gate-1/WINDOWS_HARDENING_REPORT.md)
- Gate 2 readiness: [`docs/gate-2/GATE2_READINESS.md`](docs/gate-2/GATE2_READINESS.md) · Pre-Gate-2 hardening (C1–C5): [`docs/gate-2/PRE_GATE2_HARDENING_REPORT.md`](docs/gate-2/PRE_GATE2_HARDENING_REPORT.md)
- Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md) · Risks: [`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md)

## Layout

```text
apps/desktop/          Electron app: main (privileged), preload (bridge), renderer (UI)
packages/core/         Platform-neutral: cookie import/normalization, redaction, statuses
packages/test-fixtures/ Synthetic cookies and a local HTTPS test site (dev only)
scripts/               Repository checks
```

`packages/core` imports nothing from Electron or Playwright, so the future Linux worker can reuse it.

## Commands

Requires Node ≥ 22.12 and pnpm 10.28 (`corepack enable`). The npm scripts call `pnpm` themselves, so it must be on PATH. On Windows without an admin shell, use `corepack enable pnpm --install-directory %LOCALAPPDATA%\corepack-shims` and add that folder to your user PATH.

```sh
pnpm install            # also downloads and verifies the pinned Electron binary and activates the git hooks (postinstall)
pnpm typecheck          # builds everything, then typechecks the tests
pnpm test:unit          # Vitest
pnpm test:e2e           # Playwright driving real Electron (needs a desktop session)
                        # Windows: set UGC_E2E_NATIVE_DIALOG=1 to also drive the real file dialog (takes focus)
pnpm check:secrets      # scans the repo for secrets, synthetic canaries and session-data paths (also runs as a pre-commit hook)
pnpm security-check     # local leak check of the app's profiles: counts and locations only, never values (close the app first)
node apps/desktop/scripts/run-app.mjs   # start the app for real use (refuses unsafe data folders or an unfused binary)
```

In a headless Linux container running as root, use `scripts/e2e-container.sh` instead of `pnpm test:e2e`. It runs the suite as an unprivileged user under Xvfb, so the Chromium sandbox stays on.

Manual demo (after `pnpm build`): `node apps/desktop/scripts/run-poc.mjs`. It starts the synthetic site, prints the paths of two synthetic exports, and opens the app.

## Safety rules

- Never commit cookies, exports, browser profiles, sealed snapshots or credentials. `.gitignore` covers them and the pre-commit hook blocks them; never use `git commit --no-verify`.
- Never paste real cookies, exports, Kalodata pages or Kalodata data into Claude or any AI service (Kalodata ToS §14.6; D16). Share only `pnpm security-check` output and evidence counts.
- Kalodata: manual browsing only. The app sends nothing to Kalodata on its own (status is confirmed by you), and no Kalodata automation exists or may be added without written permission (D14, D16).
- Before any real-cookie work (Gate 2+), enable cookie encryption on the local Electron binary and check it:
  `node apps/desktop/scripts/enable-dev-fuses.mjs` then `node apps/desktop/scripts/enable-dev-fuses.mjs --check` (must print `ON`). The app refuses imports otherwise.
- Real-account testing happens only on the owner's Windows machine, never in a cloud session.
