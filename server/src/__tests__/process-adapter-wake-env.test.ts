// Stage 1 (LIF-382): verify that buildPaperclipEnv correctly emits ctx.wake fields
// as PAPERCLIP_WAKE_* environment variables for child process adapters.

import { describe, expect, it } from "vitest";
import { buildPaperclipEnv } from "../adapters/utils.js";
import type { PaperclipWakeEnvelope } from "@paperclipai/adapter-utils";

const AGENT = { id: "agent-abc", companyId: "company-xyz" };

describe("buildPaperclipEnv with wake envelope", () => {
  it("emits no wake vars when wake is undefined", () => {
    const env = buildPaperclipEnv(AGENT);
    expect(env).not.toHaveProperty("PAPERCLIP_TASK_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_REASON");
    expect(env).not.toHaveProperty("PAPERCLIP_RUN_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_COMMENT_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_APPROVAL_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_LINKED_ISSUE_IDS");
  });

  it("emits all wake vars when full envelope is provided", () => {
    const wake: PaperclipWakeEnvelope = {
      reason: "issue_commented",
      taskId: "issue-123",
      runId: "run-456",
      commentId: "comment-789",
      approvalId: "approval-abc",
      linkedIssueIds: ["issue-001", "issue-002"],
      payload: null,
    };
    const env = buildPaperclipEnv(AGENT, wake);
    expect(env.PAPERCLIP_WAKE_REASON).toBe("issue_commented");
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-123");
    expect(env.PAPERCLIP_RUN_ID).toBe("run-456");
    expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-789");
    expect(env.PAPERCLIP_WAKE_APPROVAL_ID).toBe("approval-abc");
    expect(env.PAPERCLIP_WAKE_LINKED_ISSUE_IDS).toBe("issue-001,issue-002");
  });

  it("omits vars for null/empty wake fields", () => {
    const wake: PaperclipWakeEnvelope = {
      reason: "issue_assigned",
      taskId: "issue-1",
      runId: null,
      commentId: null,
      approvalId: null,
      linkedIssueIds: [],
      payload: null,
    };
    const env = buildPaperclipEnv(AGENT, wake);
    expect(env.PAPERCLIP_WAKE_REASON).toBe("issue_assigned");
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-1");
    expect(env).not.toHaveProperty("PAPERCLIP_RUN_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_COMMENT_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_APPROVAL_ID");
    expect(env).not.toHaveProperty("PAPERCLIP_WAKE_LINKED_ISSUE_IDS");
  });

  it("still includes AGENT_ID and COMPANY_ID from base env", () => {
    const wake: PaperclipWakeEnvelope = {
      reason: "manual",
      taskId: null,
      runId: null,
      commentId: null,
      approvalId: null,
      linkedIssueIds: [],
      payload: null,
    };
    const env = buildPaperclipEnv(AGENT, wake);
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-abc");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("company-xyz");
  });
});
