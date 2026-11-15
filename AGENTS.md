# Agent instructions

- Prefix every shell command with `rtk`. pnpm only (`rtk pnpm ...`); never npm or yarn.
- No polling: never fetch or check data on a timer. Use Convex subscriptions, webhooks, native file/app events.
- One implementation per feature: replace old code entirely; no fallback paths, compatibility layers or dead code.
- Test-driven: write the named failing test, see it fail for the right reason, implement the minimum, rerun green.
  Never weaken an assertion to pass. A run must show executed tests, not "no tests found".
- Keep validation, error handling, security and accessibility; build only what the task needs.
- Secrets only in `.env*` (git-ignored) or the Convex dashboard; `.env.example` holds names only.
- Owner identity comes from the verified session in the main process / Convex auth, never from the renderer.

## Paths

- `packages/domain/src/` — pure shared types and policies (Zod schemas at boundaries), no I/O.
- `apps/desktop/src/main/` — Electron main: `index.ts` (window, app:// protocol, CSP/navigation), `ipc.ts` (allowlisted router),
  `local-store.ts` (encrypted SQLite queue), `auth.ts` (Auth0 PKCE + loopback).
- `apps/desktop/src/preload/index.ts` — the only renderer bridge; typed methods only.
- `apps/desktop/src/renderer/` — React UI.
- `convex/` — backend functions and schema.
- `tests/unit`, `tests/integration`, `tests/e2e`; `tests/fixtures.ts` has illustrative Alice/Bob data only.
- Do not touch `research-assets/` or `HACKATHON_PRODUCT_HANDOFF.md` (private, git-ignored).

## Checks

`rtk pnpm verify`, then `rtk pnpm package:mac && rtk pnpm test:e2e` for the packaged app.
