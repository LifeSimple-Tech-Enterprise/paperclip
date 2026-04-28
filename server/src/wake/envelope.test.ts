import { describe, expect, it } from "vitest";
import { buildWakeEnvelope } from "./envelope.js";

describe("buildWakeEnvelope", () => {
  it("returns null envelope when both wakeRow and claimRow are null", () => {
    const env = buildWakeEnvelope({ wakeRow: null, claimRow: null, issueId: null });
    expect(env.reason).toBeNull();
    expect(env.taskId).toBeNull();
    expect(env.runId).toBeNull();
    expect(env.commentId).toBeNull();
    expect(env.approvalId).toBeNull();
    expect(env.linkedIssueIds).toEqual([]);
    expect(env.payload).toBeNull();
  });

  it("reads reason from wakeRow first", () => {
    const env = buildWakeEnvelope({
      wakeRow: { reason: "issue_assigned" },
      claimRow: { id: "run-1", contextSnapshot: { wakeReason: "issue_commented" } },
      issueId: null,
    });
    expect(env.reason).toBe("issue_assigned");
  });

  it("falls back to contextSnapshot.wakeReason when wakeRow has no reason", () => {
    const env = buildWakeEnvelope({
      wakeRow: { reason: null },
      claimRow: { id: "run-1", contextSnapshot: { wakeReason: "issue_commented" } },
      issueId: null,
    });
    expect(env.reason).toBe("issue_commented");
  });

  it("reads taskId from contextSnapshot.issueId first", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: { issueId: "issue-ctx-1", taskId: "issue-ctx-2" } },
      issueId: "issue-fallback",
    });
    expect(env.taskId).toBe("issue-ctx-1");
  });

  it("falls back taskId to issueId parameter", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: {} },
      issueId: "issue-fallback",
    });
    expect(env.taskId).toBe("issue-fallback");
  });

  it("reads runId from claimRow.id", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-42", contextSnapshot: {} },
      issueId: null,
    });
    expect(env.runId).toBe("run-42");
  });

  it("reads commentId from contextSnapshot.wakeCommentId", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: { wakeCommentId: "comment-abc" } },
      issueId: null,
    });
    expect(env.commentId).toBe("comment-abc");
  });

  it("falls back commentId to contextSnapshot.commentId", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: { commentId: "comment-xyz" } },
      issueId: null,
    });
    expect(env.commentId).toBe("comment-xyz");
  });

  it("reads linkedIssueIds from contextSnapshot.issueIds array", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: { issueIds: ["id-1", "id-2", ""] } },
      issueId: null,
    });
    // empty strings are filtered out
    expect(env.linkedIssueIds).toEqual(["id-1", "id-2"]);
  });

  it("reads payload from wakeRow.payload", () => {
    const payload = { customField: "value" };
    const env = buildWakeEnvelope({
      wakeRow: { payload },
      claimRow: { id: "run-1", contextSnapshot: {} },
      issueId: null,
    });
    expect(env.payload).toEqual(payload);
  });

  it("returns null payload when wakeRow is null", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: {} },
      issueId: null,
    });
    expect(env.payload).toBeNull();
  });

  it("reads approvalId from contextSnapshot", () => {
    const env = buildWakeEnvelope({
      wakeRow: null,
      claimRow: { id: "run-1", contextSnapshot: { approvalId: "approval-1" } },
      issueId: null,
    });
    expect(env.approvalId).toBe("approval-1");
  });
});
