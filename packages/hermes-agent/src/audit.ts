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
 * Structural subset of `ExecutionResult` from `@paperclipai/hermes-actions/executor`.
 * Defined inline here to avoid a circular pnpm workspace dependency:
 * `hermes-actions` already depends on `hermes-agent`, so `hermes-agent` must
 * not import from `hermes-actions`. The real `ExecutionResult` is structurally
 * compatible with this type.
 */
interface ExecutionResultLike {
  ok: boolean;
  code: string;
  exitCode: number | null;
  stdoutTruncated: string;
  stderrTruncated: string;
  journalSeq: number | null;
  message?: string;
  zodIssues?: import("zod").ZodIssue[];
}

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
 * Format a structured markdown comment for an executed action (success or
 * any non-skipped failure). Mirrors `formatIntentAcceptedComment` shape so
 * the reader sees a consistent audit thread.
 *
 * Output shape (frozen — QA_Unit tests assert exact bytes):
 *
 *   ### Hermes execution — <ok|failed|awaiting_approval|invalid_args|…>
 *
 *   action_id: `<id>`
 *   exit_code: `<n|null>`
 *   journal_seq: `<n|null>`
 *
 *   ```
 *   <stdout, omitted if empty>
 *   ```
 *
 *   ```
 *   <stderr, omitted if empty>
 *   ```
 *
 *   <for invalid_args: zod issues bullet list>
 */
export function formatExecutionResultComment(args: {
  actionId: string;
  result: ExecutionResultLike;
}): string {
  const { actionId, result } = args;

  const statusLabel = result.ok
    ? "ok"
    : result.code === "wrapper_nonzero"
      ? "failed"
      : result.code;

  const lines: string[] = [
    `### Hermes execution — ${statusLabel}`,
    ``,
    `action_id: \`${actionId}\``,
    `exit_code: \`${result.exitCode ?? "null"}\``,
    `journal_seq: \`${result.journalSeq ?? "null"}\``,
  ];

  if (result.stdoutTruncated) {
    lines.push(``, `\`\`\``, result.stdoutTruncated, `\`\`\``);
  }

  if (result.stderrTruncated) {
    lines.push(``, `\`\`\``, result.stderrTruncated, `\`\`\``);
  }

  if (result.code === "invalid_args" && result.zodIssues?.length) {
    lines.push(``, `**Validation errors:**`);
    for (const issue of result.zodIssues) {
      lines.push(`- \`${issue.path.join(".")}\`: ${issue.message}`);
    }
  }

  return lines.join("\n");
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
