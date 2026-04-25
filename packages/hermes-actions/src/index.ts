/**
 * Public entry point for `@paperclipai/hermes-actions`.
 *
 * Stage C1 (LIF-243) landed the registry; executor / journal / notify / failure-
 * handler are wired here in Stage C4 (LIF-248). Keep this file additive.
 */

export {
  ACTION_REGISTRY,
  UnknownActionError,
  getAction,
  type ActionDefinition,
  type Criticality,
} from "./registry.js";

export {
  executeIntent,
  type ExecutorContext,
  type ExecutionCode,
  type ExecutionResult,
} from "./executor.js";

export {
  openJournal,
  verifyJournal,
  type JournalRecord,
  type JournalAppendInput,
  type JournalHandle,
  type VerifyResult,
  type VerifyResultOk,
  type VerifyResultBad,
} from "./journal.js";

export {
  notifyExecutionFailure,
  type NotifyContext,
} from "./notify.js";

export {
  handleExecutionFailure,
  type FailureSinkContext,
} from "./failure-handler.js";

export {
  checkAndRecord,
  RateLimitError,
  DEFAULT_MAX_PER_HOUR,
  WINDOW_MS,
  DEFAULT_RATE_LIMIT_PATH,
  type RateLimitStore,
  type RateLimitOptions,
} from "./rate-limit.js";
