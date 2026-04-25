/**
 * Stage D public surface (LIF-238).
 *
 * Per the issue description, exactly two functions are exported from this
 * subpath. Adding more requires re-opening LIF-232 plan v4.
 */

export { notifyExecuted } from "./notify.js";
export type { NotifyExecutedInput } from "./notify.js";

export { requestApproval } from "./approval.js";
export type { RequestApprovalInput, ApprovalResult } from "./approval.js";
