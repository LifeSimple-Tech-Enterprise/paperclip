import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "recovery-watchdog",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Recovery Watchdog",
  description:
    "Detects heartbeat runs silent >1 h whose issue is a blocker of a parent in status=blocked, then creates a recovery task if none exists.",
  author: "LifeSimple Tech",
  categories: ["automation"],
  capabilities: [
    "issues.read",
    "issues.create",
    "issue.relations.read",
    "agents.read",
    "jobs.schedule",
    "database.namespace.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs"],
  },
  jobs: [
    {
      jobKey: "check-stale-blocked-parents",
      displayName: "Stale blocked parent watchdog",
      description:
        "Scans for heartbeat runs silent >1 h whose issue blocks a parent in status=blocked, then creates a recovery issue if none exists.",
      schedule: "*/5 * * * *",
    },
  ],
};

export default manifest;
