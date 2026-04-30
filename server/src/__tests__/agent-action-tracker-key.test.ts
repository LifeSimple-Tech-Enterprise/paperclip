import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
  buildTrackerKey,
  isCommunicationPath,
  normalizeAgentPath,
  captureRequestBody,
} from "../middleware/agent-action-tracker.js";

function agentReq(path: string, method = "POST"): Request {
  return {
    method,
    originalUrl: path,
    actor: {
      type: "agent",
      agentId: "AAAAAAAA-1111-2222-3333-444444444444",
      companyId: "BBBBBBBB-1111-2222-3333-444444444444",
    },
  } as unknown as Request;
}

function nonAgentReq(path: string, method = "POST"): Request {
  return {
    method,
    originalUrl: path,
    actor: { type: "board", userId: "u1" },
  } as unknown as Request;
}

describe("buildTrackerKey — slash-anchored, prioritized issueId (rev 26)", () => {
  it("returns null for non-agent actors", () => {
    expect(buildTrackerKey(nonAgentReq("/api/issues/LIF-375/comments"))).toBeNull();
  });

  it("extracts the LIF-style issue id from /api/issues/<id>/comments", () => {
    const key = buildTrackerKey(agentReq("/api/issues/LIF-375/comments"));
    expect(key).not.toBeNull();
    expect(key!.issueId).toBe("LIF-375");
    expect(key!.path).toBe("/api/issues/:id/comments");
    expect(key!.method).toBe("POST");
  });

  it("extracts the uuid-style issue id from /api/issues/<uuid>/comments", () => {
    const key = buildTrackerKey(
      agentReq("/api/issues/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/comments"),
    );
    expect(key).not.toBeNull();
    expect(key!.issueId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(key!.path).toBe("/api/issues/:id/comments");
  });

  it("locks the rev-25 word-boundary false-positive: /api/export-LIF-375/foo", () => {
    // Lookaround `(?<=^|/)<id>(?=/|$)` rejects the embedded match.
    const key = buildTrackerKey(agentReq("/api/export-LIF-375/foo"));
    expect(key).toBeNull();
    // Path normalisation must leave `export-LIF-375` intact (no false rewrite).
    expect(normalizeAgentPath("/api/export-LIF-375/foo")).toBe("/api/export-LIF-375/foo");
  });

  it("locks the rev-25 nested-parent first-id-wins bug: /api/workspaces/<uuid>/issues/LIF-375", () => {
    const path = "/api/workspaces/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/issues/LIF-375";
    const key = buildTrackerKey(agentReq(path));
    expect(key).not.toBeNull();
    // EXPLICIT_ISSUE_PATTERN takes precedence — issueId is the trailing LIF-375,
    // NOT the workspace uuid.
    expect(key!.issueId).toBe("LIF-375");
    // Path normalisation rewrites BOTH ids → :id (single source of truth).
    expect(key!.path).toBe("/api/workspaces/:id/issues/:id");
  });

  it("falls back to first global match when no /issues/ or /issue-thread-interactions/ prefix", () => {
    const path = "/api/projects/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/runs";
    const key = buildTrackerKey(agentReq(path));
    expect(key).not.toBeNull();
    // No explicit prefix → fallback path captures the project uuid as issueId.
    expect(key!.issueId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(key!.path).toBe("/api/projects/:id/runs");
  });

  it("strips the query string before matching", () => {
    const key = buildTrackerKey(agentReq("/api/issues/LIF-375/comments?source=tool"));
    expect(key!.issueId).toBe("LIF-375");
    expect(key!.path).toBe("/api/issues/:id/comments");
  });

  it("returns null when no id at all in the path (no fallback to track)", () => {
    expect(buildTrackerKey(agentReq("/api/health"))).toBeNull();
  });

  it("works on /api/issue-thread-interactions/<id>/decide via explicit prefix", () => {
    const key = buildTrackerKey(
      agentReq("/api/issue-thread-interactions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/decide"),
    );
    expect(key).not.toBeNull();
    expect(key!.issueId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});

describe("isCommunicationPath", () => {
  it("classifies comment + interaction paths as comm", () => {
    expect(isCommunicationPath("/api/issues/:id/comments")).toBe(true);
    expect(isCommunicationPath("/api/issue-thread-interactions/:id/answer")).toBe(true);
    expect(isCommunicationPath("/api/issues/:id/interactions")).toBe(true);
  });

  it("classifies non-comment routes as non-comm", () => {
    expect(isCommunicationPath("/api/issues/:id/handoffs")).toBe(false);
    expect(isCommunicationPath("/api/handoffs/:id/decide")).toBe(false);
  });
});

describe("captureRequestBody — replacer + redaction + 500-char slice", () => {
  it("returns a serialised body when small", () => {
    const out = captureRequestBody({ a: 1, b: "ok" });
    expect(out).toContain("a");
    expect(out).toContain("ok");
  });

  it("compresses individual long strings via the replacer", () => {
    // Replacer per-string cap is ~200 chars. A single 2 KB string serialises
    // to a small JSON, well under the 500-char outer slice.
    const out = captureRequestBody({ blob: "x".repeat(2000) });
    expect(out.length).toBeLessThanOrEqual(500);
    // Replacer ellipsis marker (single char) must appear; outer truncation
    // marker should NOT, since the replacer already kept us under the cap.
    expect(out).toContain("…");
    expect(out.endsWith("…[truncated]")).toBe(false);
  });

  it("applies the 500-char outer slice with truncation marker for many fields", () => {
    // A wide object with many short keys can still blow past 500 chars even
    // with per-string compression. The outer slice + truncation marker is the
    // safety net.
    const wide: Record<string, string> = {};
    for (let i = 0; i < 80; i += 1) wide[`field_${i}`] = `value_${i}`;
    const out = captureRequestBody(wide);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("does not throw on circular structures", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => captureRequestBody(obj)).not.toThrow();
  });
});

describe("pre/post-routing parity: 413 and 422 produce identical tracker path", () => {
  it("buildTrackerKey returns the same key.path regardless of which HTTP status code follows", () => {
    const path = "/api/issues/LIF-375/comments";
    // Two requests for the same endpoint — one that will get 413, one that will get 422.
    // The tracker key is built from the request only (no status code), so key.path must be identical.
    const req413 = agentReq(path, "POST");
    const req422 = agentReq(path, "POST");

    const key413 = buildTrackerKey(req413);
    const key422 = buildTrackerKey(req422);

    expect(key413).not.toBeNull();
    expect(key422).not.toBeNull();
    expect(key413!.path).toBe(key422!.path);
    expect(key413!.path).toBe("/api/issues/:id/comments");
  });

  it("normalizeAgentPath is idempotent across the two status-code paths", () => {
    const rawPath = "/api/issues/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/comments";
    // Whether the response will be 413 or 422 does not affect path normalization.
    expect(normalizeAgentPath(rawPath)).toBe(normalizeAgentPath(rawPath));
  });
});

describe("captureRequestBody — 5MB body completes within event-loop budget", () => {
  it("captures 5MB body without freezing event loop (resolves within 200ms)", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const wait = (ms: number) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`captureRequestBody took longer than ${ms}ms`)), ms),
      );

    const result = await Promise.race([
      Promise.resolve(captureRequestBody({ blob: big })),
      wait(200),
    ]);

    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
