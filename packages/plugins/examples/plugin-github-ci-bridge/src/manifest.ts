import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "github-ci-bridge",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub CI Bridge",
  description: "Reacts to GitHub CI workflow_run events and wakes Paperclip agents or appends to scratchpad",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["webhooks.receive"],
  entrypoints: { worker: "dist/worker.js" },
  webhooks: [
    { endpointKey: "ci_event", description: "Receives GitHub workflow_run webhook events relayed by paperclip-ci-webhook.yml" },
  ],
};

export default manifest;
