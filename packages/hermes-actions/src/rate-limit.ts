/**
 * HermesAgent V1 per-action_id rate limiter — Stage E2 (LIF-257).
 *
 * Implements a rolling-window (1-hour) rate limit keyed by `action_id`.
 * State is persisted to `/var/log/hermes/ratelimit.json` (atomic write)
 * so it survives heartbeat exits. Each entry stores an array of invocation
 * timestamps (Unix ms); timestamps older than 1 hour are pruned on every read.
 *
 * Default cap: 3 invocations per action per rolling hour.
 * Configurable per-action via `ActionDefinition.maxPerHour` or globally via
 * the `HERMES_RATE_LIMIT_MAX_PER_HOUR` env var.
 *
 * Atomic write strategy: write to `<path>.tmp`, then `fs.rename` (which is
 * atomic on POSIX filesystems within the same directory). If the tmp file
 * already exists from a previous crash, it is overwritten.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_PER_HOUR = 3;
export const WINDOW_MS = 60 * 60 * 1000; // 1 hour in milliseconds
export const DEFAULT_RATE_LIMIT_PATH = "/var/log/hermes/ratelimit.json";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the persisted JSON store. */
export type RateLimitStore = Record<string, number[]>;

export interface RateLimitOptions {
  /** Override the store file path (useful for tests). */
  storePath?: string;
  /** Override the wall-clock provider (useful for tests). */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// RateLimitError
// ---------------------------------------------------------------------------

/**
 * Thrown when an action_id has exceeded its rolling-window cap.
 *
 * `resetAt` is the earliest time at which the rate limit will ease (i.e. when
 * the oldest timestamp in the current window falls out of the 1-hour window).
 * HermesAgent should surface both `limit` and `resetAt` in its blocked comment.
 */
export class RateLimitError extends Error {
  readonly actionId: string;
  readonly limit: number;
  readonly resetAt: Date;

  constructor(actionId: string, limit: number, resetAt: Date) {
    super(
      `Rate limit exceeded for action "${actionId}": max ${limit}/hour. ` +
        `Resets at ${resetAt.toISOString()}.`,
    );
    this.name = "RateLimitError";
    this.actionId = actionId;
    this.limit = limit;
    this.resetAt = resetAt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readStore(storePath: string): Promise<RateLimitStore> {
  try {
    const raw = await fsPromises.readFile(storePath, "utf8");
    return JSON.parse(raw) as RateLimitStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Corrupt file — start fresh rather than hard-failing.
    return {};
  }
}

async function writeStore(
  storePath: string,
  store: RateLimitStore,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(storePath), { recursive: true });

  // Atomic write: write to a temp file in the same directory, then rename.
  const tmpPath = storePath + ".tmp." + process.pid;
  try {
    await fsPromises.writeFile(tmpPath, JSON.stringify(store), "utf8");
    await fsPromises.rename(tmpPath, storePath);
  } catch (err) {
    // Best-effort cleanup of the tmp file.
    await fsPromises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the rolling-window rate limit for `actionId`, then record the current
 * invocation if the limit has not been exceeded.
 *
 * - Reads the persisted store.
 * - Prunes timestamps older than 1 hour.
 * - If `count >= maxPerHour`, throws `RateLimitError` (store is NOT written).
 * - Otherwise appends the current timestamp and writes the store atomically.
 *
 * @param actionId   The action being invoked.
 * @param maxPerHour Cap for this action. Defaults to `DEFAULT_MAX_PER_HOUR`.
 * @param options    Optional overrides for path and clock.
 */
export async function checkAndRecord(
  actionId: string,
  maxPerHour: number = DEFAULT_MAX_PER_HOUR,
  options: RateLimitOptions = {},
): Promise<void> {
  const storePath = options.storePath ?? DEFAULT_RATE_LIMIT_PATH;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const windowStart = nowMs - WINDOW_MS;

  const store = await readStore(storePath);

  // Prune all timestamps outside the rolling window for this action.
  const existing: number[] = (store[actionId] ?? []).filter(
    (ts) => ts > windowStart,
  );

  if (existing.length >= maxPerHour) {
    // oldest timestamp in the current window; adding WINDOW_MS gives the reset time.
    const oldestTs = existing[0]!;
    const resetAt = new Date(oldestTs + WINDOW_MS);
    throw new RateLimitError(actionId, maxPerHour, resetAt);
  }

  // Record this invocation.
  store[actionId] = [...existing, nowMs];

  // Also prune every OTHER action's timestamps to keep the store compact.
  for (const key of Object.keys(store)) {
    if (key !== actionId) {
      const pruned = store[key].filter((ts) => ts > windowStart);
      if (pruned.length === 0) {
        delete store[key];
      } else {
        store[key] = pruned;
      }
    }
  }

  await writeStore(storePath, store);
}
