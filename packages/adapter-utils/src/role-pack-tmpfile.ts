import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MTIME_THRESHOLD_MS = 3_600_000;

function rolePackTmpPath(runId: string, agentId: string): string {
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
  const filePath = rolePackTmpPath(runId, agentId);
  await fs.writeFile(filePath, contents, { mode: 0o600 });
  return filePath;
}

export async function sweepRolePackTmpFiles(): Promise<void> {
  const tmpDir = os.tmpdir();
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(tmpDir);
    entries = dirEntries.filter((name) => name.startsWith("paperclip-rolepack-") && name.endsWith(".md"));
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries.map(async (name) => {
      const filePath = path.join(tmpDir, name);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > MTIME_THRESHOLD_MS) {
          await fs.rm(filePath, { force: true });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // swallow ENOENT, rethrow nothing else either (sweep is best-effort)
        }
      }
    }),
  );
}

export function startRolePackSweepInterval(): ReturnType<typeof setInterval> {
  void sweepRolePackTmpFiles();
  const interval = setInterval(sweepRolePackTmpFiles, SWEEP_INTERVAL_MS);
  interval.unref();
  return interval;
}
