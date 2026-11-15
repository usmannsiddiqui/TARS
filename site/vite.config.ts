import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" so the built page works from any path (a subfolder, a preview link).
export default defineConfig({ base: "./", plugins: [react(), tailwindcss()] });
