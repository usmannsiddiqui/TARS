// Replaced at build time by electron.vite.config.ts with the Convex deployment origins (public, not secrets).
interface ImportMetaEnv {
  readonly CONVEX_URL: string;
  /** Convex HTTP actions origin (https://…convex.site), main process only. */
  readonly CONVEX_SITE_URL: string;
  /** Auth0 tenant hostname and Native client ID, main process only; empty when sign-in is not configured. */
  readonly AUTH0_DOMAIN: string;
  readonly AUTH0_CLIENT_ID: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
