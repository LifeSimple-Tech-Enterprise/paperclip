import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rolePackTmpFilePath,
  writeRolePackTmpFile,
  sweepRolePackTmpFiles,
} from "./role-pack-tmpfile.js";

const TEST_RUN_ID = "run-test-aabbcc";
const TEST_AGENT_ID = "agent-test-ddeeff";

describe("rolePackTmpFilePath", () => {
  it("produces deterministic path under os.tmpdir()", () => {
    const p = rolePackTmpFilePath("run-1", "agent-2");
    expect(p).toBe(path.join(os.tmpdir(), "paperclip-rolepack-run-1-agent-2.md"));
  });

  it("two concurrent agents produce non-colliding paths", () => {
    const p1 = rolePackTmpFilePath("run-x", "agent-1");
    const p2 = rolePackTmpFilePath("run-x", "agent-2");
    expect(p1).not.toBe(p2);
  });
});

describe("writeRolePackTmpFile", () => {
  const writtenPaths: string[] = [];

  afterEach(async () => {
    for (const p of writtenPaths.splice(0)) {
      await fs.rm(p, { force: true });
    }
  });

  it("writes pack file at deterministic path", async () => {
    const filePath = await writeRolePackTmpFile({
      runId: TEST_RUN_ID,
      agentId: TEST_AGENT_ID,
      contents: "# Role Pack\n\nHello.",
    });
    writtenPaths.push(filePath);

    expect(filePath).toBe(rolePackTmpFilePath(TEST_RUN_ID, TEST_AGENT_ID));
    const data = await fs.readFile(filePath, "utf-8");
    expect(data).toBe("# Role Pack\n\nHello.");
  });
});

describe("sweepRolePackTmpFiles", () => {
  const writtenPaths: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const p of writtenPaths.splice(0)) {
      await fs.rm(p, { force: true });
    }
  });

  async function writeTmpFile(name: string, contents = "pack"): Promise<string> {
    const p = path.join(os.tmpdir(), name);
    await fs.writeFile(p, contents, { mode: 0o600 });
    writtenPaths.push(p);
    return p;
  }

  it("sweeps files older than 1h", async () => {
    const fixedNow = 1_700_000_000_000;
    vi.setSystemTime(fixedNow);

    const filePath = await writeTmpFile("paperclip-rolepack-old-run-agent.md");
    // Set mtime to 2h before fixedNow
    const oldDate = new Date(fixedNow - 2 * 3_600_000);
    await fs.utimes(filePath, oldDate, oldDate);

    await sweepRolePackTmpFiles();

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("preserves files newer than 1h", async () => {
    const fixedNow = 1_700_000_000_000;
    vi.setSystemTime(fixedNow);

    const filePath = await writeTmpFile("paperclip-rolepack-new-run-agent.md");
    // Set mtime to 30 min before fixedNow
    const recentDate = new Date(fixedNow - 30 * 60 * 1_000);
    await fs.utimes(filePath, recentDate, recentDate);

    await sweepRolePackTmpFiles();

    const data = await fs.readFile(filePath, "utf-8");
    expect(data).toBe("pack");
  });

  it("mtime boundary at exactly 1h is preserved (> not >=)", async () => {
    const fixedNow = 1_700_000_000_000;
    vi.setSystemTime(fixedNow);

    const keepPath = await writeTmpFile("paperclip-rolepack-boundary-keep-agent.md");
    const removePath = await writeTmpFile("paperclip-rolepack-boundary-remove-agent.md");

    // Exactly 1h old → kept (threshold is strictly >)
    const exactlyOneHour = new Date(fixedNow - 3_600_000);
    await fs.utimes(keepPath, exactlyOneHour, exactlyOneHour);

    // Slightly over 1h old → removed (but fs has 1s precision; use 2s over to be safe)
    const slightlyOver = new Date(fixedNow - 3_602_000);
    await fs.utimes(removePath, slightlyOver, slightlyOver);

    await sweepRolePackTmpFiles();

    const data = await fs.readFile(keepPath, "utf-8");
    expect(data).toBe("pack");
    await expect(fs.access(removePath)).rejects.toThrow();
  });

  it("swallows ENOENT from sibling-deleted files during sweep", async () => {
    // Write then immediately delete — sweep should not throw
    const filePath = await writeTmpFile("paperclip-rolepack-gone-run-agent.md");
    const oldDate = new Date(Date.now() - 2 * 3_600_000);
    await fs.utimes(filePath, oldDate, oldDate);
    await fs.rm(filePath, { force: true });

    await expect(sweepRolePackTmpFiles()).resolves.not.toThrow();
  });

  it("does not remove non-matching files in tmpdir", async () => {
    const fixedNow = 1_700_000_000_000;
    vi.setSystemTime(fixedNow);

    const otherFile = await writeTmpFile("other-file-not-rolepack.md");
    const oldDate = new Date(fixedNow - 2 * 3_600_000);
    await fs.utimes(otherFile, oldDate, oldDate);

    await sweepRolePackTmpFiles();

    // File should still exist
    const data = await fs.readFile(otherFile, "utf-8");
    expect(data).toBe("pack");
  });
});
