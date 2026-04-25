/**
 * Failing tests for the Discord notify stub (LIF-243 §1.3 / Stage D handoff,
 * LIF-247 TDD). The stub is "best-effort": never throws, console.error every
 * call, fetch only when DISCORD_WEBHOOK_URL is set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error -- module not yet implemented
import { notifyExecutionFailure } from "./notify.js";

const baseArgs = {
  issueId: "issue-1",
  actionId: "pm2_restart",
  exitCode: 7,
  stderrTruncated: "boom\n",
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.DISCORD_WEBHOOK_URL;
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("notifyExecutionFailure — no webhook configured", () => {
  it("does NOT call fetch and logs to console.error exactly once", async () => {
    const fetchImpl = vi.fn();
    await notifyExecutionFailure(baseArgs, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("notifyExecutionFailure — webhook configured", () => {
  it("POSTs once to the webhook with actionId/issueId/exitCode in the body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as any;
    await notifyExecutionFailure(baseArgs, {
      webhookUrl: "https://discord.example/webhook/abc",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://discord.example/webhook/abc");
    expect(init.method).toBe("POST");
    const body =
      typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    expect(body).toContain("pm2_restart");
    expect(body).toContain("issue-1");
    expect(body).toContain("7");
  });
});

describe("notifyExecutionFailure — non-2xx is swallowed", () => {
  it("does not throw on a 500 response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("nope", { status: 500 }),
    ) as any;
    await expect(
      notifyExecutionFailure(baseArgs, {
        webhookUrl: "https://discord.example/webhook/abc",
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });
});
