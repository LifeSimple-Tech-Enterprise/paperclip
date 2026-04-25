import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyExecuted } from "./notify.js";

const WEBHOOK = "https://discord.example/webhook/abc";

interface MockResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function mockResponse(init: Partial<MockResponse> = {}): MockResponse {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: init.text ?? (() => Promise.resolve("")),
  };
}

describe("notifyExecuted (LIF-238 D1)", () => {
  let originalFetch: typeof globalThis.fetch;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    delete process.env.DISCORD_WEBHOOK_URL;
    vi.useRealTimers();
  });

  it("no-ops (does not call fetch) when DISCORD_WEBHOOK_URL is unset", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await notifyExecuted({
      actionId: "service_restart_paperclip",
      args: { service: "paperclip" },
      exitCode: 0,
      logExcerpt: "ok",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a success embed to Discord when the webhook is set", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchMock = vi.fn().mockResolvedValue(mockResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await notifyExecuted({
      actionId: "service_restart_paperclip",
      args: { service: "paperclip", reason: "deploy" },
      exitCode: 0,
      logExcerpt: "all good",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.username).toBe("HermesAgent");
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toBe("Hermes executed: service_restart_paperclip");
    expect(embed.color).toBe(0x22c55e); // success green
    const statusField = embed.fields.find(
      (f: { name: string }) => f.name === "Status",
    );
    expect(statusField.value).toContain("success");
    const argsField = embed.fields.find(
      (f: { name: string }) => f.name === "Args",
    );
    expect(argsField.value).toContain("**service**: `paperclip`");
    expect(argsField.value).toContain("**reason**: `deploy`");
    const logField = embed.fields.find(
      (f: { name: string }) => f.name === "Log excerpt",
    );
    expect(logField.value).toContain("all good");
    expect(typeof embed.timestamp).toBe("string");
  });

  it("uses failure color and includes exit code on non-zero exit", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchMock = vi.fn().mockResolvedValue(mockResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await notifyExecuted({
      actionId: "ufw_allow",
      args: {},
      exitCode: 2,
      logExcerpt: "",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.embeds[0].color).toBe(0xef4444); // failure red
    const statusField = body.embeds[0].fields.find(
      (f: { name: string }) => f.name === "Status",
    );
    expect(statusField.value).toContain("failure");
    expect(statusField.value).toContain("exit=2");
    const argsField = body.embeds[0].fields.find(
      (f: { name: string }) => f.name === "Args",
    );
    // No args provided → fallback marker.
    expect(argsField.value).toBe("_(no args)_");
  });

  it("logs (does not throw) when the webhook returns a non-2xx response", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 503,
        text: () => Promise.resolve("upstream gone"),
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      notifyExecuted({
        actionId: "x",
        args: {},
        exitCode: 0,
        logExcerpt: "",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("503");
  });

  it("does not throw when fetch rejects (e.g. abort/timeout)", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      notifyExecuted({
        actionId: "x",
        args: {},
        exitCode: 0,
        logExcerpt: "",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("aborted");
  });

  it("truncates log excerpts longer than 1.5 KB", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchMock = vi.fn().mockResolvedValue(mockResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const huge = "a".repeat(2_000);
    await notifyExecuted({
      actionId: "x",
      args: {},
      exitCode: 0,
      logExcerpt: huge,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const logField = body.embeds[0].fields.find(
      (f: { name: string }) => f.name === "Log excerpt",
    );
    expect(logField.value).toContain("…(truncated)");
    // Original excerpt body inside the code-fence should be capped at 1500.
    const fenceMatch = logField.value.match(/^```([\s\S]*?)\n…\(truncated\)```$/);
    expect(fenceMatch).not.toBeNull();
    expect(fenceMatch![1].length).toBe(1_500);
  });
});
