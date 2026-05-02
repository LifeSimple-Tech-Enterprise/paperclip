import { describe, expect, it } from "vitest";
import {
  extractWakeInteraction,
  mergeCoalescedContextSnapshot,
} from "../services/heartbeat.ts";
import {
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

const INTERACTION_ID = "11111111-1111-1111-1111-111111111111";
const ISSUE_ID = "22222222-2222-2222-2222-222222222222";
const AGENT_ID = "33333333-3333-3333-3333-333333333333";

function makeInteractionSnapshot(overrides?: Record<string, unknown>) {
  return {
    id: INTERACTION_ID,
    kind: "ask_user_questions",
    status: "answered",
    result: { version: 1, answers: [{ questionId: "q1", optionIds: ["opt-a"] }] },
    resolvedAt: "2026-05-02T10:00:00.000Z",
    resolvedByAgentId: null,
    resolvedByUserId: "user-42",
    ...overrides,
  };
}

describe("extractWakeInteraction", () => {
  it("returns null when no wakeInteraction in snapshot", () => {
    expect(extractWakeInteraction({ wakeReason: "issue_commented" })).toBeNull();
  });

  it("returns the wakeInteraction object when present and has an id", () => {
    const snapshot = {
      wakeReason: "interaction_resolved",
      wakeInteraction: makeInteractionSnapshot(),
    };
    const result = extractWakeInteraction(snapshot);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(INTERACTION_ID);
    expect(result?.kind).toBe("ask_user_questions");
  });
});

describe("mergeCoalescedContextSnapshot — wakeInteraction", () => {
  it("preserves wakeInteraction when coalescing an incoming snapshot", () => {
    const existing = {
      issueId: ISSUE_ID,
      wakeReason: "interaction_resolved",
      wakeInteraction: makeInteractionSnapshot(),
    };
    const incoming = {
      issueId: ISSUE_ID,
      wakeReason: "interaction_resolved",
      // new interaction supersedes old one in last-write-wins merge
      wakeInteraction: makeInteractionSnapshot({
        id: "44444444-4444-4444-4444-444444444444",
        kind: "request_confirmation",
        status: "accepted",
      }),
    };
    const merged = mergeCoalescedContextSnapshot(existing, incoming);
    // last-write-wins: incoming takes precedence
    const wi = merged.wakeInteraction as Record<string, unknown>;
    expect(wi.id).toBe("44444444-4444-4444-4444-444444444444");
    expect(wi.kind).toBe("request_confirmation");
  });

  it("carries wakeInteraction forward when incoming snapshot has no wakeInteraction", () => {
    const existing = {
      issueId: ISSUE_ID,
      wakeInteraction: makeInteractionSnapshot(),
    };
    const incoming = { issueId: ISSUE_ID, wakeReason: "issue_commented" };
    const merged = mergeCoalescedContextSnapshot(existing, incoming);
    const wi = merged.wakeInteraction as Record<string, unknown>;
    expect(wi.id).toBe(INTERACTION_ID);
  });
});

describe("normalizePaperclipWakePayload — interactionEvents", () => {
  it("returns non-null payload for interaction-only wake (no comments, no issue)", () => {
    const raw = {
      reason: "interaction_resolved",
      interactionEvents: [
        {
          id: INTERACTION_ID,
          kind: "ask_user_questions",
          status: "answered",
          result: { version: 1, answers: [], summaryMarkdown: "Prefers dark mode" },
          resolvedAt: "2026-05-02T10:00:00.000Z",
          resolvedByAgentId: AGENT_ID,
          resolvedByUserId: null,
          sourceCommentId: null,
          sourceRunId: null,
        },
      ],
    };
    const normalized = normalizePaperclipWakePayload(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.interactionEvents).toHaveLength(1);
    expect(normalized?.interactionEvents[0].id).toBe(INTERACTION_ID);
    expect(normalized?.interactionEvents[0].kind).toBe("ask_user_questions");
    expect(normalized?.interactionEvents[0].resolvedByAgentId).toBe(AGENT_ID);
  });
});

describe("renderPaperclipWakePrompt — interaction events", () => {
  function makeInteractionPayload(extraComments = false) {
    return {
      reason: "interaction_resolved",
      issue: { id: ISSUE_ID, identifier: "LIF-657", title: "Test issue", status: "in_progress" },
      interactionEvents: [
        {
          id: INTERACTION_ID,
          kind: "ask_user_questions",
          status: "answered",
          result: { version: 1, answers: [], summaryMarkdown: "User prefers dark mode" },
          resolvedAt: "2026-05-02T10:00:00.000Z",
          resolvedByAgentId: null,
          resolvedByUserId: "user-42",
          sourceCommentId: null,
          sourceRunId: null,
        },
      ],
      ...(extraComments
        ? {
            commentIds: ["cmt-1"],
            latestCommentId: "cmt-1",
            comments: [{ id: "cmt-1", body: "A comment" }],
            commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          }
        : {
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
          }),
      fallbackFetchNeeded: false,
    };
  }

  it("replaces pending-comments header with resolved-interactions when no comments", () => {
    const prompt = renderPaperclipWakePrompt(makeInteractionPayload(false));
    expect(prompt).toContain("- resolved interactions: 1");
    expect(prompt).toContain(`- latest interaction id: ${INTERACTION_ID}`);
    expect(prompt).not.toContain("pending comments: 0/0");
    expect(prompt).not.toContain("latest comment id: unknown");
  });

  it("renders interaction details block with summarized result", () => {
    const prompt = renderPaperclipWakePrompt(makeInteractionPayload(false));
    expect(prompt).toContain("Resolved interactions in this wake:");
    expect(prompt).toContain(`interaction ${INTERACTION_ID}`);
    expect(prompt).toContain("ask_user_questions");
    expect(prompt).toContain("status: answered");
    expect(prompt).toContain("result: User prefers dark mode");
  });

  it("shows pending-comments header (not resolved-interactions) when comments are also present", () => {
    const prompt = renderPaperclipWakePrompt(makeInteractionPayload(true));
    expect(prompt).toContain("- pending comments: 1/1");
    expect(prompt).toContain("- latest comment id: cmt-1");
    // interactions block is still rendered after comments
    expect(prompt).toContain("Resolved interactions in this wake:");
  });
});
