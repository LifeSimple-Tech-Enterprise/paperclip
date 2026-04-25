import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyExecuted, _buildNotifyPayload } from "./notify.js";

describe("_buildNotifyPayload", () => {
  it("marks success green and includes actionId", () => {
    const payload = _buildNotifyPayload("systemctl_restart", { service: "paperclip.service" }, 0, "") as {
      embeds: Array<{ color: number; title: string; fields: Array<{ name: string; value: string }> }>;
    };
    expect(payload.embeds[0].color).toBe(3066993);
    expect(payload.embeds[0].title).toContain("systemctl_restart");
    expect(payload.embeds[0].title).toContain("✅");
  });

  it("marks failure red on non-zero exit code", () => {
    const payload = _buildNotifyPayload("pm2_restart", {}, 1, "error") as {
      embeds: Array<{ color: number; title: string }>;
    };
    expect(payload.embeds[0].color).toBe(15158332);
    expect(payload.embeds[0].title).toContain("❌");
  });

  it("truncates log excerpt to 1800 chars", () => {
    const longLog = "x".repeat(2000);
    const payload = _buildNotifyPayload("ufw_status", {}, 0, longLog) as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const logField = payload.embeds[0].fields.find((f) => f.name === "Log excerpt");
    expect(logField?.value.length).toBeLessThanOrEqual(1820); // 1800 + code fence overhead
  });

  it("renders args as key=value pairs", () => {
    const payload = _buildNotifyPayload("ufw_allow", { preset: "web" }, 0, "") as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const argsField = payload.embeds[0].fields.find((f) => f.name === "Args");
    expect(argsField?.value).toContain("`preset`=`web`");
  });

  it("shows _none_ for empty args", () => {
    const payload = _buildNotifyPayload("ufw_status", {}, 0, "") as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const argsField = payload.embeds[0].fields.find((f) => f.name === "Args");
    expect(argsField?.value).toBe("_none_");
  });
});

describe("notifyExecuted", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops when webhookUrl is not set", async () => {
    await notifyExecuted("ufw_status", {}, 0, "", { webhookUrl: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to the webhook with correct Content-Type", async () => {
    await notifyExecuted(
      "systemctl_restart",
      { service: "paperclip.service" },
      0,
      "started",
      { webhookUrl: "https://discord.test/webhook" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.test/webhook");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends embeds with the correct color for success", async () => {
    await notifyExecuted("pm2_restart", { name: "paperclip" }, 0, "", {
      webhookUrl: "https://discord.test/webhook",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      embeds: Array<{ color: number }>;
    };
    expect(body.embeds[0].color).toBe(3066993);
  });

  it("sends embeds with the failure color on non-zero exit", async () => {
    await notifyExecuted("pm2_restart", {}, 2, "crash", {
      webhookUrl: "https://discord.test/webhook",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      embeds: Array<{ color: number }>;
    };
    expect(body.embeds[0].color).toBe(15158332);
  });

  it("throws when webhook returns unexpected non-ok status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(
      notifyExecuted("ufw_status", {}, 0, "", { webhookUrl: "https://discord.test/webhook" }),
    ).rejects.toThrow("400");
  });
});
