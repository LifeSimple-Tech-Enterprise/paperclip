// REFACTOR-LIF-371: continuation_hot_loop — ACTIONABLE_LIVENESS_STATES gates re-enqueue; if a run returns plan_only/empty_response the harness re-wakes the agent
export {
  DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
  RUN_LIVENESS_CONTINUATION_REASON,
  buildRunLivenessContinuationIdempotencyKey,
  decideRunLivenessContinuation,
  findExistingRunLivenessContinuationWake,
  readContinuationAttempt,
} from "./recovery/run-liveness-continuations.js";
export type {
  RunContinuationDecision,
} from "./recovery/run-liveness-continuations.js";
