import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-github-ci-bridge",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub CI Bridge",
  description:
    "Receives GitHub workflow_run completion webhooks, resolves the linked Paperclip issue from local state, and reacts (comment + state-aware wake).",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["webhooks.receive"],
  webhooks: [
    {
      endpointKey: "ci_event",
      displayName: "GitHub workflow_run relay",
      description:
        "Inbound HMAC-signed delivery from .github/workflows/paperclip-ci-webhook.yml. Carries the workflow_run completion payload.",
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
