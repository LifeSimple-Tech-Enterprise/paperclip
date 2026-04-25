/**
 * HermesAgent audit comment formatters — Stage B4 (LIF-240).
 *
 * Exports two pure functions that render structured audit comments.
 * The output shape is FROZEN — tests assert the exact markdown structure.
 *
 * Accepted intent comment shape:
 *
 *   ### Hermes intent — accepted
 *
 *   ```json
 *   { ... }
 *   ```
 *
 *   Classification: routine | critical (per V1_CRITICAL_ACTION_IDS).
 *
 * Rejected intent comment shape:
 *
 *   ### Hermes intent — rejected
 *
 *   Code: `<code>`
 *
 *   ```json
 *   <raw model output or null>
 *   ```
 *
 *   Reason: <one-line message>
 */

import type { IntentSuccess, IntentRejection } from "./intent.js";

/**
 * Extended rejection type that includes the infrastructure-level
 * `ollama_unreachable` code. The three codes in `IntentRejectionCode` are
 * produced by `parseIntent`; `ollama_unreachable` is produced by the
 * entrypoint before `parseIntent` is ever called.
 *
 * `IntentRejection` is intentionally NOT widened so that intent.ts remains
 * frozen per LIF-232 Plan v4 §0.4. The extra code lives here only.
 */
export type AuditRejection =
  | IntentRejection
  | {
      ok: false;
      code: "ollama_unreachable";
      message: string;
      raw?: string;
    };

/**
 * Format a structured markdown comment for a successfully parsed and
 * allowlisted intent. The Classification line reflects V1_CRITICAL_ACTION_IDS
 * via `result.requiresApproval` (computed by `parseIntent`).
 */
export function formatIntentAcceptedComment(result: IntentSuccess): string {
  const { intent, requiresApproval } = result;
  const classification = requiresApproval ? "critical" : "routine";
  const jsonBlock = JSON.stringify(
    {
      action_id: intent.action_id,
      args: intent.args,
      confidence: intent.confidence,
      requires_approval: intent.requires_approval,
      rationale: intent.rationale,
    },
    null,
    2,
  );

  return (
    `### Hermes intent — accepted\n` +
    `\n` +
    `\`\`\`json\n${jsonBlock}\n\`\`\`\n` +
    `\n` +
    `Classification: ${classification} (per V1_CRITICAL_ACTION_IDS).`
  );
}

/**
 * Format a structured markdown comment for a rejected intent. Handles all
 * four rejection codes: invalid_json, schema_violation, action_not_allowed,
 * and ollama_unreachable.
 */
export function formatIntentRejectedComment(result: AuditRejection): string {
  const rawBlock =
    result.raw != null
      ? `\`\`\`json\n${result.raw}\n\`\`\``
      : `\`\`\`json\nnull\n\`\`\``;

  return (
    `### Hermes intent — rejected\n` +
    `\n` +
    `Code: \`${result.code}\`\n` +
    `\n` +
    `${rawBlock}\n` +
    `\n` +
    `Reason: ${result.message}`
  );
}
