/**
 * HermesAgent V1 action registry — Stage C1 (LIF-243).
 *
 * Maps each V1 `action_id` (single source of truth: `V1_ACTION_IDS` exported by
 * `@paperclipai/hermes-agent/intent`) to:
 *
 *   - `argsSchema`  — defense-in-depth zod schema that re-enforces the
 *                     character class / range each shell wrapper enforces.
 *                     Validated BEFORE any spawn. The wrapper is the LAST line
 *                     of defense; this schema is the FIRST. Both must agree on
 *                     character class; if they drift the wrapper will reject
 *                     and the executor surfaces `wrapper_nonzero`.
 *   - `wrapperPath` — absolute path to the LIF-237 sudo wrapper.
 *   - `argv`        — pure function mapping the validated args back to the
 *                     argv array passed to `child_process.spawn`. NEVER
 *                     concatenate into a shell string; argv only.
 *   - `criticality` — `"critical"` actions require Discord approval (Stage D);
 *                     the executor returns `awaiting_approval` and does NOT
 *                     spawn until approval lands. Mirrors
 *                     `V1_CRITICAL_ACTION_IDS` from the intent package — the
 *                     two sources are cross-checked at module load.
 *
 * Closed-enum membership (e.g. allowlist of pm2 process names, ufw presets,
 * journalctl units, disk-check keys, health-probe keys) is enforced by the
 * shell wrappers via `/etc/hermes/*.allowlist` files (see LIF-237). The TS
 * layer enforces only the character class — keeping enum membership in one
 * place (the OS) avoids drift between this file and the operator's allowlist.
 *
 * To add a new action: re-open LIF-232 §0.4 first. The V1 allowlist is FROZEN.
 */

import { z } from "zod";
import {
  V1_ACTION_IDS,
  V1_CRITICAL_ACTION_IDS,
  type V1ActionId,
} from "@paperclipai/hermes-agent/intent";

// ---------------------------------------------------------------------------
// Shared character-class regexes
// ---------------------------------------------------------------------------

/**
 * Conservative identifier class shared by pm2 names, allowlist keys, etc.
 * Matches what the LIF-237 wrappers' `wrapper-common.sh` validates against.
 * No shell metacharacters, no whitespace, no path-traversal sequences.
 */
const SAFE_IDENT_RE = /^[A-Za-z0-9_.-]+$/;

/** systemd unit names — same character class plus must end in a unit suffix. */
const SYSTEMD_UNIT_RE = /^[A-Za-z0-9_.-]+\.(service|socket|timer|target)$/;

/** ufw preset key — closed enum is enforced wrapper-side via /etc/hermes/ufw.presets. */
const UFW_PRESET_RE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Per-action arg schemas
// ---------------------------------------------------------------------------

/** No-args schema: the model may send `{}` or omit args entirely. */
const NoArgsSchema = z.object({}).strict();

const Pm2RestartArgsSchema = z
  .object({
    name: z.string().min(1).max(64).regex(SAFE_IDENT_RE),
  })
  .strict();

const UfwApplyArgsSchema = z
  .object({
    preset: z.string().min(1).max(64).regex(UFW_PRESET_RE),
  })
  .strict();

const JournalTailArgsSchema = z
  .object({
    unit: z.string().min(1).max(128).regex(SYSTEMD_UNIT_RE),
    n: z
      .string()
      .regex(/^[0-9]+$/, "n must be a base-10 integer string")
      .transform((s) => Number.parseInt(s, 10))
      .pipe(z.number().int().min(1).max(1000)),
  })
  .strict();

const DiskUsageArgsSchema = z
  .object({
    key: z.string().min(1).max(64).regex(SAFE_IDENT_RE),
  })
  .strict();

const HealthProbeArgsSchema = z
  .object({
    key: z.string().min(1).max(64).regex(SAFE_IDENT_RE),
  })
  .strict();

// ---------------------------------------------------------------------------
// Action definition shape
// ---------------------------------------------------------------------------

export type Criticality = "routine" | "critical";

/**
 * Generic action definition. The `argv` callback is parameterised over the
 * argsSchema's parsed-output type, so registry entries get full TypeScript
 * inference on `args` without per-action casts.
 */
export interface ActionDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: V1ActionId;
  argsSchema: S;
  wrapperPath: string;
  argv: (args: z.infer<S>) => string[];
  criticality: Criticality;
}

// ---------------------------------------------------------------------------
// Registry — EXACTLY 9 entries, FROZEN per Plan v4 §0.4
// ---------------------------------------------------------------------------

/**
 * Internal helper so callers cannot accidentally widen `S` to `unknown`.
 * Returns the entry typed as `ActionDefinition` (with the per-action schema
 * preserved at the entry-construction site).
 */
function defineAction<S extends z.ZodTypeAny>(
  def: ActionDefinition<S>,
): ActionDefinition {
  return def as unknown as ActionDefinition;
}

export const ACTION_REGISTRY: Readonly<Record<V1ActionId, ActionDefinition>> =
  Object.freeze({
    // -- Routine: service restarts -------------------------------------------
    service_restart_paperclip: defineAction({
      id: "service_restart_paperclip",
      argsSchema: NoArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-restart-paperclip",
      argv: () => [],
      criticality: "routine",
    }),

    service_restart_github_runner: defineAction({
      id: "service_restart_github_runner",
      argsSchema: NoArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-restart-gha-runner",
      argv: () => [],
      criticality: "routine",
    }),

    pm2_restart: defineAction({
      id: "pm2_restart",
      argsSchema: Pm2RestartArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-pm2-restart",
      argv: (args) => [args.name],
      criticality: "routine",
    }),

    // -- Routine: read-only diagnostics --------------------------------------
    ufw_status: defineAction({
      id: "ufw_status",
      argsSchema: NoArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-ufw-status",
      argv: () => [],
      criticality: "routine",
    }),

    diag_journal_tail: defineAction({
      id: "diag_journal_tail",
      argsSchema: JournalTailArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-log-tail",
      argv: (args) => [args.unit, String(args.n)],
      criticality: "routine",
    }),

    diag_disk_usage: defineAction({
      id: "diag_disk_usage",
      argsSchema: DiskUsageArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-disk-check",
      argv: (args) => [args.key],
      criticality: "routine",
    }),

    diag_health_probe: defineAction({
      id: "diag_health_probe",
      argsSchema: HealthProbeArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-health-probe",
      argv: (args) => [args.key],
      criticality: "routine",
    }),

    // -- Critical: ufw mutation (Discord approval gates dispatch) ------------
    ufw_allow: defineAction({
      id: "ufw_allow",
      argsSchema: UfwApplyArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-ufw-apply",
      argv: (args) => ["allow", args.preset],
      criticality: "critical",
    }),

    ufw_deny: defineAction({
      id: "ufw_deny",
      argsSchema: UfwApplyArgsSchema,
      wrapperPath: "/usr/local/sbin/hermes-ufw-apply",
      argv: (args) => ["deny", args.preset],
      criticality: "critical",
    }),
  });

// ---------------------------------------------------------------------------
// Belt-and-suspenders integrity checks (run at module load)
// ---------------------------------------------------------------------------

// 1. Every V1 action_id must have a registry entry — the registry MUST be
//    exhaustive. Using a const object satisfies this at compile time, but a
//    runtime check guards against accidental key-rename divergence.
for (const id of V1_ACTION_IDS) {
  if (!(id in ACTION_REGISTRY)) {
    throw new Error(
      `[hermes-actions] registry missing entry for action_id "${id}"`,
    );
  }
}

// 2. Criticality must agree with V1_CRITICAL_ACTION_IDS. If the intent package
//    classifies an action critical but the registry calls it routine (or
//    vice-versa), executor approval gating would be wrong. Fail loud at load.
for (const id of V1_ACTION_IDS) {
  const expectCritical = V1_CRITICAL_ACTION_IDS.has(id);
  const actualCritical = ACTION_REGISTRY[id].criticality === "critical";
  if (expectCritical !== actualCritical) {
    throw new Error(
      `[hermes-actions] criticality mismatch for "${id}": ` +
        `intent.V1_CRITICAL_ACTION_IDS says ${expectCritical}, ` +
        `registry says ${actualCritical}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public lookup helper
// ---------------------------------------------------------------------------

/**
 * Custom error thrown when an executor receives an action_id that is not in
 * the registry. Should never happen in practice because `parseIntent`
 * (in `@paperclipai/hermes-agent/intent`) already rejects off-list ids, but
 * surfaces a typed error for the executor's belt-and-suspenders branch.
 */
export class UnknownActionError extends Error {
  readonly actionId: string;
  constructor(actionId: string) {
    super(`Unknown V1 action_id: "${actionId}"`);
    this.name = "UnknownActionError";
    this.actionId = actionId;
  }
}

/**
 * Look up an action definition by id. Throws `UnknownActionError` if the id
 * is not in the V1 allowlist. Callers that already know the id is allowlisted
 * (e.g. immediately after `parseIntent` returns `ok: true`) can rely on this
 * never throwing in the happy path.
 */
export function getAction(actionId: string): ActionDefinition {
  if (!(actionId in ACTION_REGISTRY)) {
    throw new UnknownActionError(actionId);
  }
  return ACTION_REGISTRY[actionId as V1ActionId];
}
