/**
 * HMAC verification tests for github-ci-bridge — TDD red phase (LIF-343 §3).
 *
 * Signing convention: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) → `sha256=<hex>`
 * (Paperclip-native relay shape from paperclip-ci-webhook.yml, NOT raw GitHub signing).
 *
 * All tests call `verifyHmac` from src/worker.ts. That function currently throws
 * "not implemented", so every test fails red until Drafter (LIF-340) implements it.
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyHmac } from "../src/worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(secret: string, timestamp: number, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

const NOW_SEC = 1_700_000_000;
const RAW_BODY = JSON.stringify({ action: "completed", workflow_run: { id: 1 } });

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("verifyHmac", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("2.1 accepts valid HMAC with current secret", async () => {
    const secret = "super-secret-key";
    const sig = sign(secret, NOW_SEC, RAW_BODY);

    const result = await verifyHmac(RAW_BODY, sig, String(NOW_SEC), [secret]);

    expect(result).toEqual({ ok: true });
  });

  it("2.2 accepts valid HMAC with rotated secret list (second secret matches)", async () => {
    const oldSecret = "old-secret";
    const newSecret = "new-secret";
    const sig = sign(newSecret, NOW_SEC, RAW_BODY);

    const result = await verifyHmac(RAW_BODY, sig, String(NOW_SEC), [oldSecret, newSecret]);

    expect(result).toEqual({ ok: true });
  });

  it("2.3 rejects HMAC signed with unknown secret", async () => {
    const validSecret = "known-secret";
    const unknownSecret = "unknown-secret";
    const sig = sign(unknownSecret, NOW_SEC, RAW_BODY);

    const result = await verifyHmac(RAW_BODY, sig, String(NOW_SEC), [validSecret]);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("2.4 rejects timestamp drift > 300s (replay window)", async () => {
    const secret = "super-secret-key";
    const staleTs = NOW_SEC - 301;
    const sig = sign(secret, staleTs, RAW_BODY);

    const result = await verifyHmac(RAW_BODY, sig, String(staleTs), [secret]);

    expect(result).toEqual({ ok: false, reason: "replay" });
  });
});
