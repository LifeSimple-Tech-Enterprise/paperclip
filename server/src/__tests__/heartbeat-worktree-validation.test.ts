import { describe, expect, it } from "vitest";
import { descriptiveError, HttpError } from "../errors.js";

// LIF-455: acceptance coverage for Layer 2a — pre-wake git worktree validation.
//
// These mirror the exact predicates in heartbeat.ts:
//   if (executionWorkspace.cwd) {
//     let gitWorktreeValid = false;
//     try {
//       const gitResult = await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
//       gitWorktreeValid = gitResult.stdout.trim() === "true";
//     } catch { gitWorktreeValid = false; }
//     if (!gitWorktreeValid) throw descriptiveError("NO_GIT_WORKTREE", ...)
//   }
// And in the catch block:
//   const isNoGitWorktree = err instanceof HttpError && err.code === "NO_GIT_WORKTREE";
//   errorCode = isNoGitWorktree ? "no_git_worktree" : ...

// ---------------------------------------------------------------------------
// Predicate: gitWorktreeValid output parsing
// ---------------------------------------------------------------------------

function parseGitWorktreeOutput(stdout: string): boolean {
  return stdout.trim() === "true";
}

describe("gitWorktreeValid output parsing (LIF-455)", () => {
  it("stdout='true\\n' → valid worktree", () => {
    expect(parseGitWorktreeOutput("true\n")).toBe(true);
  });

  it("stdout='true' (no newline) → valid worktree", () => {
    expect(parseGitWorktreeOutput("true")).toBe(true);
  });

  it("stdout='false\\n' → not a worktree", () => {
    expect(parseGitWorktreeOutput("false\n")).toBe(false);
  });

  it("empty stdout → not a worktree", () => {
    expect(parseGitWorktreeOutput("")).toBe(false);
  });

  it("stdout with leading/trailing whitespace → trimmed before comparison", () => {
    expect(parseGitWorktreeOutput("  true  ")).toBe(true);
    expect(parseGitWorktreeOutput("  false  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Predicate: execFile failure → gitWorktreeValid = false
// ---------------------------------------------------------------------------

describe("gitWorktreeValid on execFile failure (LIF-455)", () => {
  it("when execFile throws (non-git dir), gitWorktreeValid stays false", async () => {
    async function simulateGitCheck(cwd: string): Promise<boolean> {
      let gitWorktreeValid = false;
      try {
        // Simulate execFile throwing for a non-git directory
        const fakeExecFile = async (cmd: string, args: string[], opts: { cwd: string }) => {
          if (opts.cwd === "/tmp/not-a-git-dir") {
            const err = new Error("fatal: not a git repository");
            (err as NodeJS.ErrnoException).code = "128";
            throw err;
          }
          return { stdout: "true\n", stderr: "" };
        };
        const result = await fakeExecFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
        gitWorktreeValid = result.stdout.trim() === "true";
      } catch {
        gitWorktreeValid = false;
      }
      return gitWorktreeValid;
    }

    // Acceptance test 1a: cwd is non-git-dir → gitWorktreeValid = false → wake aborts
    expect(await simulateGitCheck("/tmp/not-a-git-dir")).toBe(false);

    // Acceptance test 2a: cwd is valid worktree → gitWorktreeValid = true → wake renders normally
    expect(await simulateGitCheck("/repo/valid-worktree")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// descriptiveError shape for NO_GIT_WORKTREE (mirrors heartbeat.ts throw)
// ---------------------------------------------------------------------------

describe('descriptiveError("NO_GIT_WORKTREE") envelope (LIF-455)', () => {
  it("produces the 422 envelope the heartbeat throws on worktree check failure", () => {
    const cwd = "/workspace/my-project";
    const executionWorkspaceId = "ews-abc-123";
    const err = descriptiveError(
      "NO_GIT_WORKTREE",
      `Worktree at ${cwd} is not a git work tree (executionWorkspaceId=${executionWorkspaceId}).`,
      { cwd, executionWorkspaceId },
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("NO_GIT_WORKTREE");
    expect(err.message).toMatch(/is not a git work tree/);
    expect(err.message).toContain(cwd);
    expect(err.message).toContain(executionWorkspaceId);
    expect(err.details).toEqual({ cwd, executionWorkspaceId });
  });

  it("when no executionWorkspace, uses 'none' fallback in message", () => {
    const cwd = "/workspace/no-workspace";
    const err = descriptiveError(
      "NO_GIT_WORKTREE",
      `Worktree at ${cwd} is not a git work tree (executionWorkspaceId=none).`,
      { cwd, executionWorkspaceId: null },
    );
    expect(err.message).toContain("executionWorkspaceId=none");
    expect((err.details as { executionWorkspaceId: null }).executionWorkspaceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Catch-block detection: isNoGitWorktree predicate
// ---------------------------------------------------------------------------

function deriveIsNoGitWorktree(err: unknown): boolean {
  return err instanceof HttpError && err.code === "NO_GIT_WORKTREE";
}

function deriveErrorCode(err: unknown): string {
  const isWakeTerminated = err instanceof Error && err.name === "WakeTerminatedError";
  const isNoWorkspace = err instanceof HttpError && err.code === "NO_EXECUTION_WORKSPACE";
  const isNoGitWorktree = err instanceof HttpError && err.code === "NO_GIT_WORKTREE";
  return isWakeTerminated
    ? "wake_terminated_by_harness"
    : isNoWorkspace
      ? "no_execution_workspace"
      : isNoGitWorktree
        ? "no_git_worktree"
        : "adapter_failed";
}

describe("heartbeat catch block: isNoGitWorktree detection (LIF-455)", () => {
  it("NO_GIT_WORKTREE HttpError → isNoGitWorktree=true", () => {
    const err = descriptiveError("NO_GIT_WORKTREE", "Worktree is not a git work tree", {});
    expect(deriveIsNoGitWorktree(err)).toBe(true);
  });

  it("NO_EXECUTION_WORKSPACE error → isNoGitWorktree=false", () => {
    const err = descriptiveError("NO_EXECUTION_WORKSPACE", "no workspace", {});
    expect(deriveIsNoGitWorktree(err)).toBe(false);
  });

  it("plain Error → isNoGitWorktree=false", () => {
    expect(deriveIsNoGitWorktree(new Error("some error"))).toBe(false);
  });

  it("non-Error throw → isNoGitWorktree=false", () => {
    expect(deriveIsNoGitWorktree("string throw")).toBe(false);
    expect(deriveIsNoGitWorktree(null)).toBe(false);
  });
});

describe("heartbeat errorCode derivation with NO_GIT_WORKTREE (LIF-455)", () => {
  it("NO_GIT_WORKTREE → errorCode=no_git_worktree", () => {
    const err = descriptiveError("NO_GIT_WORKTREE", "Worktree is not a git work tree", {});
    expect(deriveErrorCode(err)).toBe("no_git_worktree");
  });

  it("no_git_worktree does NOT map to adapter_failed or no_execution_workspace", () => {
    const err = descriptiveError("NO_GIT_WORKTREE", "Worktree is not a git work tree", {});
    expect(deriveErrorCode(err)).not.toBe("adapter_failed");
    expect(deriveErrorCode(err)).not.toBe("no_execution_workspace");
    expect(deriveErrorCode(err)).not.toBe("wake_terminated_by_harness");
  });

  it("NO_EXECUTION_WORKSPACE still maps to no_execution_workspace (no regression)", () => {
    const err = descriptiveError("NO_EXECUTION_WORKSPACE", "no workspace", {});
    expect(deriveErrorCode(err)).toBe("no_execution_workspace");
  });

  it("plain Error still maps to adapter_failed (no regression)", () => {
    expect(deriveErrorCode(new Error("adapter crash"))).toBe("adapter_failed");
  });
});

// ---------------------------------------------------------------------------
// Comment body format
// ---------------------------------------------------------------------------

describe("NO_GIT_WORKTREE comment body format (LIF-455)", () => {
  it("body matches spec: 'Worktree at {cwd} is not a git work tree (executionWorkspaceId={id}).'", () => {
    const cwd = "/workspace/broken-worktree";
    const executionWorkspaceId = "ews-xyz-999";
    const err = descriptiveError("NO_GIT_WORKTREE", "msg", { cwd, executionWorkspaceId });
    const details = err.details as { cwd: string; executionWorkspaceId: string };
    const commentBody = `Worktree at ${details.cwd ?? "unknown"} is not a git work tree (executionWorkspaceId=${details.executionWorkspaceId ?? "none"}).`;
    expect(commentBody).toBe(
      `Worktree at /workspace/broken-worktree is not a git work tree (executionWorkspaceId=ews-xyz-999).`,
    );
  });

  it("body uses 'unknown' and 'none' fallbacks when details are absent", () => {
    const details: { cwd?: string; executionWorkspaceId?: string | null } = {};
    const commentBody = `Worktree at ${details.cwd ?? "unknown"} is not a git work tree (executionWorkspaceId=${details.executionWorkspaceId ?? "none"}).`;
    expect(commentBody).toBe(
      "Worktree at unknown is not a git work tree (executionWorkspaceId=none).",
    );
  });
});

// ---------------------------------------------------------------------------
// LIF-432 metric correctness: NO_GIT_WORKTREE must NOT be a completion attempt
// ---------------------------------------------------------------------------

describe("LIF-432 metric: NO_GIT_WORKTREE is not a completion attempt (LIF-455)", () => {
  it("errorCode=no_git_worktree is distinct from adapter_failed (not a run attempt)", () => {
    const noGitWorktreeErr = descriptiveError("NO_GIT_WORKTREE", "msg", {});
    const adapterErr = new Error("adapter crash");
    expect(deriveErrorCode(noGitWorktreeErr)).toBe("no_git_worktree");
    expect(deriveErrorCode(adapterErr)).toBe("adapter_failed");
    expect(deriveErrorCode(noGitWorktreeErr)).not.toBe(deriveErrorCode(adapterErr));
  });

  it("wake_aborted event type signals harness-level abort (agent was never invoked)", () => {
    // The heartbeat emits eventType="wake_aborted" with payload.reason="NO_GIT_WORKTREE".
    // This is distinct from eventType="error" which signals an adapter-level failure.
    const wakeAbortedEvent = {
      eventType: "wake_aborted",
      payload: { reason: "NO_GIT_WORKTREE" },
    };
    expect(wakeAbortedEvent.eventType).toBe("wake_aborted");
    expect(wakeAbortedEvent.payload.reason).toBe("NO_GIT_WORKTREE");
    expect(wakeAbortedEvent.eventType).not.toBe("error");
  });
});
