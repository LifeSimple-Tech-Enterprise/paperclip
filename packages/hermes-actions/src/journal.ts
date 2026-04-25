/**
 * HermesAgent V1 hash-chained execution journal — Stage C4 (LIF-248).
 *
 * One NDJSON record per line. Each record is self-describing and integrity-
 * protected: `hash` covers the record's own fields, and `prevHash` chains it
 * to the preceding record. Any tampering of a single record is detectable by
 * `verifyJournal`.
 *
 * Locking strategy (justified here per plan requirement):
 *   The design assumption is "one HermesAgent process at a time per host".
 *   `proper-lockfile` (sidecar .lock file) is the recommended pure-JS option,
 *   but it is not yet in the workspace dependency graph. Instead we implement
 *   an in-process append queue (a serialised Promise chain). Two concurrent
 *   `append` calls on the SAME `JournalHandle` are serialised; two separate
 *   processes opening the SAME file would race, but the single-process
 *   assumption makes that a non-issue for V1. The queue gives the same
 *   sequential-write guarantee within a process without an OS lock syscall or
 *   a sidecar file dependency. This is the right trade-off for V1; Stage E
 *   can replace with flock or proper-lockfile if multi-process access is added.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JournalRecord {
  seq: number;
  /** ISO-8601 UTC, millisecond precision. */
  ts: string;
  issueId: string;
  actionId: string;
  /** POST-schema-parse args (NOT raw model output). */
  args: Record<string, unknown>;
  /** "sha256:<hex>" of canonicalJson(args). */
  argsHash: string;
  exitCode: number;
  durationMs: number;
  /** "sha256:<hex>"; "sha256:" + "0".repeat(64) for seq=1. */
  prevHash: string;
  /** "sha256:<hex>"; computed over canonicalJson({...record, hash:undefined}). */
  hash: string;
}

export interface JournalAppendInput {
  ts: Date;
  issueId: string;
  actionId: string;
  args: Record<string, unknown>;
  exitCode: number;
  durationMs: number;
}

export interface JournalHandle {
  /** Append one record under an in-process serial queue. Returns the assigned seq. */
  append(input: JournalAppendInput): Promise<number>;
}

export interface VerifyResultOk {
  ok: true;
  lastSeq: number;
}

export interface VerifyResultBad {
  ok: false;
  brokenAt: number;
  reason: string;
}

export type VerifyResult = VerifyResultOk | VerifyResultBad;

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys, recursive, no whitespace)
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const pairs = sorted.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return "{" + pairs.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

const ZERO_HASH = "sha256:" + "0".repeat(64);

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function computeHash(recordWithoutHash: Omit<JournalRecord, "hash">): string {
  return "sha256:" + sha256hex(canonicalJson(recordWithoutHash));
}

function computeArgsHash(args: Record<string, unknown>): string {
  return "sha256:" + sha256hex(canonicalJson(args));
}

// ---------------------------------------------------------------------------
// Read the last record of an existing file (for tail recovery)
// ---------------------------------------------------------------------------

async function readLastRecord(
  filePath: string,
): Promise<JournalRecord | null> {
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const trimmed = content.trimEnd();
  if (!trimmed) return null;

  const lastLine = trimmed.split("\n").at(-1) ?? "";
  try {
    return JSON.parse(lastLine) as JournalRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// openJournal
// ---------------------------------------------------------------------------

/** Default production journal path. */
const DEFAULT_JOURNAL_PATH = "/var/log/hermes/journal.log";

/**
 * Open (and recover the tail of) a journal. Default path is
 * `/var/log/hermes/journal.log`. Creates the directory and file if absent.
 */
export async function openJournal(filePath?: string): Promise<JournalHandle> {
  const resolvedPath = filePath ?? DEFAULT_JOURNAL_PATH;

  // Ensure the directory exists.
  await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });

  // Recover state from last record.
  const lastRecord = await readLastRecord(resolvedPath);
  let nextSeq = lastRecord ? lastRecord.seq + 1 : 1;
  let prevHash = lastRecord ? lastRecord.hash : ZERO_HASH;

  // In-process serial queue: each append chains onto the previous Promise.
  let queue: Promise<number> = Promise.resolve(0);

  const handle: JournalHandle = {
    append(input: JournalAppendInput): Promise<number> {
      const result = queue.then(async (): Promise<number> => {
        const seq = nextSeq;
        const currentPrevHash = prevHash;

        const argsHash = computeArgsHash(input.args);

        const recordWithoutHash: Omit<JournalRecord, "hash"> = {
          seq,
          ts: input.ts.toISOString(),
          issueId: input.issueId,
          actionId: input.actionId,
          args: input.args,
          argsHash,
          exitCode: input.exitCode,
          durationMs: input.durationMs,
          prevHash: currentPrevHash,
        };

        const hash = computeHash(recordWithoutHash);
        const record: JournalRecord = { ...recordWithoutHash, hash };

        const line = canonicalJson(record) + "\n";

        // Synchronous append under a simple write — safe within one process's
        // serial queue. O_APPEND is atomic at the kernel level for small writes.
        const fd = fs.openSync(resolvedPath, "a");
        try {
          const buf = Buffer.from(line, "utf8");
          let written = 0;
          while (written < buf.byteLength) {
            written += fs.writeSync(fd, buf, written, buf.byteLength - written);
          }
        } finally {
          fs.closeSync(fd);
        }

        // Advance state for the next record.
        nextSeq = seq + 1;
        prevHash = hash;

        return seq;
      });

      // Chain: next append waits for this one, ignoring the number it returned.
      queue = result.then(
        () => 0,
        () => 0,
      );

      return result;
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// verifyJournal
// ---------------------------------------------------------------------------

/**
 * Walk the journal file line-by-line, recomputing each record's hash and
 * verifying the `prevHash` chain. Fails fast on the first mismatch.
 */
export async function verifyJournal(filePath?: string): Promise<VerifyResult> {
  const resolvedPath = filePath ?? DEFAULT_JOURNAL_PATH;

  let content: string;
  try {
    content = await fsPromises.readFile(resolvedPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, lastSeq: 0 };
    }
    throw err;
  }

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return { ok: true, lastSeq: 0 };

  let expectedPrevHash = ZERO_HASH;
  let lastSeq = 0;

  for (const line of lines) {
    let record: JournalRecord;
    try {
      record = JSON.parse(line) as JournalRecord;
    } catch {
      return {
        ok: false,
        brokenAt: lastSeq + 1,
        reason: `Line ${lastSeq + 1} is not valid JSON.`,
      };
    }

    // Verify prevHash chain.
    if (record.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        brokenAt: record.seq,
        reason:
          `Record seq=${record.seq}: expected prevHash="${expectedPrevHash}", ` +
          `got "${record.prevHash}".`,
      };
    }

    // Recompute hash over all fields except `hash` itself.
    const { hash: storedHash, ...rest } = record;
    const expectedHash = computeHash(rest);
    if (storedHash !== expectedHash) {
      return {
        ok: false,
        brokenAt: record.seq,
        reason:
          `Record seq=${record.seq}: hash mismatch. ` +
          `Expected "${expectedHash}", got "${storedHash}".`,
      };
    }

    expectedPrevHash = storedHash;
    lastSeq = record.seq;
  }

  return { ok: true, lastSeq };
}
