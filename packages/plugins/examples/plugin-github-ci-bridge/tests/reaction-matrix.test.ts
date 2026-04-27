import { describe, expect, it, vi } from "vitest";
import {
  reactToEvent,
  type AgentExecutionState,
  type CiConclusion,
  type IssueLifecycleStatus,
  type ReactCtx,
  type ReactToEventInput,
} from "../src/worker.js";

/**
 * LIF-343 §5 — Reaction matrix (parameterised over LIF-335 plan §4.3).
 *
 * Each row encodes: (issue.status, ci.conclusion, agentState) → action.
 * RED-phase: `reactToEvent` throws "not implemented".
 *
 * Columns:
 *   wantComment    — ctx.comments.create called once
 *   wantWake       — ctx.agents.wake called once (idempotency keyed by runId_runAttempt)
 *   wantScratchpad — ctx.scratchpad.append called once under `pendingCiEvents`
 *   wantStatusFlip — ctx.issues.patch called with status: "in_progress" (else null)
 */

interface MatrixRow {
  name: string;
  issueStatus: IssueLifecycleStatus;
  unblockCondition?: string | null;
  conclusion: CiConclusion;
  agentState: AgentExecutionState;
  wantComment: boolean;
  wantWake: boolean;
  wantScratchpad: boolean;
  wantStatusFlip: IssueLifecycleStatus | null;
}

const MATRIX: MatrixRow[] = [
  // in_progress × success
  {
    name: "in_progress + success + idle → comment + wake",
    issueStatus: "in_progress",
    conclusion: "success",
    agentState: "idle",
    wantComment: true,
    wantWake: true,
    wantScratchpad: false,
    wantStatusFlip: null,
  },
  {
    name: "in_progress + success + active → comment + scratchpad (no wake)",
    issueStatus: "in_progress",
    conclusion: "success",
    agentState: "active",
    wantComment: true,
    wantWake: false,
    wantScratchpad: true,
    wantStatusFlip: null,
  },
  // in_progress × failure
  {
    name: "in_progress + failure + idle → comment + wake",
    issueStatus: "in_progress",
    conclusion: "failure",
    agentState: "idle",
    wantComment: true,
    wantWake: true,
    wantScratchpad: false,
    wantStatusFlip: null,
  },
  {
    name: "in_progress + failure + active → comment + scratchpad (no wake)",
    issueStatus: "in_progress",
    conclusion: "failure",
    agentState: "active",
    wantComment: true,
    wantWake: false,
    wantScratchpad: true,
    wantStatusFlip: null,
  },
  // blocked(ci_pending) × success → flip to in_progress
  {
    name: "blocked(ci_pending) + success + idle → flip to in_progress + wake",
    issueStatus: "blocked",
    unblockCondition: "ci_pending",
    conclusion: "success",
    agentState: "idle",
    wantComment: true,
    wantWake: true,
    wantScratchpad: false,
    wantStatusFlip: "in_progress",
  },
  {
    name: "blocked(ci_pending) + success + active → flip to in_progress + scratchpad",
    issueStatus: "blocked",
    unblockCondition: "ci_pending",
    conclusion: "success",
    agentState: "active",
    wantComment: true,
    wantWake: false,
    wantScratchpad: true,
    wantStatusFlip: "in_progress",
  },
  // blocked(ci_pending) × failure → stay blocked
  {
    name: "blocked(ci_pending) + failure + idle → comment + wake (stay blocked)",
    issueStatus: "blocked",
    unblockCondition: "ci_pending",
    conclusion: "failure",
    agentState: "idle",
    wantComment: true,
    wantWake: true,
    wantScratchpad: false,
    wantStatusFlip: null,
  },
  {
    name: "blocked(ci_pending) + failure + active → comment + scratchpad (stay blocked)",
    issueStatus: "blocked",
    unblockCondition: "ci_pending",
    conclusion: "failure",
    agentState: "active",
    wantComment: true,
    wantWake: false,
    wantScratchpad: true,
    wantStatusFlip: null,
  },
  // done × any → comment-only audit
  {
    name: "done + success + active → comment-only (no wake, no flip)",
    issueStatus: "done",
    conclusion: "success",
    agentState: "active",
    wantComment: true,
    wantWake: false,
    wantScratchpad: false,
    wantStatusFlip: null,
  },
];

function makeCtx(): {
  ctx: ReactCtx;
  spies: {
    commentsCreate: ReturnType<typeof vi.fn>;
    agentsWake: ReturnType<typeof vi.fn>;
    issuesPatch: ReturnType<typeof vi.fn>;
    scratchpadAppend: ReturnType<typeof vi.fn>;
  };
} {
  const commentsCreate = vi.fn().mockResolvedValue(undefined);
  const agentsWake = vi.fn().mockResolvedValue(undefined);
  const issuesPatch = vi.fn().mockResolvedValue(undefined);
  const scratchpadAppend = vi.fn().mockResolvedValue(undefined);

  return {
    spies: { commentsCreate, agentsWake, issuesPatch, scratchpadAppend },
    ctx: {
      comments: { create: commentsCreate },
      agents: { wake: agentsWake },
      issues: { patch: issuesPatch },
      scratchpad: { append: scratchpadAppend },
    },
  };
}

function makeInput(row: MatrixRow): ReactToEventInput {
  return {
    issueId: "issue-A-uuid",
    issueStatus: row.issueStatus,
    unblockCondition: row.unblockCondition ?? null,
    conclusion: row.conclusion,
    agentState: row.agentState,
    runId: 100001,
    runAttempt: 1,
    runUrl: "https://github.com/isaacyip007/calmnotify/actions/runs/100001",
    branch: "lif-200-feat",
    prNumber: 42,
    failedJobs: row.conclusion === "failure" ? [{ name: "unit-tests" }] : [],
    assigneeAgentId: "agent-A-uuid",
  };
}

describe("reactToEvent — LIF-335 plan §4.3 reaction matrix", () => {
  it.each(MATRIX)("$name", async (row) => {
    const { ctx, spies } = makeCtx();

    await reactToEvent(makeInput(row), ctx);

    expect(spies.commentsCreate).toHaveBeenCalledTimes(row.wantComment ? 1 : 0);
    expect(spies.agentsWake).toHaveBeenCalledTimes(row.wantWake ? 1 : 0);
    expect(spies.scratchpadAppend).toHaveBeenCalledTimes(row.wantScratchpad ? 1 : 0);

    if (row.wantStatusFlip) {
      expect(spies.issuesPatch).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: "issue-A-uuid", status: row.wantStatusFlip }),
      );
    } else {
      // Either not called, or called without a status field.
      const flippedCalls = spies.issuesPatch.mock.calls.filter(
        ([arg]) => (arg as { status?: string }).status === "in_progress",
      );
      expect(flippedCalls).toHaveLength(0);
    }

    if (row.wantWake) {
      expect(spies.agentsWake).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-A-uuid",
          idempotencyKey: "100001_1",
          payload: expect.objectContaining({ runId: 100001, conclusion: row.conclusion }),
        }),
      );
    }

    if (row.wantScratchpad) {
      expect(spies.scratchpadAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-A-uuid",
          key: "pendingCiEvents",
          idempotencyKey: "100001_1",
        }),
      );
    }
  });

  it("guard: blocked(unblockCondition='manual') is comment-only — no flip, no wake, no scratchpad", async () => {
    const { ctx, spies } = makeCtx();
    const input = makeInput({
      name: "guard",
      issueStatus: "blocked",
      unblockCondition: "manual",
      conclusion: "success",
      agentState: "idle",
      wantComment: true,
      wantWake: false,
      wantScratchpad: false,
      wantStatusFlip: null,
    });

    await reactToEvent(input, ctx);

    expect(spies.commentsCreate).toHaveBeenCalledTimes(1);
    expect(spies.agentsWake).not.toHaveBeenCalled();
    expect(spies.scratchpadAppend).not.toHaveBeenCalled();
    const flippedCalls = spies.issuesPatch.mock.calls.filter(
      ([arg]) => (arg as { status?: string }).status === "in_progress",
    );
    expect(flippedCalls).toHaveLength(0);
  });
});
