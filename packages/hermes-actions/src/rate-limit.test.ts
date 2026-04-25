/**
 * Tests for per-action_id rate limiting — Stage E2 (LIF-257).
 *
 * Unit:
 *   - 3 calls within an hour pass; 4th raises RateLimitError.
 *   - Counter resets after the rolling window.
 *   - resetAt is set to (oldest_ts_in_window + 1 hour).
 *   - Custom maxPerHour is respected.
 *   - Separate action_ids have independent counters.
 *   - RateLimitError exposes actionId, limit, resetAt.
 *
 * Integration:
 *   - Simulate 5 rapid restart calls (60 s virtual span): 4th and 5th blocked.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkAndRecord,
  RateLimitError,
  DEFAULT_MAX_PER_HOUR,
  WINDOW_MS,
} from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a fresh tmp directory for the rate-limit store per test. */
async function makeTmpDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "hermes-rl-test-"));
}

/** Build an options object using a tmp dir and a controllable clock. */
function makeOpts(
  dir: string,
  nowFn: () => Date,
): { storePath: string; now: () => Date } {
  return {
    storePath: path.join(dir, "ratelimit.json"),
    now: nowFn,
  };
}

// ---------------------------------------------------------------------------
// Unit tests — checkAndRecord
// ---------------------------------------------------------------------------

describe("checkAndRecord — rolling window", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows exactly maxPerHour (default=3) calls within the window", async () => {
    const baseMs = Date.now();
    const now = (offset: number) => () => new Date(baseMs + offset);

    const opts0 = makeOpts(tmpDir, now(0));
    const opts1 = makeOpts(tmpDir, now(1000));
    const opts2 = makeOpts(tmpDir, now(2000));

    await expect(
      checkAndRecord("service_restart_paperclip", DEFAULT_MAX_PER_HOUR, opts0),
    ).resolves.toBeUndefined();

    await expect(
      checkAndRecord("service_restart_paperclip", DEFAULT_MAX_PER_HOUR, opts1),
    ).resolves.toBeUndefined();

    await expect(
      checkAndRecord("service_restart_paperclip", DEFAULT_MAX_PER_HOUR, opts2),
    ).resolves.toBeUndefined();
  });

  it("throws RateLimitError on the (maxPerHour+1)th call", async () => {
    const baseMs = Date.now();
    let tick = 0;
    const now = () => new Date(baseMs + tick++ * 1000);

    const opts = makeOpts(tmpDir, now);

    // 3 passes
    await checkAndRecord("service_restart_paperclip", 3, opts);
    await checkAndRecord("service_restart_paperclip", 3, opts);
    await checkAndRecord("service_restart_paperclip", 3, opts);

    // 4th should be blocked
    await expect(
      checkAndRecord("service_restart_paperclip", 3, opts),
    ).rejects.toThrow(RateLimitError);
  });

  it("RateLimitError exposes actionId, limit, and resetAt", async () => {
    const baseMs = 1_000_000_000_000; // fixed epoch for deterministic resetAt
    let tick = 0;
    const now = () => new Date(baseMs + tick++ * 500);
    const opts = makeOpts(tmpDir, now);

    await checkAndRecord("pm2_restart", 1, opts); // tick=0 → ts = baseMs

    let thrown: RateLimitError | undefined;
    try {
      await checkAndRecord("pm2_restart", 1, opts); // tick=1 → blocked
    } catch (e) {
      thrown = e as RateLimitError;
    }

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect(thrown!.actionId).toBe("pm2_restart");
    expect(thrown!.limit).toBe(1);
    // resetAt = oldest_ts (baseMs) + WINDOW_MS
    expect(thrown!.resetAt.getTime()).toBe(baseMs + WINDOW_MS);
    expect(thrown!.name).toBe("RateLimitError");
    expect(thrown!.message).toContain("pm2_restart");
    expect(thrown!.message).toContain("max 1/hour");
  });

  it("counter resets after the rolling window elapses", async () => {
    const baseMs = Date.now();
    // First 3 calls within the window
    for (let i = 0; i < 3; i++) {
      const now = () => new Date(baseMs + i * 100);
      await checkAndRecord("ufw_status", 3, makeOpts(tmpDir, now));
    }

    // Now advance time beyond 1 hour — all previous timestamps are outside the window
    const futureOpts = makeOpts(tmpDir, () => new Date(baseMs + WINDOW_MS + 1000));

    // Should pass again (old timestamps pruned)
    await expect(
      checkAndRecord("ufw_status", 3, futureOpts),
    ).resolves.toBeUndefined();
  });

  it("independent action_ids do not share counters", async () => {
    const baseMs = Date.now();
    let tick = 0;
    const now = () => new Date(baseMs + tick++ * 1000);
    const opts = makeOpts(tmpDir, now);

    // Exhaust limit for action A
    await checkAndRecord("service_restart_paperclip", 1, opts);

    // Action B should still be allowed
    await expect(
      checkAndRecord("service_restart_github_runner", 1, opts),
    ).resolves.toBeUndefined();

    // Action A is still blocked
    await expect(
      checkAndRecord("service_restart_paperclip", 1, opts),
    ).rejects.toThrow(RateLimitError);
  });

  it("custom maxPerHour is respected", async () => {
    const baseMs = Date.now();
    let tick = 0;
    const now = () => new Date(baseMs + tick++ * 100);
    const opts = makeOpts(tmpDir, now);

    // Cap of 5: first 5 should pass
    for (let i = 0; i < 5; i++) {
      await expect(
        checkAndRecord("diag_health_probe", 5, opts),
      ).resolves.toBeUndefined();
    }

    // 6th blocked
    await expect(
      checkAndRecord("diag_health_probe", 5, opts),
    ).rejects.toThrow(RateLimitError);
  });

  it("store persists across separate checkAndRecord calls (survives heartbeat exit simulation)", async () => {
    const storePath = path.join(tmpDir, "ratelimit.json");
    const baseMs = Date.now();

    // Call 1: process A
    await checkAndRecord("pm2_restart", 2, { storePath, now: () => new Date(baseMs) });
    // Call 2: process B (reads same file)
    await checkAndRecord("pm2_restart", 2, { storePath, now: () => new Date(baseMs + 1000) });
    // Call 3: process C — should be blocked (limit=2)
    await expect(
      checkAndRecord("pm2_restart", 2, { storePath, now: () => new Date(baseMs + 2000) }),
    ).rejects.toThrow(RateLimitError);

    // Verify the store file actually exists and contains the two timestamps
    const raw = JSON.parse(await fsPromises.readFile(storePath, "utf8"));
    expect(Array.isArray(raw["pm2_restart"])).toBe(true);
    expect(raw["pm2_restart"]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration test — 5 routine restart calls, 4th and 5th blocked
// ---------------------------------------------------------------------------

describe("checkAndRecord — integration: 5 restart calls, 4th and 5th blocked", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it("calls 1–3 pass; calls 4 and 5 are blocked (5 calls in 60 s virtual time)", async () => {
    const baseMs = Date.now();
    // Spread 5 calls over 60 seconds (well inside the 1-hour window)
    const timestamps = [0, 12_000, 24_000, 36_000, 48_000].map(
      (offset) => baseMs + offset,
    );

    const results: Array<"pass" | "blocked"> = [];

    for (const ts of timestamps) {
      try {
        await checkAndRecord(
          "service_restart_paperclip",
          3, // default cap
          {
            storePath: path.join(tmpDir, "ratelimit.json"),
            now: () => new Date(ts),
          },
        );
        results.push("pass");
      } catch (e) {
        expect(e).toBeInstanceOf(RateLimitError);
        results.push("blocked");
      }
    }

    expect(results).toEqual(["pass", "pass", "pass", "blocked", "blocked"]);
  });
});
