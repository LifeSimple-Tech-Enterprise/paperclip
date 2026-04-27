/**
 * Issue resolver tests for github-ci-bridge — TDD red phase (LIF-343 §4).
 *
 * Tests `resolveIssue(payload, dbHandle)` from src/worker.ts.
 * Reference: LIF-335 plan §4.2.
 *
 * All tests call `resolveIssue` which currently throws "not implemented",
 * so every test fails red until Drafter (LIF-341) implements it.
 */

import { describe, expect, it } from "vitest";
import { resolveIssue } from "../src/worker.js";

// ---------------------------------------------------------------------------
// In-memory DB stub
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  sourceIssueId: string;
  branchName: string;
  repoUrl: string;
}

interface IssueRow {
  id: string;
  identifier: string;
}

function createDbHandle(
  workspaces: WorkspaceRow[],
  issues: IssueRow[],
) {
  return {
    executionWorkspaces: workspaces,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const WORKSPACES: WorkspaceRow[] = [
  {
    sourceIssueId: "issue-A",
    branchName: "lif-200-feat",
    repoUrl: "https://github.com/isaacyip007/calmnotify",
  },
  {
    sourceIssueId: "issue-B",
    branchName: "fix/auth",
    repoUrl: "https://github.com/isaacyip007/paperclip-mod",
  },
];

const ISSUES: IssueRow[] = [
  { id: "issue-A", identifier: "LIF-200" },
  { id: "issue-B-ident", identifier: "LIF-201" },
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("resolveIssue", () => {
  it("3.1 resolves via workflow_run.pull_requests[0].head.ref + repo.full_name", async () => {
    const payload = {
      pull_requests: [{ head: { ref: "lif-200-feat" } }],
      repository: { full_name: "isaacyip007/calmnotify" },
      head_branch: "lif-200-feat",
    };
    const db = createDbHandle(WORKSPACES, ISSUES);

    const result = await resolveIssue(payload, db);

    expect(result).toEqual({ issueId: "issue-A" });
  });

  it("3.2 empty pull_requests → falls back to workflow_run.head_branch", async () => {
    const payload = {
      pull_requests: [],
      repository: { full_name: "isaacyip007/paperclip-mod" },
      head_branch: "fix/auth",
    };
    const db = createDbHandle(WORKSPACES, ISSUES);

    const result = await resolveIssue(payload, db);

    expect(result).toEqual({ issueId: "issue-B" });
  });

  it("3.3 branch regex /(LIF|PAP|[A-Z]{2,5})-\\d+/ matches existing issue identifier", async () => {
    const payload = {
      pull_requests: [],
      repository: { full_name: "isaacyip007/calmnotify" },
      head_branch: "feature/LIF-201-tweaks",
    };
    const db = createDbHandle(WORKSPACES, ISSUES);

    const result = await resolveIssue(payload, db);

    expect(result).toEqual({ issueId: "issue-B-ident" });
  });

  it("3.4 branch regex matches but identifier does not exist → unresolved", async () => {
    const payload = {
      pull_requests: [],
      repository: { full_name: "isaacyip007/calmnotify" },
      head_branch: "feature/LIF-9999-nope",
    };
    const db = createDbHandle(WORKSPACES, ISSUES);

    const result = await resolveIssue(payload, db);

    expect(result).toEqual({ issueId: null, unresolved: true });
  });

  it("3.5 no execution_workspace and no regex match → null + unresolved", async () => {
    const payload = {
      pull_requests: [],
      repository: { full_name: "isaacyip007/calmnotify" },
      head_branch: "main",
    };
    const db = createDbHandle(WORKSPACES, ISSUES);

    const result = await resolveIssue(payload, db);

    expect(result).toEqual({ issueId: null, unresolved: true });
  });
});
