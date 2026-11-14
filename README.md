# Companion

A Mac-first companion app for entrepreneurs with ADHD: quick capture, project-scoped context and prepared next steps.
Electron + React + TypeScript desktop app; Convex for owner-isolated cloud state and push subscriptions; Auth0 for native sign-in.
Captures are saved first to an encrypted local SQLite queue, so they survive restarts and offline use.
The renderer is sandboxed and talks to the main process only through a narrow, schema-validated IPC API.
Status: foundation only. Live Auth0 sign-in is implemented but **unverified** (no tenant yet).

## Scripts (run from the repo root, with pnpm)

| Script | What it does |
| --- | --- |
| `pnpm test:unit` | Vitest unit tests in `tests/unit` |
| `pnpm test:integration` | Vitest integration tests in `tests/integration` (Convex) |
| `pnpm test:e2e` | Playwright drives the packaged app (`pnpm package:mac` first) |
| `pnpm typecheck` | TypeScript for tests, domain, Convex and every workspace package |
| `pnpm lint` | ESLint |
| `pnpm build` | electron-vite build of the desktop app into `apps/desktop/out` |
| `pnpm package:mac` | Unsigned arm64 `.app` in `apps/desktop/release/mac-arm64` |
| `pnpm --filter @companion/desktop dev` | Run the desktop app against the Vite dev server |
| `pnpm verify` | typecheck + lint + unit + integration |

## Environment

Names are listed in `.env.example`; values live in `.env.local` (git-ignored) or the Convex dashboard.
The desktop main process reads `AUTH0_DOMAIN` and `AUTH0_CLIENT_ID`. Without them the app shows "Not signed in"
and sign-in reports that it is not configured. The Auth0 application must allow the callback
`http://127.0.0.1:51735/callback`.

## Third-party code and libraries

All external code is used as published npm packages; no third-party source was copied into this repo.

| Package | Used for | License |
| --- | --- | --- |
| electron | Desktop runtime, safeStorage (Keychain-protected keys) | MIT |
| electron-vite | Build tooling for main/preload/renderer | MIT |
| electron-builder | Packaging the macOS app | MIT |
| vite | Bundler used by electron-vite | MIT |
| react, react-dom | Renderer UI | MIT |
| better-sqlite3 | Local durable capture queue | MIT |
| zod | Runtime schema validation at IPC/storage boundaries | MIT |
| convex, convex-test | Cloud backend and its test harness | Apache-2.0 |
| @edge-runtime/vm | Edge runtime for Convex tests | MIT |
| vitest | Unit and integration tests | MIT |
| @playwright/test | Packaged-app end-to-end test | Apache-2.0 |
| typescript, @types/node, @types/react, @types/react-dom, @types/better-sqlite3 | Type checking | Apache-2.0 / MIT |
| eslint, typescript-eslint | Linting | MIT |

Standards followed (not code): RFC 8252 (OAuth for native apps), RFC 7636 (PKCE; its Appendix B test vector is used in `tests/unit/auth.test.ts`), OpenID Connect Core.
