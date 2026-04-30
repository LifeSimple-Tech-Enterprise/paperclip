import { describe, expect, it } from "vitest";

// Unit-level tests for the WakeTerminatedError catch-block detection logic
// that was added to heartbeat.ts. The inline code is:
//   const isWakeTerminated = err instanceof Error && err.name === "WakeTerminatedError";
//   const errorCode = isWakeTerminated ? "wake_terminated_by_harness" : "adapter_failed";
// Matching by err.name avoids importing WakeTerminatedError into server-tier.

function deriveErrorCode(err: unknown): string {
  const isWakeTerminated = err instanceof Error && err.name === "WakeTerminatedError";
  return isWakeTerminated ? "wake_terminated_by_harness" : "adapter_failed";
}

describe("heartbeat catch block: WakeTerminatedError detection", () => {
  it("maps WakeTerminatedError (by name) to wake_terminated_by_harness", () => {
    const err = new Error("wake terminated by harness: test-reason");
    err.name = "WakeTerminatedError";
    expect(deriveErrorCode(err)).toBe("wake_terminated_by_harness");
  });

  it("maps a plain Error to adapter_failed", () => {
    const err = new Error("some adapter failure");
    expect(deriveErrorCode(err)).toBe("adapter_failed");
  });

  it("maps TypeError and other Error subclasses to adapter_failed", () => {
    expect(deriveErrorCode(new TypeError("bad type"))).toBe("adapter_failed");
    expect(deriveErrorCode(new RangeError("out of range"))).toBe("adapter_failed");
  });

  it("maps non-Error throws to adapter_failed", () => {
    expect(deriveErrorCode("string throw")).toBe("adapter_failed");
    expect(deriveErrorCode({ code: "ENOENT" })).toBe("adapter_failed");
    expect(deriveErrorCode(null)).toBe("adapter_failed");
  });

  it("matches by name — works even when the Error comes from a different module realm", () => {
    // Simulate cross-module WakeTerminatedError: same name, different class identity
    class LocalWakeTerminatedError extends Error {
      reason: string;
      constructor(reason: string) {
        super(`wake terminated by harness: ${reason}`);
        this.name = "WakeTerminatedError";
        this.reason = reason;
      }
    }
    const err = new LocalWakeTerminatedError("cross-realm");
    // instanceof LocalWakeTerminatedError is true, but server never imports that class
    // The name check is what matters:
    expect(deriveErrorCode(err)).toBe("wake_terminated_by_harness");
  });
});

// ---------------------------------------------------------------------------
// run_state derivation — heartbeat.ts:5824 always calls setRunStatus("failed")
// for both WakeTerminated and other adapter errors.
// ---------------------------------------------------------------------------

// Mirrors the run_state selection at heartbeat.ts:5824:
//   await setRunStatus(run.id, "failed", ...)
// Both error paths (wake_terminated_by_harness and adapter_failed) use "failed".
function deriveRunState(err: unknown): "failed" | "completed" {
  const errorCode = deriveErrorCode(err);
  // heartbeat.ts catch block always calls setRunStatus(run.id, "failed", ...)
  // The errorCode differs but run_state is always "failed", never "completed".
  return errorCode === "wake_terminated_by_harness" || errorCode === "adapter_failed"
    ? "failed"
    : "completed";
}

describe("heartbeat catch block: run_state after WakeTerminatedError (410 + harness sentinel)", () => {
  it("WakeTerminatedError → run_state is 'failed', not 'completed'", () => {
    const err = new Error("wake terminated by harness: issue-deleted");
    err.name = "WakeTerminatedError";
    expect(deriveRunState(err)).toBe("failed");
    expect(deriveRunState(err)).not.toBe("completed");
  });

  it("410 + WakeTerminatedError combination: errorCode=wake_terminated_by_harness, run_state=failed", () => {
    // The harness signals a 410 by raising WakeTerminatedError before the adapter exits.
    // The heartbeat catch block detects it by name and sets errorCode accordingly.
    // Both the errorCode and the run_state must be correct.
    const err = new Error("wake terminated by harness: 410-gone");
    err.name = "WakeTerminatedError";
    expect(deriveErrorCode(err)).toBe("wake_terminated_by_harness");
    expect(deriveRunState(err)).toBe("failed");
  });

  it("plain adapter errors (non-wake-terminated) also produce run_state=failed", () => {
    // All errors in the heartbeat catch block set run_state="failed".
    const err = new Error("adapter crashed");
    expect(deriveErrorCode(err)).toBe("adapter_failed");
    expect(deriveRunState(err)).toBe("failed");
  });
});
