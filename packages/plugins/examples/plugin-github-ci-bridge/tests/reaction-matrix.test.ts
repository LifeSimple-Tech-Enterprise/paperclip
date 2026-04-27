/**
 * Reaction matrix tests for github-ci-bridge — TDD red phase (LIF-343 §5).
 *
 * Parameterised over the 9-row matrix from LIF-335 plan §4.3, plus a 10th
 * assertion for the unblockCondition guard.
 *
 * All tests call `reactToEvent` which currently throws "not implemented",
 * so every test fails red until Drafter (LIF-342) implements it.
 *
 * Matrix columns:
 *   [issueStatus, conclusion, agentState, expectedAction,
 *    expectedComment, expectedWake, expectedScratchpad, expectedStatusChange]
 */

import { describe, expect, it, vi } from "vitest";
import { reactToEvent } from "../src/worker.js";

// ---------------------------------------------------------------------------
// Matrix definition (LIF-335 §4.3)
// ---------------------------------------------------------------------------

type MatrixRow = readonly [
  issueStatus: string,
  conclusion: string,
  agentState: string,
  expectedAction: string,
  expectedComment: boolean,
  expectedWake: boolean,
  expectedScratchpad: boolean,
  expectedStatusChange: string | null,
];

const MATRIX: MatrixRow[] = [
  // issueStatus  conclusion  agentState  action              comment  wake   scratch  statusChange
  ["in_progress", "success",  "idle",     "comment+wake",     true,    true,  false,   null],
  ["in_progress", "success",  "active",   "comment+scratch",  true,    false, true,    null],
  ["in_progress", "failure",  "idle",     "comment+wake",     true,    true,  false,   null],
  ["in_progress", "failure",  "active",   "comment+scratch",  true,    false, true,    null],
  ["blocked",     "success",  "idle",     "flip+wake",        true,    true,  false,   "in_progress"],
  ["blocked",     "success",  "active",   "flip+scratch",     true,    false, true,    "in_progress"],
  ["blocked",     "failure",  "idle",     "comment+wake",     true,    true,  false,   null],
  ["blocked",     "failure",  "active",   "comment+scratch",  true,    false, true,    null],
  ["done",        "any",      "any",      "comment-only",     true,    false, false,   null],
];

// ---------------------------------------------------------------------------
// ctx factory
// ---------------------------------------------------------------------------

function makeCtx() {
  const comments = { create: vi.fn().mockResolvedValue(undefined) };
  const agents = { wake: vi.fn().mockResolvedValue(undefined) };
  const scratchpadEntries = new Map<string, unknown>();
  const scratchpad = {
    append: vi.fn().mockImplementation((key: string, value: unknown) => {
      scratchpadEntries.set(key, value);
      return Promise.resolve();
    }),
  };
  const issuesPatched: Array<{ status: string }> = [];
  const issues = {
    patch: vi.fn().mockImplementation((update: { status: string }) => {
      issuesPatched.push(update);
      return Promise.resolve();
    }),
  };

  return { comments, agents, scratchpad, issues, scratchpadEntries, issuesPatched };
}

function makeEvent(
  issueStatus: string,
  conclusion: string,
  agentState: string,
  unblockCondition = "ci_pending",
) {
  return {
    issueId: "issue-test-1",
    issueStatus,
    conclusion,
    agentState,
    unblockCondition,
    runId: "run-001",
    runAttempt: 1,
    runUrl: "https://github.com/isaacyip007/calmnotify/actions/runs/100001",
    failedJobs: conclusion === "failure"
      ? [{ name: "test", html_url: "https://github.com/.../jobs/1" }]
      : [],
    branch: "lif-200-feat",
    prNumber: 42,
  };
}

// ---------------------------------------------------------------------------
// Matrix tests (9 rows)
// ---------------------------------------------------------------------------

describe("reactToEvent matrix", () => {
  it.each(MATRIX)(
    "%s / %s / %s → %s",
    async (
      issueStatus,
      conclusion,
      agentState,
      _action,
      expectedComment,
      expectedWake,
      expectedScratchpad,
      expectedStatusChange,
    ) => {
      const ctx = makeCtx();
      const event = makeEvent(issueStatus, conclusion, agentState);

      await reactToEvent(event, ctx);

      if (expectedComment) {
        expect(ctx.comments.create).toHaveBeenCalled();
      } else {
        expect(ctx.comments.create).not.toHaveBeenCalled();
      }

      if (expectedWake) {
        expect(ctx.agents.wake).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: event.runId,
            conclusion: event.conclusion,
          }),
        );
      } else {
        expect(ctx.agents.wake).not.toHaveBeenCalled();
      }

      if (expectedScratchpad) {
        expect(ctx.scratchpad.append).toHaveBeenCalled();
      } else {
        expect(ctx.scratchpad.append).not.toHaveBeenCalled();
      }

      if (expectedStatusChange !== null) {
        expect(ctx.issues.patch).toHaveBeenCalledWith(
          expect.objectContaining({ status: expectedStatusChange }),
        );
      } else {
        expect(ctx.issues.patch).not.toHaveBeenCalled();
      }
    },
  );

  // 10th assertion: blocked with unblockCondition=manual → comment-only (no status flip, no wake)
  it("blocked / success / idle → comment-only when unblockCondition=manual", async () => {
    const ctx = makeCtx();
    const event = makeEvent("blocked", "success", "idle", "manual");

    await reactToEvent(event, ctx);

    expect(ctx.comments.create).toHaveBeenCalled();
    expect(ctx.agents.wake).not.toHaveBeenCalled();
    expect(ctx.issues.patch).not.toHaveBeenCalled();
  });
});
