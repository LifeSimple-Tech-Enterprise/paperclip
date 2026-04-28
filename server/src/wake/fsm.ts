// ---------------------------------------------------------------------------
// Wake FSM — exhaustive (state × reason) transition table (LIF-382 / Stage 1)
// Pure function, no IO. Any missing cell is a compile error.
// ---------------------------------------------------------------------------

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type WakeReason =
  | "issue_assigned"
  | "issue_commented"
  | "issue_blockers_resolved"
  | "issue_children_completed"
  | "issue_continuation_needed"
  | "issue_comment_mentioned"
  | "issue_status_changed"
  | "issue_reopened_via_comment"
  | "issue_checked_out"
  | "issue_tree_restored"
  | "approval_approved"
  | "transient_failure_retry"
  | "plugin_issue_wakeup_requested"
  | "manual";

export type WakeTransition =
  | { kind: "no_op"; suppressedReason: string }
  | { kind: "preserve" }
  | { kind: "transition"; target: IssueStatus };

export interface WakeFsmInput {
  currentStatus: IssueStatus;
  reason: WakeReason | string;
  /** true when the comment triggering this wake was authored by the same agent/run */
  selfWake?: boolean;
  /** true when continuation throttle determined this wake should be suppressed */
  throttledContinuation?: boolean;
}

// ---------------------------------------------------------------------------
// Transition table — encoded verbatim from plan §1.
// TypeScript enforces exhaustiveness: every (IssueStatus × WakeReason) pair
// must appear or the compiler errors.
// ---------------------------------------------------------------------------

// Shorthand constructors (reduce noise in the table)
const noop = (suppressedReason: string): WakeTransition => ({ kind: "no_op", suppressedReason });
const preserve = (): WakeTransition => ({ kind: "preserve" });
const to = (target: IssueStatus): WakeTransition => ({ kind: "transition", target });

type TransitionRow = Record<WakeReason, WakeTransition>;

export const WAKE_TRANSITIONS: Record<IssueStatus, TransitionRow> = {
  // Legend: to(X) = transition to X · preserve() = keep current status · noop("…") = suppress wake delivery

  backlog: {
    issue_assigned:                 to("todo"),
    issue_commented:                preserve(),
    issue_blockers_resolved:        to("todo"),
    issue_children_completed:       preserve(),
    issue_continuation_needed:      noop("backlog_continuation_noop"),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     to("todo"),
    issue_checked_out:              preserve(),
    issue_tree_restored:            to("todo"),
    approval_approved:              preserve(),
    transient_failure_retry:        preserve(),
    plugin_issue_wakeup_requested:  preserve(),
    manual:                         preserve(),
  },

  todo: {
    issue_assigned:                 to("in_progress"),
    issue_commented:                preserve(),
    issue_blockers_resolved:        to("todo"),
    issue_children_completed:       preserve(),
    issue_continuation_needed:      noop("todo_continuation_noop"),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     to("todo"),
    issue_checked_out:              preserve(),
    issue_tree_restored:            preserve(),
    approval_approved:              preserve(),
    transient_failure_retry:        preserve(),
    plugin_issue_wakeup_requested:  preserve(),
    manual:                         preserve(),
  },

  in_progress: {
    issue_assigned:                 preserve(),
    issue_commented:                preserve(),
    issue_blockers_resolved:        preserve(),
    issue_children_completed:       preserve(),
    issue_continuation_needed:      preserve(),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     preserve(),
    issue_checked_out:              preserve(),
    issue_tree_restored:            preserve(),
    approval_approved:              preserve(),
    transient_failure_retry:        preserve(),
    plugin_issue_wakeup_requested:  preserve(),
    manual:                         preserve(),
  },

  in_review: {
    issue_assigned:                 preserve(),
    issue_commented:                preserve(),
    issue_blockers_resolved:        preserve(),
    issue_children_completed:       preserve(),
    issue_continuation_needed:      noop("in_review_continuation_noop"),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     preserve(),
    issue_checked_out:              preserve(),
    issue_tree_restored:            preserve(),
    approval_approved:              preserve(),
    transient_failure_retry:        preserve(),
    plugin_issue_wakeup_requested:  preserve(),
    manual:                         preserve(),
  },

  blocked: {
    issue_assigned:                 preserve(),
    issue_commented:                preserve(),
    issue_blockers_resolved:        to("todo"),
    issue_children_completed:       to("todo"),
    issue_continuation_needed:      noop("blocked_continuation_noop"),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     preserve(),
    issue_checked_out:              preserve(),
    issue_tree_restored:            preserve(),
    approval_approved:              preserve(),
    transient_failure_retry:        preserve(),
    plugin_issue_wakeup_requested:  preserve(),
    manual:                         preserve(),
  },

  done: {
    issue_assigned:                 preserve(),
    issue_commented:                preserve(),  // closes done_status_flip
    issue_blockers_resolved:        preserve(),
    issue_children_completed:       preserve(),
    issue_continuation_needed:      noop("done_continuation_noop"),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     to("todo"), // only explicit reopen path
    issue_checked_out:              preserve(),
    issue_tree_restored:            preserve(),
    approval_approved:              preserve(),
    transient_failure_retry:        noop("done_retry_noop"),
    plugin_issue_wakeup_requested:  preserve(),
    manual:                         preserve(),
  },

  cancelled: {
    issue_assigned:                 noop("cancelled_assigned_noop"),
    issue_commented:                preserve(),
    issue_blockers_resolved:        noop("cancelled_blockers_noop"),
    issue_children_completed:       noop("cancelled_children_noop"),
    issue_continuation_needed:      noop("cancelled_continuation_noop"),
    issue_comment_mentioned:        preserve(),
    issue_status_changed:           preserve(),
    issue_reopened_via_comment:     to("todo"),
    issue_checked_out:              noop("cancelled_checkout_noop"),
    issue_tree_restored:            preserve(),
    approval_approved:              noop("cancelled_approval_noop"),
    transient_failure_retry:        noop("cancelled_retry_noop"),
    plugin_issue_wakeup_requested:  noop("cancelled_plugin_noop"),
    manual:                         preserve(),
  },
};

// ---------------------------------------------------------------------------
// One-shot memo for unknown reasons (avoids log spam per wake)
// ---------------------------------------------------------------------------
const unknownReasonMemo = new Set<string>();

// ---------------------------------------------------------------------------
// evaluateWake — main FSM entry point
// ---------------------------------------------------------------------------
export function evaluateWake(input: WakeFsmInput): WakeTransition {
  const { currentStatus, reason, selfWake, throttledContinuation } = input;

  // Override: self-wake suppression takes priority over FSM table
  if (selfWake) {
    return noop("self_wake_guard");
  }

  // Override: continuation throttle
  if (throttledContinuation && reason === "issue_continuation_needed") {
    return noop("continuation_throttle");
  }

  const row = WAKE_TRANSITIONS[currentStatus];
  if (!row) {
    // Unknown status — should never happen with TypeScript enforcement, but guard anyway
    return noop(`unknown_status:${currentStatus}`);
  }

  const knownReason = reason as WakeReason;
  if (Object.prototype.hasOwnProperty.call(row, knownReason)) {
    return row[knownReason];
  }

  // Unknown reason string (e.g., future plugin reason not in the union)
  const memoKey = `${reason}:${currentStatus}`;
  if (!unknownReasonMemo.has(memoKey)) {
    unknownReasonMemo.add(memoKey);
    // Callers can hook into this via a logger if needed — we stay IO-free here
    // and expose the memo for tests.
  }
  return { kind: "preserve" };
}

// Exposed for tests only
export { unknownReasonMemo as _unknownReasonMemo };

// ---------------------------------------------------------------------------
// evaluateCheckout — FSM gate run BEFORE status mutation at checkout
// ---------------------------------------------------------------------------

type CheckoutRow = Record<IssueStatus, WakeTransition>;

const CHECKOUT_TRANSITIONS: CheckoutRow = {
  backlog:     to("in_progress"),
  todo:        to("in_progress"),
  in_progress: preserve(),
  in_review:   preserve(),
  blocked:     preserve(), // do not silently unblock
  done:        preserve(), // do not silently reopen
  cancelled:   preserve(), // caller error — don't mutate
};

export function evaluateCheckout(currentStatus: IssueStatus): WakeTransition {
  return CHECKOUT_TRANSITIONS[currentStatus] ?? preserve();
}
