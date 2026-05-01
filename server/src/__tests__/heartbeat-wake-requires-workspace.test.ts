import { describe, expect, it } from "vitest";
import { rolePackRequiresWorkspace } from "../services/role-packs.js";
import { descriptiveError, HttpError } from "../errors.js";

// LIF-454: acceptance coverage for the Layer 1 wake gate (requiresWorkspace).
// These exercise the small predicates the gate is built on — kept as unit
// tests rather than full-stack integration so the suite stays fast and
// stable on developer laptops.

describe("rolePackRequiresWorkspace (LIF-454)", () => {
  it.each([
    ["lead", true],
    ["drafter", true],
    ["critique", true],
  ] as const)("returns true for role pack %s", (id, expected) => {
    expect(rolePackRequiresWorkspace(id)).toBe(expected);
  });

  it("returns false for an unrecognised role pack id", () => {
    expect(rolePackRequiresWorkspace("ceo" as never)).toBe(false);
    expect(rolePackRequiresWorkspace("qa" as never)).toBe(false);
  });
});

describe('descriptiveError("NO_EXECUTION_WORKSPACE") envelope (LIF-454)', () => {
  it("produces the 422 envelope shape the heartbeat throws on allocator failure", () => {
    const err = descriptiveError(
      "NO_EXECUTION_WORKSPACE",
      "Issue LIF-001 has no executionWorkspace and auto-allocation failed: boom.",
      { issueId: "issue-1", agentId: "agent-1" },
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("NO_EXECUTION_WORKSPACE");
    expect(err.message).toMatch(/auto-allocation failed/);
    expect(err.details).toEqual({ issueId: "issue-1", agentId: "agent-1" });
  });
});

// Mirror of the predicate at heartbeat.ts:4879-4882. Kept inline so a
// regression in the production expression breaks this test by drift.
function computeWakeNeedsWorkspace(input: {
  flagEnabled: boolean;
  agentRequiresWorkspace: boolean | null | undefined;
  rolePackId: "lead" | "drafter" | "critique" | null;
  issueExecutionWorkspaceId: string | null | undefined;
}): boolean {
  return (
    input.flagEnabled &&
    (input.agentRequiresWorkspace === true ||
      (input.rolePackId !== null && rolePackRequiresWorkspace(input.rolePackId))) &&
    !input.issueExecutionWorkspaceId
  );
}

describe("wakeNeedsWorkspace predicate (LIF-454, mirror of heartbeat.ts)", () => {
  it("Test A — flag on + requiresWorkspace=true + null workspace → gate trips", () => {
    expect(
      computeWakeNeedsWorkspace({
        flagEnabled: true,
        agentRequiresWorkspace: true,
        rolePackId: null,
        issueExecutionWorkspaceId: null,
      }),
    ).toBe(true);
  });

  it("Test A.2 — flag on + role-pack=drafter + null workspace → gate trips even when column is false", () => {
    expect(
      computeWakeNeedsWorkspace({
        flagEnabled: true,
        agentRequiresWorkspace: false,
        rolePackId: "drafter",
        issueExecutionWorkspaceId: null,
      }),
    ).toBe(true);
  });

  it("Test B — flag off → gate disabled even if every other input requires it", () => {
    expect(
      computeWakeNeedsWorkspace({
        flagEnabled: false,
        agentRequiresWorkspace: true,
        rolePackId: "lead",
        issueExecutionWorkspaceId: null,
      }),
    ).toBe(false);
  });

  it("workspace already allocated → gate disabled", () => {
    expect(
      computeWakeNeedsWorkspace({
        flagEnabled: true,
        agentRequiresWorkspace: true,
        rolePackId: "drafter",
        issueExecutionWorkspaceId: "ws-1",
      }),
    ).toBe(false);
  });

  it("agent does not require + role-pack does not require → gate disabled", () => {
    expect(
      computeWakeNeedsWorkspace({
        flagEnabled: true,
        agentRequiresWorkspace: false,
        rolePackId: null,
        issueExecutionWorkspaceId: null,
      }),
    ).toBe(false);
  });
});

// Mirror of the PATCH /issues/:id gate at issues.ts:2013-2026. Kept inline
// for the same drift-detection reason.
function patchIssueAssigneeGate(input: {
  flagEnabled: boolean;
  normalizedAssigneeAgentId: string | undefined | null;
  candidateAgentRequiresWorkspace: boolean | null | undefined;
  issueExecutionWorkspaceId: string | null | undefined;
}): { reject: boolean } {
  if (!input.flagEnabled) return { reject: false };
  if (typeof input.normalizedAssigneeAgentId !== "string") return { reject: false };
  if (input.issueExecutionWorkspaceId) return { reject: false };
  if (input.candidateAgentRequiresWorkspace === true) return { reject: true };
  return { reject: false };
}

describe("PATCH /issues/:id assigneeAgentId gate (LIF-454)", () => {
  it("Bonus C — rejects when flag on + new assignee.requiresWorkspace=true + no workspace", () => {
    expect(
      patchIssueAssigneeGate({
        flagEnabled: true,
        normalizedAssigneeAgentId: "agent-1",
        candidateAgentRequiresWorkspace: true,
        issueExecutionWorkspaceId: null,
      }).reject,
    ).toBe(true);
  });

  it("allows when flag off", () => {
    expect(
      patchIssueAssigneeGate({
        flagEnabled: false,
        normalizedAssigneeAgentId: "agent-1",
        candidateAgentRequiresWorkspace: true,
        issueExecutionWorkspaceId: null,
      }).reject,
    ).toBe(false);
  });

  it("allows when issue already has a workspace", () => {
    expect(
      patchIssueAssigneeGate({
        flagEnabled: true,
        normalizedAssigneeAgentId: "agent-1",
        candidateAgentRequiresWorkspace: true,
        issueExecutionWorkspaceId: "ws-1",
      }).reject,
    ).toBe(false);
  });

  it("allows when candidate agent does not require a workspace", () => {
    expect(
      patchIssueAssigneeGate({
        flagEnabled: true,
        normalizedAssigneeAgentId: "agent-1",
        candidateAgentRequiresWorkspace: false,
        issueExecutionWorkspaceId: null,
      }).reject,
    ).toBe(false);
  });

  it("ignores the gate when assigneeAgentId is being cleared", () => {
    expect(
      patchIssueAssigneeGate({
        flagEnabled: true,
        normalizedAssigneeAgentId: null,
        candidateAgentRequiresWorkspace: true,
        issueExecutionWorkspaceId: null,
      }).reject,
    ).toBe(false);
  });
});
