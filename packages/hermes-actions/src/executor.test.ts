/**
 * Failing tests for the executor (LIF-243 §C executor, LIF-247 TDD).
 *
 * Mocks `child_process.spawn` via `ctx.spawn`. Covers the full state table
 * from PLAN §1.1: ok | invalid_args | awaiting_approval | unknown_action |
 * wrapper_nonzero | spawn_error, plus 4 KiB byte truncation and the argv
 * (NOT shell string) contract.
 *
 * These tests fail with "module not found" until Drafter implements
 * executor.ts. The argv contract is enforced via the spawn-mock signature.
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntentSuccess } from "@paperclipai/hermes-agent/intent";
// @ts-expect-error -- module not yet implemented
import { executeIntent } from "./executor.js";
// @ts-expect-error -- module not yet implemented
import { verifyJournal } from "./journal.js";

/** Build a fake spawned child that emits stdout/stderr buffers and exits. */
function makeFakeChild(opts: {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  exitCode?: number | null;
  emitError?: Error;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  child.stdout = Readable.from(
    opts.stdout != null
      ? [Buffer.isBuffer(opts.stdout) ? opts.stdout : Buffer.from(opts.stdout)]
      : [],
  );
  child.stderr = Readable.from(
    opts.stderr != null
      ? [Buffer.isBuffer(opts.stderr) ? opts.stderr : Buffer.from(opts.stderr)]
      : [],
  );

  // Defer events to next tick so the executor wires listeners first.
  setImmediate(() => {
    if (opts.emitError) {
      child.emit("error", opts.emitError);
      return;
    }
    child.emit("close", opts.exitCode ?? 0);
  });
  return child;
}

function intent(
  actionId: string,
  args: Record<string, string>,
): IntentSuccess {
  // Hand-rolled — bypasses parseIntent so we can test off-list ids.
  return {
    ok: true,
    intent: {
      action_id: actionId,
      args,
      confidence: 1,
      requires_approval: false,
      rationale: "test",
    },
    requiresApproval: false,
  } as IntentSuccess;
}

let tmp: string;
let journalPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hermes-actions-exec-"));
  journalPath = join(tmp, "journal.log");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("executor — happy path", () => {
  it("pm2_restart with allowlisted name spawns sudo and writes journal", async () => {
    const spawn = vi.fn(() =>
      makeFakeChild({ stdout: "OK\n", exitCode: 0 }),
    ) as any;
    const result = await executeIntent(intent("pm2_restart", { name: "paperclip" }), {
      issueId: "issue-1",
      isApproved: () => false,
      journalPath,
      spawn,
      sudoPath: "/usr/bin/sudo",
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, argv] = spawn.mock.calls[0];
    expect(cmd).toBe("/usr/bin/sudo");
    // CRITICAL: argv must be an array, not a shell string.
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[0]).toBe("/usr/local/sbin/hermes-pm2-restart");
    expect(argv).toContain("paperclip");

    expect(result.ok).toBe(true);
    expect(result.code).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.journalSeq).toBe(1);

    const v = await verifyJournal(journalPath);
    expect(v.ok).toBe(true);
  });
});

describe("executor — awaiting_approval (critical action, not approved)", () => {
  it("ufw_allow without approval does NOT spawn and writes no journal", async () => {
    const spawn = vi.fn();
    const result = await executeIntent(
      intent("ufw_allow", { preset: "https-public" }),
      {
        issueId: "issue-1",
        isApproved: () => false,
        journalPath,
        spawn: spawn as any,
      },
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("awaiting_approval");
    expect(result.journalSeq).toBeNull();
  });

  it("ufw_allow WITH approval does spawn", async () => {
    const spawn = vi.fn(() =>
      makeFakeChild({ stdout: "ok", exitCode: 0 }),
    ) as any;
    const result = await executeIntent(
      intent("ufw_allow", { preset: "https-public" }),
      {
        issueId: "issue-1",
        isApproved: () => true,
        journalPath,
        spawn,
      },
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("executor — invalid_args", () => {
  it("pm2_restart with shell-metachar name short-circuits with no spawn, no journal", async () => {
    const spawn = vi.fn();
    const result = await executeIntent(
      intent("pm2_restart", { name: "evil; rm -rf /" }),
      {
        issueId: "issue-1",
        isApproved: () => false,
        journalPath,
        spawn: spawn as any,
      },
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_args");
    expect(result.journalSeq).toBeNull();
    expect(result.zodIssues).toBeDefined();
  });
});

describe("executor — unknown_action", () => {
  it("hand-rolled IntentSuccess with off-list id returns unknown_action", async () => {
    const spawn = vi.fn();
    const result = await executeIntent(intent("nope", {}), {
      issueId: "issue-1",
      isApproved: () => false,
      journalPath,
      spawn: spawn as any,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unknown_action");
    expect(result.journalSeq).toBeNull();
  });
});

describe("executor — wrapper_nonzero", () => {
  it("exit 7 is journalled and returns wrapper_nonzero", async () => {
    const spawn = vi.fn(() =>
      makeFakeChild({ stderr: "boom\n", exitCode: 7 }),
    ) as any;
    const result = await executeIntent(
      intent("pm2_restart", { name: "paperclip" }),
      {
        issueId: "issue-1",
        isApproved: () => false,
        journalPath,
        spawn,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("wrapper_nonzero");
    expect(result.exitCode).toBe(7);
    expect(typeof result.journalSeq).toBe("number");

    const v = await verifyJournal(journalPath);
    expect(v.ok).toBe(true);
  });
});

describe("executor — 4 KiB BYTE truncation on stdout AND stderr", () => {
  it("5 KiB UTF-8 stdout is truncated to ≤4096 captured bytes", async () => {
    const big = Buffer.alloc(5 * 1024, 0x61); // 5 KiB of 'a'
    const spawn = vi.fn(() =>
      makeFakeChild({ stdout: big, exitCode: 0 }),
    ) as any;
    const result = await executeIntent(
      intent("pm2_restart", { name: "paperclip" }),
      { issueId: "issue-1", isApproved: () => false, journalPath, spawn },
    );
    // Strip optional truncation sentinel before measuring the captured bytes.
    const captured = result.stdoutTruncated.replace(/\n…\(truncated[^)]*\)$/u, "");
    // CRITICAL: byte-count, NOT string.length, per PLAN §1.1.
    expect(Buffer.byteLength(captured, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("5 KiB stderr is truncated to ≤4096 captured bytes", async () => {
    const big = Buffer.alloc(5 * 1024, 0x62);
    const spawn = vi.fn(() =>
      makeFakeChild({ stderr: big, exitCode: 0 }),
    ) as any;
    const result = await executeIntent(
      intent("pm2_restart", { name: "paperclip" }),
      { issueId: "issue-1", isApproved: () => false, journalPath, spawn },
    );
    const captured = result.stderrTruncated.replace(/\n…\(truncated[^)]*\)$/u, "");
    expect(Buffer.byteLength(captured, "utf8")).toBeLessThanOrEqual(4096);
  });
});
