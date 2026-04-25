import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requestApproval,
  _buildApprovalRequestPayload,
  _createPaperclipApproval,
} from "./approval.js";

// ─── unit tests for payload builder ─────────────────────────────────────────

describe("_buildApprovalRequestPayload", () => {
  it("embeds the approval ID in the footer", () => {
    const payload = _buildApprovalRequestPayload(
      "ufw_allow",
      { preset: "web" },
      "approval-123",
      15,
    ) as { embeds: Array<{ footer: { text: string }; title: string }> };
    expect(payload.embeds[0].footer.text).toContain("approval-123");
    expect(payload.embeds[0].title).toContain("Approval Required");
  });

  it("includes a LINK button when paperclipPublicUrl is provided", () => {
    const payload = _buildApprovalRequestPayload(
      "ufw_allow",
      {},
      "approval-456",
      15,
      "https://paperclip.example.com",
    ) as {
      components?: Array<{ components: Array<{ style: number; url: string }> }>;
    };
    expect(payload.components).toBeDefined();
    const btn = payload.components![0].components[0];
    expect(btn.style).toBe(5);
    expect(btn.url).toContain("approval-456");
  });

  it("omits components when no public URL is set", () => {
    const payload = _buildApprovalRequestPayload(
      "ufw_deny",
      {},
      "approval-789",
      15,
    ) as { components?: unknown };
    expect(payload.components).toBeUndefined();
  });

  it("shows TTL in the embed fields", () => {
    const payload = _buildApprovalRequestPayload("ufw_allow", {}, "id", 15) as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const ttlField = payload.embeds[0].fields.find((f) => f.name === "TTL");
    expect(ttlField?.value).toContain("15 min");
    expect(ttlField?.value).toContain("DENY");
  });
});

// ─── integration-style tests (fetch mocked) ─────────────────────────────────

describe("requestApproval", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const BASE_CFG = {
    webhookUrl: "https://discord.test/webhook",
    paperclipApiUrl: "http://localhost:9999",
    companyId: "company-abc",
    ttlMs: 500,
    pollIntervalMs: 50,
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockCreateApproval(id = "approval-001") {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id }),
    });
  }

  function mockWebhookPost() {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });
  }

  function mockPollResult(status: string, decidedByUserId: string | null = null) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "approval-001", status, decidedByUserId }),
    });
  }

  it("throws when companyId is missing", async () => {
    await expect(
      requestApproval("ufw_allow", {}, "agent-x", {
        ...BASE_CFG,
        companyId: "",
      }),
    ).rejects.toThrow("PAPERCLIP_COMPANY_ID");
  });

  it("creates approval then posts to Discord", async () => {
    mockCreateApproval("approval-001");
    mockWebhookPost();
    mockPollResult("approved", "user-bob");

    const result = await requestApproval("ufw_allow", { preset: "web" }, "agent-x", BASE_CFG);

    // First call: create approval
    const [createUrl, createOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toContain("/api/companies/company-abc/approvals");
    expect(createOpts.method).toBe("POST");
    const createBody = JSON.parse(createOpts.body as string) as {
      type: string;
      payload: { actionId: string };
    };
    expect(createBody.type).toBe("request_board_approval");
    expect(createBody.payload.actionId).toBe("ufw_allow");

    // Second call: Discord webhook
    const [webhookUrl] = fetchMock.mock.calls[1] as [string];
    expect(webhookUrl).toBe("https://discord.test/webhook");

    expect(result).toEqual({ approved: true, approvedBy: "user-bob", tokenId: "approval-001" });
  });

  it("returns approved=true with approvedBy when approval is approved", async () => {
    mockCreateApproval();
    mockWebhookPost();
    mockPollResult("approved", "user-alice");

    const result = await requestApproval("ufw_allow", {}, "agent-x", BASE_CFG);
    expect(result.approved).toBe(true);
    expect(result.approvedBy).toBe("user-alice");
    expect(result.tokenId).toBe("approval-001");
  });

  it("returns approved=false when approval is rejected", async () => {
    mockCreateApproval();
    mockWebhookPost();
    mockPollResult("rejected");

    const result = await requestApproval("ufw_deny", {}, "agent-x", BASE_CFG);
    expect(result.approved).toBe(false);
    expect(result.approvedBy).toBeUndefined();
  });

  it("returns approved=false on timeout (default deny)", async () => {
    mockCreateApproval();
    mockWebhookPost();
    // Poll always returns pending → TTL exhausts
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "approval-001", status: "pending", decidedByUserId: null }),
    });

    const result = await requestApproval("ufw_allow", {}, "agent-x", {
      ...BASE_CFG,
      ttlMs: 120,
      pollIntervalMs: 50,
    });
    expect(result.approved).toBe(false);
    expect(result.tokenId).toBe("approval-001");
  });

  it("still returns a result even when Discord webhook is not set", async () => {
    mockCreateApproval();
    mockPollResult("approved", "user-bob");

    const result = await requestApproval("ufw_allow", {}, "agent-x", {
      ...BASE_CFG,
      webhookUrl: undefined,
    });
    expect(result.approved).toBe(true);
  });

  it("throws when Paperclip approval creation fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "invalid type",
    });

    await expect(
      requestApproval("ufw_allow", {}, "agent-x", BASE_CFG),
    ).rejects.toThrow("422");
  });
});

// ─── _createPaperclipApproval unit test ──────────────────────────────────────

describe("_createPaperclipApproval", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the approval id from the API response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: "the-approval-id" }),
    });
    const id = await _createPaperclipApproval(
      "http://localhost:3100",
      "co-1",
      "ufw_allow",
      { preset: "web" },
      "agent-1",
    );
    expect(id).toBe("the-approval-id");
  });

  it("sends requestedByAgentId in the body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: "x" }),
    });
    await _createPaperclipApproval("http://localhost:3100", "co-1", "act", {}, "agent-7");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      requestedByAgentId: string;
    };
    expect(body.requestedByAgentId).toBe("agent-7");
  });
});
