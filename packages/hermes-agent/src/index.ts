/**
 * @paperclipai/hermes-agent — Stage D public API
 *
 * Only two functions are exported:
 *   - notifyExecuted  (D1) routine "did X" Discord ping
 *   - requestApproval (D2/D3) critical-action Discord approval gateway
 */
export { notifyExecuted, requestApproval } from "./discord/index.js";
export type { NotifyConfig, ApprovalResult, ApprovalConfig } from "./discord/index.js";
