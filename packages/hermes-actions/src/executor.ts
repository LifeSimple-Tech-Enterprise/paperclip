/**
 * HermesAgent V1 executor — Stage C4 (LIF-248).
 *
 * Translates a validated `IntentSuccess` into a privileged shell-wrapper
 * invocation via `sudo`, appends a hash-chained journal entry, and surfaces a
 * typed `ExecutionResult`. Failure handling (PATCH issue + notify) is
 * delegated to `handleExecutionFailure` in `failure-handler.ts` and called
 * by the entrypoint when `result.code === "wrapper_nonzero"`.
 *
 * Security: argv is ALWAYS passed as an array to `child_process.spawn`.
 * No shell interpolation, no exec, no `shell: true`. The wrapper binary is the
 * operator's last line of defense; this executor is the TS layer's first.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { IntentSuccess } from "@paperclipai/hermes-agent/intent";
import { getAction, UnknownActionError } from "./registry.js";
import { openJournal } from "./journal.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutorContext {
  /** Issue id the intent originated from — written into the journal record. */
  issueId: string;
  /** Discord-approval probe. Stage D wires this; for V1 pass `() => false`. */
  isApproved?: (intent: IntentSuccess) => boolean | Promise<boolean>;
  /** Override journal file path for tests. */
  journalPath?: string;
  /** Override spawner for tests. */
  spawn?: typeof nodeSpawn;
  /** Override sudo binary; default `/usr/bin/sudo`. */
  sudoPath?: string;
  /** Wall-clock provider for journal `ts` (default `() => new Date()`). */
  now?: () => Date;
}

export type ExecutionCode =
  | "ok"
  | "invalid_args"
  | "awaiting_approval"
  | "unknown_action"
  | "wrapper_nonzero"
  | "spawn_error";

export interface ExecutionResult {
  ok: boolean;
  code: ExecutionCode;
  exitCode: number | null;
  /** UTF-8 string, capped at 4 KiB of bytes. */
  stdoutTruncated: string;
  stderrTruncated: string;
  /**
   * null only when no journal entry was written:
   * invalid_args, awaiting_approval, unknown_action, spawn_error.
   */
  journalSeq: number | null;
  /** Human-readable detail for invalid_args / spawn_error. */
  message?: string;
  /** Populated only when code === "invalid_args". */
  zodIssues?: import("zod").ZodIssue[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 4096;

/** Truncate a UTF-8 string to at most MAX_OUTPUT_BYTES bytes. */
function capBytes(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return buf.toString("utf8");
  const total = buf.byteLength;
  // Slice to the cap — this may cut a multi-byte char; toString handles that.
  const sliced = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return sliced + `\n…(truncated, ${total} bytes total)`;
}

// ---------------------------------------------------------------------------
// Spawn wrapper that returns a discriminated union
// ---------------------------------------------------------------------------

interface SpawnOk {
  kind: "ok";
  exitCode: number;
  stdoutRaw: string;
  stderrRaw: string;
  durationMs: number;
}

interface SpawnErr {
  kind: "spawn_error";
  message: string;
}

function runChild(
  spawnFn: typeof nodeSpawn,
  sudoPath: string,
  wrapperPath: string,
  argv: string[],
  startedAt: Date,
  nowFn: () => Date,
): Promise<SpawnOk | SpawnErr> {
  return new Promise((resolve) => {
    const child = spawnFn(sudoPath, [wrapperPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    child.on("error", (err) => {
      resolve({ kind: "spawn_error", message: err.message });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const take = Math.max(0, MAX_OUTPUT_BYTES - stdoutBytes);
      if (take > 0) {
        const slice = chunk.subarray(0, take);
        stdoutChunks.push(slice);
        stdoutBytes += slice.byteLength;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const take = Math.max(0, MAX_OUTPUT_BYTES - stderrBytes);
      if (take > 0) {
        const slice = chunk.subarray(0, take);
        stderrChunks.push(slice);
        stderrBytes += slice.byteLength;
      }
    });

    child.on("close", (code) => {
      const durationMs = nowFn().getTime() - startedAt.getTime();
      resolve({
        kind: "ok",
        exitCode: code ?? -1,
        stdoutRaw: Buffer.concat(stdoutChunks).toString("utf8"),
        stderrRaw: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function executeIntent(
  intent: IntentSuccess,
  ctx: ExecutorContext,
): Promise<ExecutionResult> {
  const nowFn = ctx.now ?? (() => new Date());

  // Step 1: Registry lookup (defense-in-depth; parseIntent already validated).
  let def: ReturnType<typeof getAction>;
  try {
    def = getAction(intent.intent.action_id);
  } catch (err) {
    if (err instanceof UnknownActionError) {
      return {
        ok: false,
        code: "unknown_action",
        exitCode: null,
        stdoutTruncated: "",
        stderrTruncated: "",
        journalSeq: null,
      };
    }
    throw err;
  }

  // Step 2: Re-validate args through the per-action zod schema.
  const parsed = def.argsSchema.safeParse(intent.intent.args);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_args",
      exitCode: null,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: null,
      message: "Args failed per-action schema validation.",
      zodIssues: parsed.error.issues,
    };
  }

  // Step 3: Approval gate for critical actions.
  if (def.criticality === "critical") {
    const approved = await ctx.isApproved?.(intent);
    if (approved !== true) {
      return {
        ok: false,
        code: "awaiting_approval",
        exitCode: null,
        stdoutTruncated: "",
        stderrTruncated: "",
        journalSeq: null,
      };
    }
  }

  // Step 4–6: Build argv and spawn.
  const argv = def.argv(parsed.data);
  const sudoPath = ctx.sudoPath ?? "/usr/bin/sudo";
  const spawnFn = ctx.spawn ?? nodeSpawn;
  const startedAt = nowFn();

  const run = await runChild(
    spawnFn,
    sudoPath,
    def.wrapperPath,
    argv,
    startedAt,
    nowFn,
  );

  // Step 6: spawn error — nothing ran, no journal entry.
  if (run.kind === "spawn_error") {
    return {
      ok: false,
      code: "spawn_error",
      exitCode: null,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: null,
      message: run.message,
    };
  }

  // Step 7: Append journal BEFORE returning (run succeeded or wrapper_nonzero).
  const journal = await openJournal(ctx.journalPath);
  const journalSeq = await journal.append({
    ts: startedAt,
    issueId: ctx.issueId,
    actionId: intent.intent.action_id,
    args: intent.intent.args as Record<string, unknown>,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
  });

  return {
    ok: run.exitCode === 0,
    code: run.exitCode === 0 ? "ok" : "wrapper_nonzero",
    exitCode: run.exitCode,
    stdoutTruncated: capBytes(run.stdoutRaw),
    stderrTruncated: capBytes(run.stderrRaw),
    journalSeq,
  };
}
