import { describe, expect, it, vi } from "vitest";
import { wrapFetchForWakeTermination, isWakeTerminatedSentinel } from "./wake-terminated-fetch.js";

function makeFetch(status: number, body: unknown): typeof fetch {
  return async () => {
    const bodyText = JSON.stringify(body);
    const response = new Response(bodyText, {
      status,
      headers: { "Content-Type": "application/json" },
    });
    return response;
  };
}

describe("wrapFetchForWakeTermination", () => {
  it("returns sentinel on 410+WAKE_TERMINATED", async () => {
    const fetchFn = makeFetch(410, { code: "WAKE_TERMINATED", error: "reason-x" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("https://example.com");
    expect(isWakeTerminatedSentinel(result)).toBe(true);
    const sentinel = result as unknown as { _terminal: true; reason: string };
    expect(sentinel.reason).toBe("reason-x");
  });

  it("uses default reason when error field is missing", async () => {
    const fetchFn = makeFetch(410, { code: "WAKE_TERMINATED" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("https://example.com");
    expect(isWakeTerminatedSentinel(result)).toBe(true);
    const sentinel = result as unknown as { _terminal: true; reason: string };
    expect(sentinel.reason).toBe("wake_terminated");
  });

  it("passes through 200 unchanged", async () => {
    const fetchFn = makeFetch(200, { ok: true });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("https://example.com");
    expect(isWakeTerminatedSentinel(result)).toBe(false);
    expect(result.status).toBe(200);
  });

  it("passes through other 410s unchanged", async () => {
    const fetchFn = makeFetch(410, { code: "GONE" });
    const wrapped = wrapFetchForWakeTermination(fetchFn);
    const result = await wrapped("https://example.com");
    expect(isWakeTerminatedSentinel(result)).toBe(false);
    expect(result.status).toBe(410);
  });

  it("passes through 410 with non-json body unchanged", async () => {
    const fetchFn = async () =>
      new Response("not json", { status: 410, headers: { "Content-Type": "text/plain" } });
    const wrapped = wrapFetchForWakeTermination(fetchFn as typeof fetch);
    const result = await wrapped("https://example.com");
    expect(isWakeTerminatedSentinel(result)).toBe(false);
    expect(result.status).toBe(410);
  });
});
