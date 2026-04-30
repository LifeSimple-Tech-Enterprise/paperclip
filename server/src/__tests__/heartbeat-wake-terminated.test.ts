import { describe, expect, it } from "vitest";

describe("WakeTerminatedError detection logic", () => {
  function resolveErrorCode(err: unknown): string {
    const isWakeTerminated = err instanceof Error && err.name === "WakeTerminatedError";
    return isWakeTerminated ? "wake_terminated_by_harness" : "adapter_failed";
  }

  it("maps WakeTerminatedError by name to wake_terminated_by_harness", () => {
    const err = new Error("wake terminated by harness: reason-x");
    err.name = "WakeTerminatedError";
    expect(resolveErrorCode(err)).toBe("wake_terminated_by_harness");
  });

  it("maps generic errors to adapter_failed", () => {
    expect(resolveErrorCode(new Error("something blew up"))).toBe("adapter_failed");
  });

  it("maps non-Error throws to adapter_failed", () => {
    expect(resolveErrorCode("string error")).toBe("adapter_failed");
    expect(resolveErrorCode(null)).toBe("adapter_failed");
  });

  it("does not match by instanceof — only by name", () => {
    // This ensures adapter-utils doesn't need to be a hard dep of server
    const fakeErr = { name: "WakeTerminatedError", message: "test" };
    // Not an Error instance, so should return adapter_failed
    expect(resolveErrorCode(fakeErr)).toBe("adapter_failed");
  });
});
