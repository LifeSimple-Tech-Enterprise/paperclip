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
