import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyHmac } from "../src/worker.js";

/**
 * LIF-343 §3 — Plugin HMAC verify.
 *
 * Convention: HMAC-SHA256(secret, "<unix-seconds>.<rawBody>") → "sha256=<hex>".
 * Replay window: ±300 seconds against `Date.now()`.
 *
 * RED-phase: `verifyHmac` throws "not implemented". Drafter (LIF-340) makes
 * each assertion green by implementing the function in `src/worker.ts`.
 */

const FIXED_NOW_MS = 1_700_000_000_000; // 2023-11-14 22:13:20 UTC — stable seed

function sign(secret: string, timestampSec: number, rawBody: string): string {
  const hex = createHmac("sha256", secret)
    .update(`${timestampSec}.${rawBody}`)
    .digest("hex");
  return `sha256=${hex}`;
}

describe("verifyHmac (github-ci-bridge plugin)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("2.1 accepts a valid HMAC signed with the current secret", () => {
    const secret = "current-secret-rotated-2026";
    const body = JSON.stringify({ workflow_run: { id: 1 } });
    const ts = Math.floor(FIXED_NOW_MS / 1000);
    const signature = sign(secret, ts, body);

    const result = verifyHmac(body, signature, String(ts), [secret]);

    expect(result).toEqual({ ok: true });
  });

  it("2.2 accepts a valid HMAC signed with any secret in a rotated secret list", () => {
    const oldSecret = "stale-secret-q3-2025";
    const newSecret = "rotated-secret-q4-2025";
    const body = JSON.stringify({ workflow_run: { id: 2 } });
    const ts = Math.floor(FIXED_NOW_MS / 1000);
    // Caller signed with the NEW secret; the plugin still has both during the
    // rotation drain window. Both must be tried before rejecting.
    const signature = sign(newSecret, ts, body);

    const result = verifyHmac(body, signature, String(ts), [oldSecret, newSecret]);

    expect(result).toEqual({ ok: true });
  });

  it("2.3 rejects an HMAC signed with an unknown secret", () => {
    const trustedSecret = "trusted-secret";
    const attackerSecret = "attacker-guess";
    const body = JSON.stringify({ workflow_run: { id: 3 } });
    const ts = Math.floor(FIXED_NOW_MS / 1000);
    const signature = sign(attackerSecret, ts, body);

    const result = verifyHmac(body, signature, String(ts), [trustedSecret]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("2.4 rejects when timestamp drift exceeds the 300s replay window", () => {
    const secret = "current-secret";
    const body = JSON.stringify({ workflow_run: { id: 4 } });
    // Signed 301 seconds in the past — outside the 5-minute replay window.
    const staleTs = Math.floor(FIXED_NOW_MS / 1000) - 301;
    const signature = sign(secret, staleTs, body);

    const result = verifyHmac(body, signature, String(staleTs), [secret]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("replay");
  });
});
