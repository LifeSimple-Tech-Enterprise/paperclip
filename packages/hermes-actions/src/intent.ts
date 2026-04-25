/**
 * HermesAgent V1 intent schema (LIF-232 Plan v4, locked 2026-04-25).
 *
 * The local LLM (Ollama gemma4:26b-a4b-it-q4_K_M) is constrained to emit a JSON
 * object that matches `IntentSchema`. Anything that fails to parse OR whose
 * `action_id` is not in the V1 allowlist (`V1_ACTION_IDS`) MUST be rejected at
 * the validator with a structured error comment — no execution.
 *
 * The action allowlist here mirrors the FROZEN list in the locked plan. Do not
 * add an action_id to this list without re-opening LIF-232.
 */

import { z } from "zod";

/**
 * V1 action registry — FROZEN per LIF-232 Plan v4 §0.4.
 *
 * Routine (auto-execute + audit comment):
 *   - service_restart_paperclip
 *   - service_restart_github_runner
 *   - pm2_restart
 *   - ufw_status
 *   - diag_journal_tail
 *   - diag_disk_usage
 *   - diag_health_probe
 *
 * Critical (Discord approval, 15-min TTL, default-deny):
 *   - ufw_allow
 *   - ufw_deny
 *
 * Anything outside this list — secret rotation, config writes, /etc/ writes,
 * source-repo mutations, systemd unit edits, etc. — is OUT of V1 scope and
 * MUST be rejected by the schema validator.
 */
export const V1_ACTION_IDS = [
  "service_restart_paperclip",
  "service_restart_github_runner",
  "pm2_restart",
  "ufw_status",
  "diag_journal_tail",
  "diag_disk_usage",
  "diag_health_probe",
  "ufw_allow",
  "ufw_deny",
] as const;

export type V1ActionId = (typeof V1_ACTION_IDS)[number];

/**
 * V1 critical actions — require Discord approval before dispatch (Stage D).
 * A `requires_approval: true` field on the intent is advisory; the executor
 * derives criticality from this set, not from the model's self-report.
 */
export const V1_CRITICAL_ACTION_IDS: ReadonlySet<V1ActionId> = new Set([
  "ufw_allow",
  "ufw_deny",
]);

/**
 * Hermes intent JSON shape. Matches the `format: "json"` schema fed to Ollama
 * `/api/chat`. Field semantics:
 *
 * - `action_id`: must be a member of the V1 allowlist; off-list ids are
 *   rejected by `parseIntent`.
 * - `args`: stringly-typed bag passed through to the action's per-id zod
 *   schema (defined in `packages/hermes-actions/src/registry.ts` — Stage C1).
 * - `confidence`: model-reported certainty, 0..1 inclusive. Used only for
 *   logging / future thresholding; not gating in V1.
 * - `requires_approval`: model self-report. Cross-checked against
 *   `V1_CRITICAL_ACTION_IDS`; the executor uses the registry, not this flag.
 * - `rationale`: non-empty human-readable justification. Required so the audit
 *   comment carries the model's reasoning even on rejection.
 */
export const IntentSchema = z.object({
  action_id: z.string(),
  args: z.record(z.string()),
  confidence: z.number().min(0).max(1),
  requires_approval: z.boolean(),
  rationale: z.string().min(1),
});

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Structured rejection codes. Surface in the `intent_error` comment so
 * downstream tooling and tests can branch on the failure mode.
 */
export type IntentRejectionCode =
  | "invalid_json"
  | "schema_violation"
  | "action_not_allowed";

export interface IntentRejection {
  ok: false;
  code: IntentRejectionCode;
  message: string;
  /** Raw model output (may be undefined if upstream call failed before parse). */
  raw?: string;
  /** Zod issues when `code === "schema_violation"`. */
  issues?: z.ZodIssue[];
}

export interface IntentSuccess {
  ok: true;
  intent: Intent;
  /** True iff `intent.action_id ∈ V1_CRITICAL_ACTION_IDS`. */
  requiresApproval: boolean;
}

export type IntentParseResult = IntentSuccess | IntentRejection;

/**
 * Parse and validate a raw model response. Three rejection paths:
 *
 *   1. `raw` is not valid JSON                         → `invalid_json`
 *   2. JSON does not match `IntentSchema`              → `schema_violation`
 *   3. `action_id` is not in `V1_ACTION_IDS`           → `action_not_allowed`
 *
 * The executor MUST treat any non-`ok` result as terminal: post the
 * structured error comment and stop. Do NOT fall back to a default action,
 * do NOT retry the model with the rejection in-context.
 */
export function parseIntent(raw: string): IntentParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      code: "invalid_json",
      message: `Model output is not valid JSON: ${(err as Error).message}`,
      raw,
    };
  }

  const parsed = IntentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "schema_violation",
      message: "Model output does not match IntentSchema.",
      raw,
      issues: parsed.error.issues,
    };
  }

  const allowed = (V1_ACTION_IDS as readonly string[]).includes(
    parsed.data.action_id,
  );
  if (!allowed) {
    return {
      ok: false,
      code: "action_not_allowed",
      message: `action_id "${parsed.data.action_id}" is not in the V1 allowlist.`,
      raw,
    };
  }

  return {
    ok: true,
    intent: parsed.data,
    requiresApproval: V1_CRITICAL_ACTION_IDS.has(
      parsed.data.action_id as V1ActionId,
    ),
  };
}
