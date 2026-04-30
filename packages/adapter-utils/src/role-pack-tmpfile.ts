import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function rolePackTmpFilePath(runId: string, agentId: string): string {
  return path.join(os.tmpdir(), `paperclip-rolepack-${runId}-${agentId}.md`);
}

export async function writeRolePackTmpFile({
  runId,
  agentId,
  contents,
}: {
  runId: string;
  agentId: string;
  contents: string;
}): Promise<string> {
  const filePath = rolePackTmpFilePath(runId, agentId);
  await fs.writeFile(filePath, contents, { mode: 0o600 });
  return filePath;
}

export async function sweepRolePackTmpFiles(): Promise<void> {
  const tmpDir = os.tmpdir();
  let names: string[];
  try {
    names = await fs.readdir(tmpDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("paperclip-rolepack-") || !name.endsWith(".md")) continue;
    const filePath = path.join(tmpDir, name);
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (now - stats.mtimeMs > 3_600_000) {
      await fs.rm(filePath, { force: true });
    }
  }
}

export function startRolePackSweepInterval(): ReturnType<typeof setInterval> {
  sweepRolePackTmpFiles().catch(() => undefined);
  const interval = setInterval(sweepRolePackTmpFiles, 6 * 60 * 60 * 1_000);
  interval.unref();
  return interval;
}
