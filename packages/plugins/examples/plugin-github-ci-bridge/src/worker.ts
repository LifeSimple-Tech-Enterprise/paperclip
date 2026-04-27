/**
 * github-ci-bridge plugin — RED-phase stubs (LIF-343).
 *
 * Every exported function throws `not implemented`. The unit tests in
 * `tests/` import these symbols and assert the contract. Drafter
 * (LIF-340 / LIF-341 / LIF-342) replaces each stub with the real
 * implementation, driving the test suite green ticket by ticket.
 *
 * Do not import the host SDK's `definePlugin` here yet — the wiring
 * happens in LIF-340 once the worker contract is implemented.
 */

const NOT_IMPL = "not implemented (LIF-340/341/342 owns this)";

/** §3 — HMAC-SHA256 verifier. */
export interface HmacVerifyResult {
  ok: boolean;
  reason?: "invalid_signature" | "replay" | "missing_header";
}

export function verifyHmac(
  _rawBody: string,
  _signatureHeader: string | null,
  _timestampHeader: string | null,
  _secrets: readonly string[],
): HmacVerifyResult {
  throw new Error(NOT_IMPL);
}

/** §4 — Issue resolver. */
export interface ResolveIssueResult {
  issueId: string | null;
  unresolved?: boolean;
  reason?: "no_branch" | "no_workspace_match" | "no_regex_match" | "regex_no_issue";
}

export interface ResolveIssueDeps {
  /** Returns the `source_issue_id` for `(branch_name, repo_full_name)` or null. */
  findExecutionWorkspace(
    branchName: string,
    repoFullName: string,
  ): Promise<string | null>;
  /** Returns the issue UUID for a given identifier (e.g. "LIF-200") or null. */
  findIssueByIdentifier(identifier: string): Promise<string | null>;
}

export async function resolveIssue(
  _payload: unknown,
  _deps: ResolveIssueDeps,
): Promise<ResolveIssueResult> {
  throw new Error(NOT_IMPL);
}

/** §5/§6 — Reaction policy + idempotency. */
export type CiConclusion = "success" | "failure" | "cancelled" | "timed_out" | "neutral" | "skipped" | "action_required";
export type AgentExecutionState = "idle" | "active";
export type IssueLifecycleStatus = "in_progress" | "blocked" | "done" | "cancelled" | "backlog" | "in_review";

export interface ReactToEventInput {
  issueId: string;
  issueStatus: IssueLifecycleStatus;
  unblockCondition?: string | null;
  conclusion: CiConclusion;
  agentState: AgentExecutionState;
  runId: string | number;
  runAttempt: number;
  runUrl: string;
  branch: string;
  prNumber?: number | null;
  failedJobs?: ReadonlyArray<{ name: string; html_url?: string }>;
  assigneeAgentId: string | null;
}

export interface ReactCtx {
  comments: { create(input: { issueId: string; body: string }): Promise<void> };
  agents: {
    wake(input: {
      agentId: string;
      reason: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): Promise<void>;
  };
  issues: {
    patch(input: { issueId: string; status?: IssueLifecycleStatus }): Promise<void>;
  };
  scratchpad: {
    append(input: {
      agentId: string;
      key: "pendingCiEvents";
      idempotencyKey: string;
      entry: Record<string, unknown>;
    }): Promise<void>;
  };
}

export async function reactToEvent(
  _input: ReactToEventInput,
  _ctx: ReactCtx,
): Promise<void> {
  throw new Error(NOT_IMPL);
}
