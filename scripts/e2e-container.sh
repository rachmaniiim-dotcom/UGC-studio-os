#!/usr/bin/env bash
# Runs the Electron end-to-end tests in a headless Linux container.
# Chromium refuses to start as root without --no-sandbox; rather than weaken
# the sandbox, this runs the suite as an unprivileged user under Xvfb.
# On a normal desktop (Windows, or Linux as a regular user) run
# `pnpm test:e2e` directly instead.
set -euo pipefail
cd "$(dirname "$0")/.."
user="${E2E_USER:-ugcpoc}"
if [ "$(id -u)" -eq 0 ]; then
  id "$user" >/dev/null 2>&1 || useradd -m -s /bin/bash "$user"
  exec runuser -u "$user" -- env -u NODE_OPTIONS -u NPM_CONFIG_USERCONFIG -u NODE_EXTRA_CA_CERTS HOME="/home/$user" xvfb-run -a pnpm --filter @ugc/desktop test:e2e "$@"
fi
exec env -u NODE_OPTIONS xvfb-run -a pnpm --filter @ugc/desktop test:e2e "$@"
