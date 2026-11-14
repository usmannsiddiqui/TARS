// Replaced at build time by electron.vite.config.ts with the Convex deployment origins (public, not secrets).
interface ImportMetaEnv {
  readonly CONVEX_URL: string;
  /** Convex HTTP actions origin (https://…convex.site), main process only. */
  readonly CONVEX_SITE_URL: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
