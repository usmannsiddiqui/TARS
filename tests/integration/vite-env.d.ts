// Vite (bundled inside Vitest) rewrites `import.meta.glob` at test time; vite's own
// client types are not resolvable from the workspace root, so declare only what tests use.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
