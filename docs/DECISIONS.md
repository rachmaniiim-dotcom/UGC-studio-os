# Decision Log

Product-owner decisions on the Gate 0 proposals (`docs/gate-0/ARCHITECTURE_REPORT.md` §27). Where this log differs from the Gate 0 report, this log wins.

| ID | Decision | Status | Date |
|---|---|---|---|
| Gate 0 | Architecture direction **conditionally approved**; Gate 1 authorized in the Linux cloud environment | Approved | 2026-10-22 |
| D1 | Windows environment inspection and Windows runtime validation **deferred** (owner away from the laptop). Results must not be invented | Done: Windows validation **accepted** by the owner | 2026-10-22 |
| D13 | Limited Gate 1 hardening pass before Gate 2: reliable Electron install, fuse-independent encryption tests, minimum DPAPI-backed session-cookie restore prototype (not the Gate 3 vault), real file-dialog validation | Approved, implemented | 2026-10-22 |
| D14 | **Kalodata ToS §4.1.8 restricts automated scripts** (owner finding). No Kalodata automation without established permission or an authorized alternative (R-03) | Approved | 2026-10-22 |
| D2 | Four-workspace layout, **provisionally**. Gate 1 created `apps/desktop`, `packages/core`, `packages/test-fixtures`; `packages/vault` is deferred to Gate 3 because Gate 1 excludes the final encryption abstraction | Provisional | 2026-10-22 |
| D3 | Enable Electron cookie encryption (`EnableCookieEncryption` fuse) for the packaged app; verify when packaging exists. Real cookies must never sit in unencrypted browser databases | Approved | 2026-10-22 |
| D5 | **Changed from the Gate 0 proposal.** Conflicting duplicate cookies are **rejected** (every entry in the group) with a non-sensitive diagnostic; the importer never picks the latest expiry. Exact duplicates collapse to one | Approved, implemented | 2026-10-22 |
| D10 | **Changed.** Affiliate yellow-basket attachment stays an **automation objective**, not an assisted-only design. It is not assumed that ordinary TikTok scheduling supports shoppable product attachment; recorded as integration risk R-01 needing real validation | Approved | 2026-10-22 |
| D11 | **Changed.** Google Flow stays the **preferred** video provider. Authentication-portability risks and a possible authorized API fallback are documented (risk R-02) | Approved | 2026-10-22 |
| D4, D6, D7, D8, D9, D12 | Not yet decided | Open | — |
