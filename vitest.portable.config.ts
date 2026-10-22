import { defineConfig, mergeConfig } from "vitest/config";
import config from "./vitest.config.ts";

export default mergeConfig(
  config,
  defineConfig({
    test: {
      // Darwin's Nix build sandbox denies cross-process inspection; native-check must run these on the host.
      exclude:
        process.platform === "darwin"
          ? ["test/mcp-local.test.ts", "test/mcp-stdio.test.ts", "test/process-probe.test.ts"]
          : [],
    },
  }),
);
