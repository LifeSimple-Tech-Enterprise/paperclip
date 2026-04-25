import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "packages/hermes-agent",
      "server",
      "ui",
      "cli",
    ],
  },
});
