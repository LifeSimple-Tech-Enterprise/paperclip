import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub CI Bridge",
  description:
    "Receives GitHub workflow_run completion webhooks, verifies HMAC-SHA256 signatures, resolves the triggering issue from branch metadata, and wakes the assigned agent with CI outcome context.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: ["webhooks.receive", "database.namespace.migrate", "database.namespace.read"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  instanceConfigSchema: {
    type: "object",
    required: ["webhookSecret"],
    properties: {
      webhookSecret: {
        type: "array",
        title: "Webhook Secrets",
        description:
          "One or more HMAC-SHA256 secrets used to verify incoming GitHub webhook signatures. Supports rotation: add the new secret, drain old deliveries, then remove the old secret.",
        items: { type: "string" },
        minItems: 1,
        // encrypted:true is a Paperclip SDK extension alongside standard JSON Schema fields.
        encrypted: true,
      },
      repoAllowlist: {
        type: "array",
        title: "Repository Allowlist",
        description:
          "Optional. When non-empty, only workflow_run events from these repo full names (e.g. 'org/repo') are processed. Empty means all repos are accepted.",
        items: { type: "string" },
      },
    },
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.ciEvent,
      displayName: "CI Event",
      description: "GitHub workflow_run completion relay endpoint.",
    },
  ],
};

export default manifest;
