import { defineConfig } from "vitest/config";

// Browser tests against the built UI; they need `pnpm build` and PLAYWRIGHT_BROWSERS_PATH (see nix/e2e.nix).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // Keep one Chromium fixture at a time within the two-core Nix check budget.
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
