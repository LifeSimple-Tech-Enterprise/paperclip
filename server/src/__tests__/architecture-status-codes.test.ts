import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LIF-375 Stage 3a (LIF-427) — architecture-status-codes regex test.
 *
 * **Rule:** route handlers MUST raise 422 via `descriptiveError(...)` (or other
 * helpers from `errors.ts`). Naked `res.status(422)` calls escape the
 * `errorHandler` 422 envelope (`{error, code, details}`), so agents lose the
 * structured `code` field that powers the infra-error tracker.
 *
 * Allowed exceptions:
 *   - `errorHandler` itself (it serialises HttpError→422 via res.status).
 *   - Tests under `__tests__/` (they assert on res.status calls).
 *
 * AST-based ESLint follow-up tracked under LIF-371. This regex pass covers the
 * Stage-3a deliverable surface without pulling in tsc-eslint.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, "..");

const SCAN_GLOBS = ["routes", "services", "middleware"]; // top-level dirs to scan
const TEST_DIR_NAME = "__tests__";

const PATTERN = /res\s*\.\s*status\s*\(\s*422\s*\)/;

const ALLOWLIST = new Set<string>([
  // The error handler itself emits 422 via res.status — that is the canonical
  // exit point we are protecting.
  "middleware/error-handler.ts",
]);

/**
 * Files that pre-date the rev-26 contract and still emit naked 422s. The AST
 * follow-up under LIF-371 will migrate them; until then this allowlist locks
 * the count so no NEW naked 422s slip in.
 *
 * Each entry pins the exact number of legacy offending lines so a regression
 * (or a successful migration) shows up immediately.
 */
const LEGACY_BASELINE: ReadonlyMap<string, number> = new Map<string, number>([
  ["routes/projects.ts", 9],
  ["routes/issues.ts", 4],
  ["routes/agents.ts", 5],
  ["routes/execution-workspaces.ts", 6],
  ["routes/assets.ts", 8],
]);

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === TEST_DIR_NAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      yield full;
    }
  }
}

async function collectOffenders(): Promise<Array<{ file: string; line: number; snippet: string }>> {
  const offenders: Array<{ file: string; line: number; snippet: string }> = [];
  for (const subdir of SCAN_GLOBS) {
    const root = path.join(SERVER_SRC, subdir);
    for await (const file of walk(root)) {
      const rel = path.relative(SERVER_SRC, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = await readFile(file, "utf-8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (PATTERN.test(line)) {
          offenders.push({ file: rel, line: idx + 1, snippet: line.trim() });
        }
      });
    }
  }
  return offenders;
}

describe("architecture: 422 status codes", () => {
  it("forbids naked res.status(422) calls in stage-3a-migrated files", async () => {
    // Files that were explicitly migrated under LIF-427 (handoffs + the
    // review-request status guard) must stay clean. New naked 422s here are
    // hard regressions.
    const migratedFiles = ["routes/handoffs.ts"];
    const offenders = await collectOffenders();
    const inMigrated = offenders.filter((o) => migratedFiles.includes(o.file));
    if (inMigrated.length > 0) {
      const summary = inMigrated
        .map((o) => `  - ${o.file}:${o.line}\n      ${o.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${inMigrated.length} naked res.status(422) call(s) in migrated files — ` +
          `replace with descriptiveError(code, prompt, details?):\n${summary}`,
      );
    }
    expect(inMigrated).toEqual([]);
  });

  it("locks legacy naked-422 counts (LIF-371 AST follow-up will burn these down)", async () => {
    const offenders = await collectOffenders();
    const counts = new Map<string, number>();
    for (const o of offenders) {
      counts.set(o.file, (counts.get(o.file) ?? 0) + 1);
    }

    const regressions: string[] = [];
    for (const [file, baseline] of LEGACY_BASELINE) {
      const actual = counts.get(file) ?? 0;
      if (actual > baseline) {
        regressions.push(`  - ${file}: baseline=${baseline} actual=${actual} (NEW naked 422 added; migrate to descriptiveError)`);
      }
    }

    // Also flag files that picked up new naked 422s without being in the baseline.
    for (const [file, actual] of counts) {
      if (!LEGACY_BASELINE.has(file)) {
        regressions.push(`  - ${file}: ${actual} naked 422 call(s) — file not in legacy baseline; migrate to descriptiveError`);
      }
    }

    if (regressions.length > 0) {
      throw new Error(`Architecture regression — naked res.status(422) count grew:\n${regressions.join("\n")}`);
    }
    expect(regressions).toEqual([]);
  });
});
