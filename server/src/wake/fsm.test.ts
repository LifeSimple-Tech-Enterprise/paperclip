import { describe, expect, it } from "vitest";
import {
  evaluateWake,
  evaluateCheckout,
  WAKE_TRANSITIONS,
  type IssueStatus,
  type WakeReason,
} from "./fsm.js";

const ALL_STATUSES: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const ALL_REASONS: WakeReason[] = [
  "issue_assigned",
  "issue_commented",
  "issue_blockers_resolved",
  "issue_children_completed",
  "issue_continuation_needed",
  "issue_comment_mentioned",
  "issue_status_changed",
  "issue_reopened_via_comment",
  "issue_checked_out",
  "issue_tree_restored",
  "approval_approved",
  "transient_failure_retry",
  "plugin_issue_wakeup_requested",
  "manual",
];

describe("WAKE_TRANSITIONS table", () => {
  it("covers every status", () => {
    for (const status of ALL_STATUSES) {
      expect(WAKE_TRANSITIONS).toHaveProperty(status);
    }
  });

  it("covers every reason in every status row", () => {
    for (const status of ALL_STATUSES) {
      const row = WAKE_TRANSITIONS[status];
      for (const reason of ALL_REASONS) {
        expect(row).toHaveProperty(reason);
      }
    }
  });
});

describe("evaluateWake", () => {
  it("backlog + issue_assigned → to(todo)", () => {
    const t = evaluateWake({ currentStatus: "backlog", reason: "issue_assigned" });
    expect(t.kind).toBe("transition");
    if (t.kind === "transition") expect(t.target).toBe("todo");
  });

  it("done + issue_commented → preserve (done_status_flip closed)", () => {
    const t = evaluateWake({ currentStatus: "done", reason: "issue_commented" });
    expect(t.kind).toBe("preserve");
  });

  it("done + issue_reopened_via_comment → to(todo)", () => {
    const t = evaluateWake({ currentStatus: "done", reason: "issue_reopened_via_comment" });
    expect(t.kind).toBe("transition");
    if (t.kind === "transition") expect(t.target).toBe("todo");
  });

  it("cancelled + issue_assigned → no_op (sticky cancelled)", () => {
    const t = evaluateWake({ currentStatus: "cancelled", reason: "issue_assigned" });
    expect(t.kind).toBe("no_op");
  });

  it("cancelled + issue_checked_out → no_op", () => {
    const t = evaluateWake({ currentStatus: "cancelled", reason: "issue_checked_out" });
    expect(t.kind).toBe("no_op");
  });

  it("in_progress + issue_continuation_needed → preserve", () => {
    const t = evaluateWake({ currentStatus: "in_progress", reason: "issue_continuation_needed" });
    expect(t.kind).toBe("preserve");
  });

  it("blocked + issue_blockers_resolved → to(todo)", () => {
    const t = evaluateWake({ currentStatus: "blocked", reason: "issue_blockers_resolved" });
    expect(t.kind).toBe("transition");
    if (t.kind === "transition") expect(t.target).toBe("todo");
  });

  it("any status + issue_checked_out → preserve (checkout owns status)", () => {
    const noopStatuses: IssueStatus[] = ["cancelled"]; // cancelled + checked_out = noop
    for (const status of ALL_STATUSES) {
      if (noopStatuses.includes(status)) continue;
      const t = evaluateWake({ currentStatus: status, reason: "issue_checked_out" });
      expect(t.kind).toBe("preserve");
    }
  });

  it("selfWake=true → no_op regardless of status/reason", () => {
    const t = evaluateWake({ currentStatus: "in_progress", reason: "issue_commented", selfWake: true });
    expect(t.kind).toBe("no_op");
    if (t.kind === "no_op") expect(t.suppressedReason).toBe("self_wake_guard");
  });

  it("throttledContinuation=true + continuation reason → no_op", () => {
    const t = evaluateWake({
      currentStatus: "in_progress",
      reason: "issue_continuation_needed",
      throttledContinuation: true,
    });
    expect(t.kind).toBe("no_op");
    if (t.kind === "no_op") expect(t.suppressedReason).toBe("continuation_throttle");
  });

  it("unknown reason string → preserve (graceful fallback)", () => {
    const t = evaluateWake({ currentStatus: "todo", reason: "some_future_reason_unknown_to_fsm" });
    expect(t.kind).toBe("preserve");
  });
});

describe("evaluateCheckout", () => {
  it("backlog → to(in_progress)", () => {
    const t = evaluateCheckout("backlog");
    expect(t.kind).toBe("transition");
    if (t.kind === "transition") expect(t.target).toBe("in_progress");
  });

  it("todo → to(in_progress)", () => {
    const t = evaluateCheckout("todo");
    expect(t.kind).toBe("transition");
    if (t.kind === "transition") expect(t.target).toBe("in_progress");
  });

  it("in_progress → preserve", () => {
    const t = evaluateCheckout("in_progress");
    expect(t.kind).toBe("preserve");
  });

  it("in_review → preserve", () => {
    const t = evaluateCheckout("in_review");
    expect(t.kind).toBe("preserve");
  });

  it("blocked → preserve (no silent unblock at checkout)", () => {
    const t = evaluateCheckout("blocked");
    expect(t.kind).toBe("preserve");
  });

  it("done → preserve (no silent reopen at checkout)", () => {
    const t = evaluateCheckout("done");
    expect(t.kind).toBe("preserve");
  });

  it("cancelled → preserve (caller error — no mutation)", () => {
    const t = evaluateCheckout("cancelled");
    expect(t.kind).toBe("preserve");
  });
});
