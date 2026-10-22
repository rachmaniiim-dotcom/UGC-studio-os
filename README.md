# UGC Production OS

Multi-account AI UGC research, production and publishing platform. Windows desktop first (Electron); a Linux automation backend later.

**Current stage: Gate 1, synthetic session proof of concept.** Only synthetic data. This build rejects every cookie outside the local test domain `ugc-poc.test`, so it can't load real-site sessions.

- Spec: `MASTER_SPEC.md` (kept by the product owner)
- Architecture: [`docs/gate-0/ARCHITECTURE_REPORT.md`](docs/gate-0/ARCHITECTURE_REPORT.md)
- Gate 1 results: [`docs/gate-1/GATE1_REPORT.md`](docs/gate-1/GATE1_REPORT.md)
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

Requires Node ≥ 22.12 and pnpm 10.28 (`corepack enable`).

```sh
pnpm install
pnpm typecheck          # builds everything, then typechecks the tests
pnpm test:unit          # Vitest
pnpm test:e2e           # Playwright driving real Electron (needs a desktop session)
pnpm check:secrets      # scans the repo for secrets and synthetic canaries
```

In a headless Linux container running as root, use `scripts/e2e-container.sh` instead of `pnpm test:e2e`. It runs the suite as an unprivileged user under Xvfb, so the Chromium sandbox stays on.

Manual demo (after `pnpm build`): `node apps/desktop/scripts/run-poc.mjs`. It starts the synthetic site, prints the paths of two synthetic exports, and opens the app.

## Safety rules

- Never commit cookies, exports, browser profiles or credentials. `.gitignore` covers the usual names, and `pnpm check:secrets` must pass.
- Before any real-cookie work (Gate 2+), enable cookie encryption on the local Electron binary and check it:
  `node apps/desktop/scripts/enable-dev-fuses.mjs` then `node apps/desktop/scripts/enable-dev-fuses.mjs --check` (must print `ON`). The app refuses imports otherwise.
- Real-account testing happens only on the owner's Windows machine, never in a cloud session.
