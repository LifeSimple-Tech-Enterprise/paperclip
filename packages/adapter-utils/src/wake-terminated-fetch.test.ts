import { describe, expect, it } from "vitest";
import { wrapFetchForWakeTermination, isWakeTerminatedSentinel } from "./wake-terminated-fetch.js";

function makeFetchReturning(status: number, body: unknown): typeof fetch {
  return async () => {
    const json = JSON.stringify(body);
    return new Response(json, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("wrapFetchForWakeTermination", () => {
  it("returns sentinel on 410+WAKE_TERMINATED", async () => {
    const fetchFn = makeFetchReturning(410, { code: "WAKE_TERMINATED", error: "reason-x" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("http://example.com/api");
    expect(isWakeTerminatedSentinel(result)).toBe(true);
    expect((result as { _terminal: true; reason: string }).reason).toBe("reason-x");
  });

  it("falls back to 'wake_terminated' reason when error field is absent", async () => {
    const fetchFn = makeFetchReturning(410, { code: "WAKE_TERMINATED" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("http://example.com/api");
    expect(isWakeTerminatedSentinel(result)).toBe(true);
    expect((result as { _terminal: true; reason: string }).reason).toBe("wake_terminated");
  });

  it("passes through 200 unchanged", async () => {
    const fetchFn = makeFetchReturning(200, { result: "ok" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("http://example.com/api");
    expect(result instanceof Response).toBe(true);
    expect((result as Response).status).toBe(200);
  });

  it("passes through other 410s unchanged (different code)", async () => {
    const fetchFn = makeFetchReturning(410, { code: "GONE" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("http://example.com/api");
    expect(result instanceof Response).toBe(true);
    expect((result as Response).status).toBe(410);
    expect(isWakeTerminatedSentinel(result)).toBe(false);
  });

  it("passes through 410 with non-JSON body unchanged", async () => {
    const fetchFn: typeof fetch = async () => new Response("not json", { status: 410 });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("http://example.com/api");
    expect(result instanceof Response).toBe(true);
  });
});

describe("isWakeTerminatedSentinel", () => {
  it("returns true for a sentinel object", () => {
    expect(isWakeTerminatedSentinel({ _terminal: true, reason: "x" })).toBe(true);
  });

  it("returns false for a Response", () => {
    expect(isWakeTerminatedSentinel(new Response("ok", { status: 200 }))).toBe(false);
  });

  it("returns false for null and primitives", () => {
    expect(isWakeTerminatedSentinel(null)).toBe(false);
    expect(isWakeTerminatedSentinel("string")).toBe(false);
    expect(isWakeTerminatedSentinel(42)).toBe(false);
  });
});
