import { describe, expect, it } from "vitest";
import { resolveIssue, type ResolveIssueDeps } from "../src/worker.js";

import successPayload from "./fixtures/workflow-run.success.json" with { type: "json" };
import failurePayload from "./fixtures/workflow-run.failure.json" with { type: "json" };
import unresolvablePayload from "./fixtures/workflow-run.unresolvable.json" with { type: "json" };

/**
 * LIF-343 §4 — Issue resolver (no outbound HTTP, payload + local DB only).
 *
 * Order: workflow_run.pull_requests[0].head.ref → workflow_run.head_branch →
 * regex /(LIF|PAP|[A-Z]{2,5})-\d+/ on the branch name.
 *
 * RED-phase: `resolveIssue` throws "not implemented".
 */

function makeDeps(
  overrides: Partial<ResolveIssueDeps> = {},
): ResolveIssueDeps & {
  workspaceLookups: Array<{ branchName: string; repoFullName: string }>;
  identifierLookups: string[];
} {
  const workspaceLookups: Array<{ branchName: string; repoFullName: string }> = [];
  const identifierLookups: string[] = [];

  return {
    async findExecutionWorkspace(branchName, repoFullName) {
      workspaceLookups.push({ branchName, repoFullName });
      return null;
    },
    async findIssueByIdentifier(identifier) {
      identifierLookups.push(identifier);
      return null;
    },
    workspaceLookups,
    identifierLookups,
    ...overrides,
  };
}

describe("resolveIssue (github-ci-bridge plugin)", () => {
  it("3.1 resolves via workflow_run.pull_requests[0].head.ref + repo.full_name → execution_workspaces lookup", async () => {
    const deps = makeDeps({
      async findExecutionWorkspace(branchName, repoFullName) {
        if (branchName === "lif-200-feat" && repoFullName === "isaacyip007/calmnotify") {
          return "issue-A-uuid";
        }
        return null;
      },
    });

    const result = await resolveIssue(successPayload, deps);

    expect(result.issueId).toBe("issue-A-uuid");
    expect(result.unresolved).toBeFalsy();
  });

  it("3.2 falls back to workflow_run.head_branch when pull_requests is empty", async () => {
    // Build a payload with empty pull_requests but a head_branch we map.
    const payload = JSON.parse(JSON.stringify(unresolvablePayload));
    payload.workflow_run.head_branch = "fix/auth";
    payload.workflow_run.repository.full_name = "isaacyip007/paperclip-mod";
    payload.repository.full_name = "isaacyip007/paperclip-mod";

    const deps = makeDeps({
      async findExecutionWorkspace(branchName, repoFullName) {
        if (branchName === "fix/auth" && repoFullName === "isaacyip007/paperclip-mod") {
          return "issue-B-uuid";
        }
        return null;
      },
    });

    const result = await resolveIssue(payload, deps);

    expect(result.issueId).toBe("issue-B-uuid");
  });

  it("3.3 falls back to branch regex `/(LIF|PAP|[A-Z]{2,5})-\\d+/` when no execution_workspace match", async () => {
    const payload = JSON.parse(JSON.stringify(failurePayload));
    payload.workflow_run.head_branch = "feature/LIF-201-tweaks";
    payload.workflow_run.pull_requests[0].head.ref = "feature/LIF-201-tweaks";

    const deps = makeDeps({
      async findExecutionWorkspace() {
        return null; // no workspace match
      },
      async findIssueByIdentifier(identifier) {
        if (identifier === "LIF-201") return "issue-C-uuid";
        return null;
      },
    });

    const result = await resolveIssue(payload, deps);

    expect(result.issueId).toBe("issue-C-uuid");
  });

  it("3.4 returns unresolved when regex matches an identifier but the issue does not exist", async () => {
    const payload = JSON.parse(JSON.stringify(failurePayload));
    payload.workflow_run.head_branch = "feature/LIF-9999-nope";
    payload.workflow_run.pull_requests[0].head.ref = "feature/LIF-9999-nope";

    const deps = makeDeps({
      async findIssueByIdentifier() {
        return null; // identifier not found
      },
    });

    const result = await resolveIssue(payload, deps);

    expect(result.issueId).toBeNull();
    expect(result.unresolved).toBe(true);
  });

  it("3.5 returns unresolved (drop event, no comment, no wake) when neither workspace nor regex matches", async () => {
    const deps = makeDeps();

    const result = await resolveIssue(unresolvablePayload, deps);

    expect(result.issueId).toBeNull();
    expect(result.unresolved).toBe(true);
    // The plugin must have at least attempted the workspace lookup.
    expect(deps.workspaceLookups.length).toBeGreaterThanOrEqual(1);
  });
});
