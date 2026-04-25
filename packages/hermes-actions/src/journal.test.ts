/**
 * Failing tests for the hash-chained journal (LIF-243 §C4, LIF-247 TDD).
 *
 * Covers:
 *   - empty file init: seq=1, prevHash all-zeros
 *   - N-record chain integrity via verifyJournal
 *   - tail recovery when reopening an existing file
 *   - tampering detection: corrupting a byte breaks the chain
 *   - concurrent appends serialise (parallel append → seq=1, seq=2)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error -- module not yet implemented
import { openJournal, verifyJournal } from "./journal.js";

const ZERO_HASH = "sha256:" + "0".repeat(64);

let tmp: string;
let path: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hermes-journal-"));
  path = join(tmp, "journal.log");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function appendInput(overrides: Record<string, unknown> = {}) {
  return {
    ts: new Date("2026-04-25T07:00:00.000Z"),
    issueId: "issue-1",
    actionId: "pm2_restart",
    args: { name: "paperclip" },
    exitCode: 0,
    durationMs: 12,
    ...overrides,
  };
}

describe("journal — empty file init", () => {
  it("first append is seq=1 with all-zeros prevHash", async () => {
    const h = await openJournal(path);
    const seq = await h.append(appendInput());
    expect(seq).toBe(1);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.seq).toBe(1);
    expect(rec.prevHash).toBe(ZERO_HASH);
    expect(rec.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rec.argsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("journal — N-record chain", () => {
  it("5 records chain cleanly; verifyJournal returns ok=true lastSeq=5", async () => {
    const h = await openJournal(path);
    for (let i = 0; i < 5; i++) {
      await h.append(appendInput({ args: { name: `proc-${i}` } }));
    }
    const v = await verifyJournal(path);
    expect(v.ok).toBe(true);
    expect((v as { ok: true; lastSeq: number }).lastSeq).toBe(5);
  });
});

describe("journal — tail recovery", () => {
  it("reopen continues from last seq + last hash", async () => {
    let h = await openJournal(path);
    await h.append(appendInput());
    await h.append(appendInput());
    await h.append(appendInput());

    h = await openJournal(path); // reopen
    const seq = await h.append(appendInput());
    expect(seq).toBe(4);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const rec3 = JSON.parse(lines[2]);
    const rec4 = JSON.parse(lines[3]);
    expect(rec4.prevHash).toBe(rec3.hash);

    const v = await verifyJournal(path);
    expect(v.ok).toBe(true);
  });
});

describe("journal — tampering detection", () => {
  it("corrupting one byte of record 2 trips the verifier with brokenAt=2", async () => {
    const h = await openJournal(path);
    await h.append(appendInput({ args: { name: "alpha" } }));
    await h.append(appendInput({ args: { name: "bravo" } }));
    await h.append(appendInput({ args: { name: "charlie" } }));

    const raw = readFileSync(path, "utf8");
    // Tamper with a stable substring of record 2's args.
    const tampered = raw.replace("bravo", "BRAVO");
    expect(tampered).not.toBe(raw);
    writeFileSync(path, tampered);

    const v = await verifyJournal(path);
    expect(v.ok).toBe(false);
    expect((v as { ok: false; brokenAt: number }).brokenAt).toBe(2);
  });
});

describe("journal — concurrent appends serialise", () => {
  it("parallel append() calls produce seq=1 and seq=2 with no chain break", async () => {
    const h = await openJournal(path);
    const results = await Promise.all([
      h.append(appendInput({ args: { name: "alpha" } })),
      h.append(appendInput({ args: { name: "bravo" } })),
    ]);
    expect(results.sort((a: number, b: number) => a - b)).toEqual([1, 2]);

    const v = await verifyJournal(path);
    expect(v.ok).toBe(true);
    expect((v as { ok: true; lastSeq: number }).lastSeq).toBe(2);
  });
});
