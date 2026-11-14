import { resolve } from "node:path";
import { defineConfig, loadEnv } from "electron-vite";

export default defineConfig(({ mode }) => {
  // The Convex deployment URL is public (not a secret) and fixed at build time; the CSP allows only its origin.
  const raw = loadEnv(mode, resolve(import.meta.dirname, "../.."), "CONVEX_URL")["CONVEX_URL"];
  if (!raw || !URL.canParse(raw) || new URL(raw).protocol !== "https:") {
    throw new Error("Set CONVEX_URL (https://…convex.cloud) in the repository's .env.local before building");
  }
  const convex = new URL(raw);
  const define = { "import.meta.env.CONVEX_URL": JSON.stringify(convex.origin) };
  return {
    main: {
      define,
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
