import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/release/**", "convex/_generated/**", "research-assets/**"] },
  ...tseslint.configs.recommended,
);
