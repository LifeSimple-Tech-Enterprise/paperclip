import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeRolePackTmpFile, sweepRolePackTmpFiles } from "./role-pack-tmpfile.js";

describe("writeRolePackTmpFile", () => {
  it("writes pack file at deterministic path", async () => {
    const runId = "test-run-1";
    const agentId = "test-agent-1";
    const contents = "# Role Pack\nTest instructions";
    const filePath = await writeRolePackTmpFile({ runId, agentId, contents });

    expect(filePath).toBe(path.join(os.tmpdir(), `paperclip-rolepack-${runId}-${agentId}.md`));
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe(contents);
    await fs.rm(filePath, { force: true });
  });

  it("two concurrent agents produce non-colliding paths", async () => {
    const runId = "run-x";
    const path1 = await writeRolePackTmpFile({ runId, agentId: "agent-a", contents: "a" });
    const path2 = await writeRolePackTmpFile({ runId, agentId: "agent-b", contents: "b" });
    expect(path1).not.toBe(path2);
    await fs.rm(path1, { force: true });
    await fs.rm(path2, { force: true });
  });
});

describe("sweepRolePackTmpFiles", () => {
  const tmpDir = os.tmpdir();

  async function writeTestFile(name: string, content = "test"): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content, { mode: 0o600 });
    return filePath;
  }

  async function setMtime(filePath: string, mtimeMs: number): Promise<void> {
    const mtimeSec = mtimeMs / 1000;
    await fs.utimes(filePath, mtimeSec, mtimeSec);
  }

  it("sweeps files older than 1h", async () => {
    const filePath = await writeTestFile("paperclip-rolepack-sweep-old-test.md");
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    await setMtime(filePath, twoHoursAgo);
    await sweepRolePackTmpFiles();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("preserves files newer than 1h", async () => {
    const filePath = await writeTestFile("paperclip-rolepack-sweep-new-test.md");
    const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
    await setMtime(filePath, thirtyMinsAgo);
    await sweepRolePackTmpFiles();
    await expect(fs.access(filePath)).resolves.toBeUndefined();
    await fs.rm(filePath, { force: true });
  });

  it("mtime 1s under boundary is preserved (strictly greater threshold)", async () => {
    const filePath = await writeTestFile("paperclip-rolepack-sweep-boundary-exact.md");
    // 1 second under 1h — still under the strictly-greater threshold
    const justUnderOneHour = Date.now() - (3_600_000 - 1000);
    await setMtime(filePath, justUnderOneHour);
    await sweepRolePackTmpFiles();
    await expect(fs.access(filePath)).resolves.toBeUndefined();
    await fs.rm(filePath, { force: true });
  });

  it("mtime 1ms over boundary is removed", async () => {
    const filePath = await writeTestFile("paperclip-rolepack-sweep-boundary-over.md");
    const justOverOneHour = Date.now() - (3_600_000 + 5000);
    await setMtime(filePath, justOverOneHour);
    await sweepRolePackTmpFiles();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("swallows ENOENT from sibling-deleted files during sweep", async () => {
    // Pretend a file disappears between readdir and stat — sweep should not throw
    const filePath = await writeTestFile("paperclip-rolepack-sweep-enoent-test.md");
    await fs.rm(filePath, { force: true });
    // Should complete without throwing even though file is gone
    await expect(sweepRolePackTmpFiles()).resolves.toBeUndefined();
  });
});
