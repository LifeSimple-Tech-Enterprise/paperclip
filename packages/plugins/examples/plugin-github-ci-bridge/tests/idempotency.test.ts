/**
 * Idempotency tests for github-ci-bridge — TDD red phase (LIF-343 §6).
 *
 * Tests that duplicate webhook deliveries (same runId_runAttempt) do not
 * double-wake the agent or duplicate the scratchpad entry.
 *
 * Both tests call `onWebhook` which currently throws "not implemented",
 * so they fail red until Drafter (LIF-340) implements the full worker.
 */

import { describe, expect, it, vi } from "vitest";
import { onWebhook } from "../src/worker.js";

// ---------------------------------------------------------------------------
// ctx factory (shared state, mimics a single delivery's side-effect store)
// ---------------------------------------------------------------------------

function makeCtxWithState() {
  const wakeCallLog: unknown[] = [];
  const scratchpadState = new Map<string, unknown[]>();

  const ctx = {
    agents: {
      wake: vi.fn().mockImplementation((payload: unknown) => {
        wakeCallLog.push(payload);
        return Promise.resolve();
      }),
    },
    scratchpad: {
      append: vi.fn().mockImplementation((key: string, value: unknown) => {
        const existing = scratchpadState.get(key) ?? [];
        const idempotencyKey = (value as { idempotencyKey?: string })?.idempotencyKey;
        if (idempotencyKey && existing.some((e) => (e as { idempotencyKey?: string }).idempotencyKey === idempotencyKey)) {
          // Duplicate — skip
          return Promise.resolve();
        }
        existing.push(value);
        scratchpadState.set(key, existing);
        return Promise.resolve();
      }),
    },
    issues: {
      patch: vi.fn().mockResolvedValue(undefined),
    },
    comments: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  };

  return { ctx, wakeCallLog, scratchpadState };
}

// ---------------------------------------------------------------------------
// Test payload factory
// ---------------------------------------------------------------------------

function webhookPayload(runId: string, runAttempt: number) {
  return {
    endpointKey: "ci_event",
    parsedBody: {
      workflow_run: {
        id: Number(runId),
        run_attempt: runAttempt,
        conclusion: "success",
        head_branch: "lif-200-feat",
        html_url: "https://github.com/isaacyip007/calmnotify/actions/runs/100001",
        pull_requests: [{ head: { ref: "lif-200-feat" } }],
      },
      repository: { full_name: "isaacyip007/calmnotify" },
    },
    rawBody: JSON.stringify({ runId, runAttempt }),
    headers: {},
    requestId: `req-${runId}-${runAttempt}`,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("onWebhook idempotency", () => {
  it("5.1 duplicate webhook delivery does not double-wake the agent", async () => {
    const { ctx, wakeCallLog } = makeCtxWithState();
    const payload = webhookPayload("100001", 1);

    await onWebhook({ ...payload, ctx });
    await onWebhook({ ...payload, ctx });

    expect(wakeCallLog).toHaveLength(1);
  });

  it("5.2 duplicate webhook delivery does not duplicate the scratchpad entry", async () => {
    const { ctx, scratchpadState } = makeCtxWithState();
    const payload = webhookPayload("100001", 1);

    await onWebhook({ ...payload, ctx });
    await onWebhook({ ...payload, ctx });

    const entries = scratchpadState.get("pendingCiEvents");
    expect(entries).toBeDefined();
    expect(entries!.length).toBe(1);
  });
});
