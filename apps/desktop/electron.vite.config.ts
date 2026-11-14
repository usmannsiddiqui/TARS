import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    // @companion/domain ships TypeScript source, so it is bundled instead of required at runtime.
    build: { externalizeDeps: { exclude: ["@companion/domain"] } },
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: { rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {},
});
