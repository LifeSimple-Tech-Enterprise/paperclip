/**
 * Integration test for the C5 failure-handling chain (LIF-243 §C5, §1.4).
 *
 * Wires the executor with a real shell stub (`__fixtures__/fake-sudo.sh`)
 * standing in for sudo. The stub's first wrapper-argv arg is interpreted as
 * the desired exit code, so we drive a `wrapper_nonzero` path end-to-end and
 * assert all four C5 obligations:
 *   1. journal record present with exitCode=7
 *   2. PATCH /api/issues/<id> with {status:"blocked"}
 *   3. POST /api/issues/<id>/comments with formatExecutionResultComment body
 *   4. (notify) — covered by notify.test.ts; here we just assert no throw
 *
 * The stub is wired via `ctx.sudoPath`. The Paperclip API is mocked via
 * `ctx.fetchImpl`. Executor's argv contract (array, not shell string) is
 * preserved end-to-end because the stub's argv[0] doubles as the exit code.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntentSuccess } from "@paperclipai/hermes-agent/intent";
// @ts-expect-error -- modules not yet implemented
import { executeIntent } from "./executor.js";
// @ts-expect-error -- module not yet implemented
import { handleExecutionFailure } from "./failure-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SUDO = resolve(__dirname, "__fixtures__/fake-sudo.sh");

function intent(actionId: string, args: Record<string, string>): IntentSuccess {
  return {
    ok: true,
    intent: {
      action_id: actionId,
      args,
      confidence: 1,
      requires_approval: false,
      rationale: "test",
    },
    requiresApproval: false,
  } as IntentSuccess;
}

let tmp: string;
let journalPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hermes-failure-"));
  journalPath = join(tmp, "journal.log");
  if (existsSync(FAKE_SUDO)) chmodSync(FAKE_SUDO, 0o755);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("failure-handler — wrapper_nonzero end-to-end", () => {
  it("journals exit 7 AND patches issue blocked AND posts audit comment", async () => {
    // Executor runs via the fake-sudo stub. The stub's first wrapper-argv
    // arg is the desired exit code, so the cleanest action is `pm2_restart`
    // with a numeric `name`. The FROZEN registry's argsSchema for `name` is
    // /^[A-Za-z0-9_.-]+$/, which accepts a pure-digit string of length 1.
    // Drafter's argv is `[args.name]`, so fake-sudo sees `<wrapper> <name>`,
    // shifts off the wrapper, and exits with the numeric name.
    const issueId = "issue-1";
    const result = await executeIntent(
      intent("pm2_restart", { name: "7" }),
      {
        issueId,
        isApproved: () => true,
        journalPath,
        sudoPath: FAKE_SUDO,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("wrapper_nonzero");
    expect(result.exitCode).toBe(7);
    expect(typeof result.journalSeq).toBe("number");

    // (1) journal record present with exitCode=7
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.exitCode).toBe(7);
    expect(rec.actionId).toBe("pm2_restart");
    expect(rec.issueId).toBe(issueId);

    // (2) + (3) handleExecutionFailure → PATCH + POST comment
    const fetchImpl = vi.fn(async (url: string) => {
      return new Response("{}", { status: 200 });
    }) as any;
    await handleExecutionFailure(
      { issueId, actionId: "pm2_restart", result },
      {
        paperclipApiUrl: "http://api.test",
        paperclipApiKey: "k",
        runId: "run-1",
        fetchImpl,
      },
    );

    const calls = fetchImpl.mock.calls.map(
      ([url, init]: [string, RequestInit | undefined]) => ({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      }),
    );

    const patch = calls.find(
      (c: { url: string; method: string }) =>
        c.method === "PATCH" && c.url.endsWith(`/api/issues/${issueId}`),
    );
    expect(patch, "expected PATCH /api/issues/<id>").toBeDefined();
    expect(patch.body).toBeDefined();
    expect(JSON.parse(patch.body!)).toMatchObject({ status: "blocked" });

    const comment = calls.find(
      (c: { url: string; method: string }) =>
        c.method === "POST" &&
        c.url.endsWith(`/api/issues/${issueId}/comments`),
    );
    expect(comment, "expected POST /api/issues/<id>/comments").toBeDefined();
    // The comment body should contain the audit formatter output, which
    // includes the actionId and exit_code per audit.ts §formatExecutionResultComment.
    expect(comment.body).toBeDefined();
    expect(comment.body!).toContain("pm2_restart");
    expect(comment.body!).toContain("7");
  });
});
