import { describe, expect, it, vi } from "vitest";
import { reactToEvent, type ReactCtx, type ReactToEventInput } from "../src/worker.js";

/**
 * LIF-343 §6 — Wake & scratchpad idempotency.
 *
 * The CI relay can deliver the same `(runId, runAttempt)` more than once
 * (workflow_run is at-least-once on retries). Duplicate deliveries must NOT
 * produce duplicate wakes or duplicate scratchpad entries.
 *
 * Idempotency key contract: `${runId}_${runAttempt}`. The plugin must pass
 * this to `ctx.agents.wake({ idempotencyKey })` and
 * `ctx.scratchpad.append({ idempotencyKey })`. The host de-dupes against
 * the key and reports "already-fired" without invoking the side-effect a
 * second time.
 *
 * RED-phase: `reactToEvent` throws "not implemented".
 */

function makeCtx() {
  const sentWakes = new Set<string>();
  const sentScratchpadEntries = new Set<string>();

  const wake = vi.fn(async (input: { idempotencyKey: string }) => {
    if (sentWakes.has(input.idempotencyKey)) return; // host de-dupe
    sentWakes.add(input.idempotencyKey);
  });
  const append = vi.fn(async (input: { idempotencyKey: string }) => {
    if (sentScratchpadEntries.has(input.idempotencyKey)) return; // host de-dupe
    sentScratchpadEntries.add(input.idempotencyKey);
  });

  const ctx: ReactCtx = {
    comments: { create: vi.fn().mockResolvedValue(undefined) },
    agents: { wake },
    issues: { patch: vi.fn().mockResolvedValue(undefined) },
    scratchpad: { append },
  };

  return { ctx, wake, append, sentWakes, sentScratchpadEntries };
}

function makeInput(overrides: Partial<ReactToEventInput> = {}): ReactToEventInput {
  return {
    issueId: "issue-A-uuid",
    issueStatus: "in_progress",
    unblockCondition: null,
    conclusion: "success",
    agentState: "idle",
    runId: 100001,
    runAttempt: 1,
    runUrl: "https://example.invalid/run/100001",
    branch: "lif-200-feat",
    prNumber: 42,
    failedJobs: [],
    assigneeAgentId: "agent-A-uuid",
    ...overrides,
  };
}

describe("idempotency — duplicate webhook delivery (github-ci-bridge plugin)", () => {
  it("5.1 duplicate (idle, in_progress, success) does not double-wake the assignee", async () => {
    const { ctx, wake, sentWakes } = makeCtx();
    const input = makeInput({ runId: 200001, runAttempt: 1 });

    await reactToEvent(input, ctx);
    await reactToEvent(input, ctx); // identical payload, identical idempotency key

    // Plugin must call wake with the same idempotency key both times.
    // The HOST de-dupes — that's what `sentWakes` simulates. The contract is
    // that plugins MUST pass `${runId}_${runAttempt}`, never a fresh nonce.
    const idempotencyKeys = wake.mock.calls.map(
      ([arg]) => (arg as { idempotencyKey: string }).idempotencyKey,
    );
    expect(idempotencyKeys.every((k) => k === "200001_1")).toBe(true);
    expect(sentWakes.size).toBe(1);
  });

  it("5.2 duplicate (active, in_progress, failure) does not double-append to pendingCiEvents", async () => {
    const { ctx, append, sentScratchpadEntries } = makeCtx();
    const input = makeInput({
      runId: 200002,
      runAttempt: 2,
      conclusion: "failure",
      agentState: "active",
      failedJobs: [{ name: "unit-tests" }],
    });

    await reactToEvent(input, ctx);
    await reactToEvent(input, ctx);

    const idempotencyKeys = append.mock.calls.map(
      ([arg]) => (arg as { idempotencyKey: string }).idempotencyKey,
    );
    expect(idempotencyKeys.every((k) => k === "200002_2")).toBe(true);
    expect(sentScratchpadEntries.size).toBe(1);
  });
});
