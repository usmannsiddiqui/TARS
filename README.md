# TARS

A Mac desktop companion for entrepreneurs with ADHD. It carries the remembering: it reads the sources you choose,
prepares the next piece of work, keeps your place when you switch projects, and helps you finish one real action.
Built at HackUMass XIV (hacking period 13–15 November 2026).

Electron + React + TypeScript desktop app; Convex for owner-isolated cloud state and push subscriptions; Auth0 for
native sign-in; OpenAI for preparation and transcription. Captures are saved first to an encrypted local SQLite
queue, so they survive restarts and offline use. The renderer is sandboxed and talks to the main process only
through a narrow, schema-validated IPC API. Nothing is polled on a timer: updates arrive through provider events,
Convex subscriptions and native file events.

## Status: what is proven and what is not

| | State |
| --- | --- |
| Sign-in | One real Auth0 sign-in from the packaged app; the backend accepted that identity |
| Preparation | One real model run on illustrative data |
| Notes folder, Claude Code and Codex excerpts | Proven on one Mac |
| Slack, Gmail, Notion, Outlook, Canvas connectors | Built and tested against fixtures; **not yet connected to a real account** |
| Dictation, notifications, app observation, real sends, outcome log | Built; **never run live** |

Tests: 226 unit, 177 integration, 20 end-to-end against the packaged app.

## The app

Three windows from one renderer:

- **The full app.** Today (one recommended start, with TARS at its front desk), Projects, a project with its
  prepared work and editable run-through, Schedule (your meetings and real due dates), TARS's calendar (what it
  did and will do on its own), Connections, What I remember.
- **The pet.** TARS on your desktop with no window around it. Drag it anywhere; it never takes focus on its own.
- **The panel.** Opens when you rest the pointer on the pet (or click it): where you left off, what today holds,
  Open app, Stop for now, quick capture.

Every source starts off; capture works before any source is connected. TARS acts outside the app only on your
explicit instruction, verifies the result, and logs it separately. `tests/e2e/harness/` is a test-only page that
mounts the same screens with illustrative data for visual review; it is never bundled into the app.

## Scripts (run from the repo root, with pnpm)

| Script | What it does |
| --- | --- |
| `pnpm test:unit` | Vitest unit tests in `tests/unit` |
| `pnpm test:integration` | Vitest integration tests in `tests/integration` (Convex) |
| `pnpm test:e2e` | Playwright drives the packaged app (`pnpm package:mac` first) and the test-only screen harness |
| `pnpm typecheck` | TypeScript for tests, domain, Convex and every workspace package |
| `pnpm lint` | ESLint |
| `pnpm build` | electron-vite build of the desktop app into `apps/desktop/out` |
| `pnpm package:mac` | Unsigned arm64 `.app` in `apps/desktop/release/mac-arm64` |
| `pnpm --filter @companion/desktop dev` | Run the desktop app against the Vite dev server |
| `pnpm verify` | typecheck + lint + unit + integration |

## Environment

Names are listed in `.env.example`; values live in `.env.local` (git-ignored) or the Convex dashboard.
`AUTH0_DOMAIN` and `AUTH0_CLIENT_ID` (public identifiers) are built into the desktop app at build time, because
an app opened from Finder has no shell environment; set both on the Convex deployment too. Without them the app
shows "Not signed in". The Auth0 Native application must allow the callback `http://127.0.0.1:51735/callback`.
The Convex deployment also needs `TOKEN_ENCRYPTION_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL` and, for dictation,
`OPENAI_TRANSCRIBE_MODEL`; each connector needs its own provider settings.

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

Brand marks in `apps/desktop/src/renderer/logos.tsx` identify the services and are trademarks of their owners:
Gmail, Notion, Canvas and Claude from Simple Icons (CC0); Slack's mark from slack.com; Outlook's icon from
Microsoft's Fluent brand-icons CDN. The name TARS and the idea of a slab-shaped robot come from a film; the
drawings here are original.

Standards followed (not code): RFC 8252 (OAuth for native apps), RFC 7636 (PKCE; its Appendix B test vector is used in `tests/unit/auth.test.ts`), OpenID Connect Core.
