import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestApproval } from "./approval.js";

const API_URL = "http://api.test";
const PUBLIC_URL = "https://app.test";
const WEBHOOK = "https://discord.example/webhook/abc";
const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const APPROVAL_ID = "approval-xyz";
const REQUIRED_ENV_VARS = [
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_AGENT_ID",
] as const;

interface MockResponseInit {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

function mockResponse(init: MockResponseInit = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(init.json ?? {}),
    text: () => Promise.resolve(init.text ?? ""),
  };
}

function createApprovalResp(status = "pending", decidedByUserId?: string) {
  return mockResponse({
    json: { id: APPROVAL_ID, status, decidedByUserId },
  });
}

function pollResp(status: string, decidedByUserId?: string) {
  return mockResponse({
    json: { id: APPROVAL_ID, status, decidedByUserId },
  });
}

function isApprovalCreate(url: string, init: { method?: string }) {
  return (
    url.includes(`/api/companies/${COMPANY_ID}/approvals`) &&
    init.method === "POST"
  );
}
function isApprovalPoll(url: string, init: { method?: string }) {
  return (
    url.endsWith(`/api/approvals/${APPROVAL_ID}`) &&
    (!init.method || init.method === "GET")
  );
}
function isWebhook(url: string) {
  return url.startsWith(WEBHOOK);
}

describe("requestApproval (LIF-238 D2/D3)", () => {
  let originalFetch: typeof globalThis.fetch;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedEnv = {
      PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL,
      PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
      PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
      PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
      PAPERCLIP_PUBLIC_URL: process.env.PAPERCLIP_PUBLIC_URL,
      PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID,
      DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
      HERMES_APPROVAL_TTL_MS: process.env.HERMES_APPROVAL_TTL_MS,
      HERMES_APPROVAL_POLL_MS: process.env.HERMES_APPROVAL_POLL_MS,
    };
    process.env.PAPERCLIP_API_URL = API_URL;
    process.env.PAPERCLIP_API_KEY = "test-key";
    process.env.PAPERCLIP_COMPANY_ID = COMPANY_ID;
    process.env.PAPERCLIP_AGENT_ID = AGENT_ID;
    process.env.PAPERCLIP_PUBLIC_URL = PUBLIC_URL;
    process.env.PAPERCLIP_TASK_ID = "issue-123";
    delete process.env.DISCORD_WEBHOOK_URL;
    // Tight test hooks so the polling loop completes in milliseconds.
    process.env.HERMES_APPROVAL_TTL_MS = "200";
    process.env.HERMES_APPROVAL_POLL_MS = "5";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("creates approval, posts Discord notify, polls until approved (happy path)", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string, init: { method?: string }) => {
      if (isApprovalCreate(url, init)) {
        return createApprovalResp("pending");
      }
      if (isWebhook(url)) {
        return mockResponse();
      }
      if (isApprovalPoll(url, init)) {
        pollCount += 1;
        // Stay pending for the first poll, then approve.
        if (pollCount < 2) return pollResp("pending");
        return pollResp("approved", "user-9");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await requestApproval({
      actionId: "ufw_allow",
      args: { port: "443" },
      requestedBy: "actor-1",
    });

    expect(result).toEqual({
      approved: true,
      approvedBy: "user-9",
      tokenId: APPROVAL_ID,
    });

    // Approval create body shape.
    const createCall = fetchMock.mock.calls.find((c) =>
      isApprovalCreate(c[0] as string, c[1] as { method?: string }),
    )!;
    const createInit = createCall[1] as {
      headers: Record<string, string>;
      body: string;
    };
    expect(createInit.headers.Authorization).toBe("Bearer test-key");
    const createBody = JSON.parse(createInit.body);
    expect(createBody.type).toBe("request_board_approval");
    expect(createBody.requestedByAgentId).toBe(AGENT_ID);
    expect(createBody.issueIds).toEqual(["issue-123"]);
    expect(createBody.payload.hermes.actionId).toBe("ufw_allow");
    expect(createBody.payload.hermes.args).toEqual({ port: "443" });
    expect(createBody.payload.hermes.requestedBy).toBe("actor-1");

    // Discord embed deep-link uses PAPERCLIP_PUBLIC_URL.
    const webhookCall = fetchMock.mock.calls.find((c) =>
      isWebhook(c[0] as string),
    )!;
    const webhookBody = JSON.parse(
      (webhookCall[1] as { body: string }).body,
    );
    expect(webhookBody.embeds[0].description).toContain(
      `${PUBLIC_URL}/approvals/${APPROVAL_ID}`,
    );
    expect(webhookBody.embeds[0].title).toBe("Approval needed: ufw_allow");

    // At least one poll occurred.
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("returns approved=false when the approval is rejected", async () => {
    const fetchMock = vi.fn(async (url: string, init: { method?: string }) => {
      if (isApprovalCreate(url, init)) return createApprovalResp("pending");
      if (isApprovalPoll(url, init)) return pollResp("rejected", "user-7");
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await requestApproval({
      actionId: "ufw_allow",
      args: { port: "443" },
      requestedBy: "actor-1",
    });

    expect(result.approved).toBe(false);
    expect(result.approvedBy).toBe("user-7");
    expect(result.tokenId).toBe(APPROVAL_ID);
  });

  it("default-denies on TTL timeout (status stays pending)", async () => {
    process.env.HERMES_APPROVAL_TTL_MS = "100";
    process.env.HERMES_APPROVAL_POLL_MS = "20";

    const fetchMock = vi.fn(async (url: string, init: { method?: string }) => {
      if (isApprovalCreate(url, init)) return createApprovalResp("pending");
      if (isApprovalPoll(url, init)) return pollResp("pending");
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const start = Date.now();
    const result = await requestApproval({
      actionId: "ufw_allow",
      args: { port: "443" },
      requestedBy: "actor-1",
    });
    const elapsed = Date.now() - start;

    expect(result).toEqual({ approved: false, tokenId: APPROVAL_ID });
    // Should have waited at least ~TTL but not forever.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
    // Polled at least once.
    const polls = fetchMock.mock.calls.filter((c) =>
      isApprovalPoll(c[0] as string, c[1] as { method?: string }),
    );
    expect(polls.length).toBeGreaterThanOrEqual(1);
  });

  it.each(REQUIRED_ENV_VARS)(
    "throws when required env %s is missing",
    async (missing) => {
      delete process.env[missing];
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(
        requestApproval({
          actionId: "ufw_allow",
          args: {},
          requestedBy: "actor-1",
        }),
      ).rejects.toThrow(missing);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("still creates+polls the approval when DISCORD_WEBHOOK_URL is unset", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;

    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: { method?: string }) => {
      calls.push(url);
      if (isApprovalCreate(url, init)) return createApprovalResp("pending");
      if (isApprovalPoll(url, init)) return pollResp("approved", "user-1");
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await requestApproval({
      actionId: "ufw_allow",
      args: {},
      requestedBy: "actor-1",
    });

    expect(result.approved).toBe(true);
    // No webhook call should ever happen.
    expect(calls.some((u) => isWebhook(u))).toBe(false);
    // Both API calls (create + poll) happened.
    expect(calls.some((u) => u.includes("/api/companies/"))).toBe(true);
    expect(calls.some((u) => u.endsWith(`/api/approvals/${APPROVAL_ID}`))).toBe(
      true,
    );
  });

  it("throws when the approval-create endpoint returns non-2xx", async () => {
    const fetchMock = vi.fn(async (url: string, init: { method?: string }) => {
      if (isApprovalCreate(url, init)) {
        return mockResponse({ ok: false, status: 500, text: "boom" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      requestApproval({
        actionId: "ufw_allow",
        args: {},
        requestedBy: "actor-1",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
