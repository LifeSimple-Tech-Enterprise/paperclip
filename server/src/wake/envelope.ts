// ---------------------------------------------------------------------------
// Canonical ctx.wake envelope builder (LIF-382 / Stage 1)
// Builds a unified wake context from the wakeup-request row and heartbeat run.
// ---------------------------------------------------------------------------

/** Canonical wake envelope passed to adapters via ctx.wake. */
export interface PaperclipWakeEnvelope {
  reason: string | null;
  /** issue id (the Paperclip task being worked on) */
  taskId: string | null;
  /** heartbeat run id for the current execution */
  runId: string | null;
  /** comment id that triggered this wake, if any */
  commentId: string | null;
  /** approval id, if this wake was triggered by an approval decision */
  approvalId: string | null;
  /** linked issue ids (blockers resolved, children completed, etc.) */
  linkedIssueIds: string[];
  /** arbitrary wake payload from the wakeup request */
  payload: Record<string, unknown> | null;
}

// Minimal shape we need from a wakeup request row
interface WakeupRequestLike {
  reason?: string | null;
  payload?: Record<string, unknown> | null;
}

// Minimal shape we need from a heartbeat run row
interface HeartbeatRunLike {
  id: string;
  contextSnapshot?: Record<string, unknown> | null;
}

function readStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

function readStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * Build a canonical wake envelope from the wakeup-request row and heartbeat
 * run that was just claimed. Both are nullable (non-wake heartbeat ticks
 * produce an empty envelope).
 */
export function buildWakeEnvelope(args: {
  wakeRow: WakeupRequestLike | null;
  claimRow: HeartbeatRunLike | null;
  issueId: string | null;
}): PaperclipWakeEnvelope {
  const { wakeRow, claimRow, issueId } = args;
  const ctx: Record<string, unknown> = claimRow?.contextSnapshot ?? {};

  // reason: prefer wakeup request reason, fall back to context snapshot
  const reason =
    readStr(wakeRow?.reason) ??
    readStr(ctx.wakeReason) ??
    readStr(ctx.reason) ??
    null;

  // taskId: prefer context snapshot issueId/taskId, fall back to issueId param
  const taskId =
    readStr(ctx.issueId) ??
    readStr(ctx.taskId) ??
    issueId ??
    null;

  // runId: from the claim row's id
  const runId = claimRow?.id ?? null;

  // commentId: context snapshot fields
  const commentId =
    readStr(ctx.wakeCommentId) ??
    readStr(ctx.commentId) ??
    null;

  // approvalId
  const approvalId =
    readStr(ctx.approvalId) ??
    null;

  // linkedIssueIds (blockedBy, children completed, etc.)
  const linkedIssueIds =
    readStrArray(ctx.issueIds);

  // payload: from the wakeup request
  const payload = wakeRow?.payload ?? null;

  return {
    reason,
    taskId,
    runId,
    commentId,
    approvalId,
    linkedIssueIds,
    payload,
  };
}
