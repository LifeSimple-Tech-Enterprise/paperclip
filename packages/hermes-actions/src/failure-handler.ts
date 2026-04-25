/**
 * HermesAgent V1 failure sink — Stage C5 (LIF-248).
 *
 * Called by the entrypoint when `executeIntent` returns
 * `code === "wrapper_nonzero"`. Performs four steps in order:
 *
 *   1. Journal entry — already written by the executor before returning.
 *   2. PATCH the issue to `status: "blocked"`.
 *   3. POST a structured audit comment via `formatExecutionResultComment`.
 *   4. `notifyExecutionFailure` (best-effort Discord ping).
 *
 * `awaiting_approval`, `invalid_args`, `unknown_action`, and `spawn_error` do
 * NOT go through this path — they are either upstream-of-spawn or handled by
 * Stage D.
 */

import type { ExecutionResult } from "./executor.js";
import { notifyExecutionFailure } from "./notify.js";
import { formatExecutionResultComment } from "./audit.js";

export interface FailureSinkContext {
  paperclipApiUrl: string;
  paperclipApiKey: string;
  runId: string;
  fetchImpl?: typeof fetch;
}

export async function handleExecutionFailure(
  args: { issueId: string; actionId: string; result: ExecutionResult },
  ctx: FailureSinkContext,
): Promise<void> {
  const { issueId, actionId, result } = args;
  const fetchFn = ctx.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.paperclipApiKey}`,
    "Content-Type": "application/json",
    "X-Paperclip-Run-Id": ctx.runId,
  };

  // Step 2: PATCH issue to blocked.
  await fetchFn(`${ctx.paperclipApiUrl}/api/issues/${issueId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "blocked" }),
  }).catch((err: unknown) => {
    console.error("[hermes] handleExecutionFailure: PATCH blocked failed:", err);
  });

  // Step 3: POST structured audit comment.
  const commentBody = formatExecutionResultComment({ actionId, result });

  await fetchFn(`${ctx.paperclipApiUrl}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body: commentBody }),
  }).catch((err: unknown) => {
    console.error(
      "[hermes] handleExecutionFailure: POST comment failed:",
      err,
    );
  });

  // Step 4: Best-effort Discord notification.
  await notifyExecutionFailure({
    issueId,
    actionId,
    exitCode: result.exitCode ?? -1,
    stderrTruncated: result.stderrTruncated,
  }).catch((err: unknown) => {
    console.error("[hermes] handleExecutionFailure: notify failed:", err);
  });
}
