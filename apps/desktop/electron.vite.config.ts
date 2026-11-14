import { resolve } from "node:path";
import { defineConfig, loadEnv } from "electron-vite";

export default defineConfig(({ mode }) => {
  // The Convex deployment URL is public (not a secret) and fixed at build time; the CSP allows only its origin.
  const env = loadEnv(mode, resolve(import.meta.dirname, "../.."), ["CONVEX_", "AUTH0_"]);
  const httpsOrigin = (name: string, example: string) => {
    const raw = env[name];
    if (!raw || !URL.canParse(raw) || new URL(raw).protocol !== "https:") {
      throw new Error(`Set ${name} (https://…${example}) in the repository's .env.local before building`);
    }
    return new URL(raw);
  };
  const convex = httpsOrigin("CONVEX_URL", "convex.cloud");
  const define = { "import.meta.env.CONVEX_URL": JSON.stringify(convex.origin) };
  // Dictation uploads go from the main process only, so the site origin is not added to the renderer's CSP.
  const site = httpsOrigin("CONVEX_SITE_URL", "convex.site");
  return {
    main: {
      define: {
        ...define,
        "import.meta.env.CONVEX_SITE_URL": JSON.stringify(site.origin),
        // A packaged app started from Finder has no shell environment, so the Auth0 tenant and client ID
        // (public identifiers, not secrets) are fixed at build time too. Empty means sign-in is not configured.
        "import.meta.env.AUTH0_DOMAIN": JSON.stringify(env["AUTH0_DOMAIN"] ?? ""),
        "import.meta.env.AUTH0_CLIENT_ID": JSON.stringify(env["AUTH0_CLIENT_ID"] ?? ""),
      },
      // @companion/domain ships TypeScript source, so it is bundled instead of required at runtime.
      build: { externalizeDeps: { exclude: ["@companion/domain"] } },
    },
    preload: {
      // Sandboxed preload scripts must be CommonJS.
      build: { rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
    },
    renderer: {
      define,
      plugins: [
        {
          name: "convex-connect-src",
          transformIndexHtml(html: string) {
            const directive = "connect-src 'self'";
            if (!html.includes(directive)) throw new Error("index.html CSP has no connect-src to extend");
            // HTTPS for queries/mutations, WSS for the live subscription; nothing else may be contacted.
            return html.replace(directive, `${directive} ${convex.origin} wss://${convex.host}`);
          },
        },
      ],
    },
  };
});
