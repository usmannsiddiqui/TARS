import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // Each test launches the real app and asserts on window focus and visibility. Two instances on
  // one desktop steal activation from each other, so these cannot run in parallel.
  workers: 1,
});
