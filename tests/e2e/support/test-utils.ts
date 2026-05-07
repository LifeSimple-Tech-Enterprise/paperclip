/**
 * Test utility module for LIF-31 recovery-behaviour BDD suite.
 *
 * Covers three features:
 *   @feature-recovery-watchdog      — recovery-watchdog-plugin cron job
 *   @feature-heartbeat-silent-cap   — HEARTBEAT_APPENDIX §2 keep-alive
 *   @feature-plan-in-review         — HEARTBEAT_APPENDIX §3 plan frontmatter
 *
 * Required env vars:
 *   TEST_COMPANY_ID      — UUID of the test company (bootstrapped by global-setup.ts)
 *   PAPERCLIP_E2E_PORT   — Port the local Paperclip instance listens on (default: 3199)
 *   WATCHDOG_PLUGIN_PATH — Absolute path to packages/plugins/recovery-watchdog-plugin
 *                          (default: derived from cwd)
 *
 * Seeding stale heartbeat_runs (needed for @feature-recovery-watchdog):
 *   seedStaleHeartbeatRun() is a contract placeholder. It calls
 *   POST /api/test/seed-stale-heartbeat-run which Lead Engineer must add
 *   (tracked in LIF-44). Until then, calling this function throws.
 *
 * Agent heartbeat simulation (needed for @feature-heartbeat-silent-cap and
 *   @feature-plan-in-review):
 *   simulateSilentHeartbeat() and simulatePlanInReviewHeartbeat() act AS the
 *   agent by directly making the API calls the agent would make. This tests
 *   the API contract rather than LLM decision-making.
 */

import path from "node:path";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
export const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

const WATCHDOG_PLUGIN_ID = "recovery-watchdog";
const WATCHDOG_JOB_KEY = "check-stale-blocked-parents";

const WATCHDOG_PLUGIN_PATH =
  process.env.WATCHDOG_PLUGIN_PATH ??
  path.resolve(process.cwd(), "packages/plugins/recovery-watchdog-plugin");

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiPost(apiPath: string, body: unknown): Promise<Response> {
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${apiPath} failed ${res.status}: ${text}`);
  }
  return res;
}

async function apiPatch(apiPath: string, body: unknown): Promise<Response> {
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${apiPath} failed ${res.status}: ${text}`);
  }
  return res;
}

async function apiPut(apiPath: string, body: unknown): Promise<Response> {
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${apiPath} failed ${res.status}: ${text}`);
  }
  return res;
}

async function apiGet(apiPath: string): Promise<Response> {
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${apiPath} failed ${res.status}: ${text}`);
  }
  return res;
}

// ── Test company ──────────────────────────────────────────────────────────────

export function getTestCompanyId(): string {
  const id = process.env.TEST_COMPANY_ID;
  if (!id) {
    throw new Error(
      "TEST_COMPANY_ID is not set. Ensure global-setup.ts ran via BeforeAll or " +
        "set TEST_COMPANY_ID manually.",
    );
  }
  return id;
}

// ── Agents ────────────────────────────────────────────────────────────────────

export async function listAgents(companyId: string): Promise<AgentRef[]> {
  const res = await apiGet(`/api/companies/${companyId}/agents`);
  return (await res.json()) as AgentRef[];
}

// ── Issue CRUD ────────────────────────────────────────────────────────────────

export interface IssueRef {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

export interface IssueDetail extends IssueRef {
  companyId: string;
  assigneeAgentId: string | null;
  blockedByIssueIds?: string[];
  blockedBy?: Array<{ id: string }>;
  lastActivityAt?: string | null;
  originKind?: string | null;
  originId?: string | null;
}

export interface AgentRef {
  id: string;
  urlKey: string;
  role: string;
}

export async function createIssue(
  companyId: string,
  opts: {
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
    blockedByIssueIds?: string[];
    priority?: string;
  },
): Promise<IssueDetail> {
  const res = await apiPost(`/api/companies/${companyId}/issues`, {
    title: opts.title,
    status: opts.status ?? "todo",
    assigneeAgentId: opts.assigneeAgentId ?? null,
    blockedByIssueIds: opts.blockedByIssueIds ?? [],
    priority: opts.priority ?? "medium",
  });
  return (await res.json()) as IssueDetail;
}

export async function getIssue(issueId: string): Promise<IssueDetail> {
  const res = await apiGet(`/api/issues/${issueId}`);
  return (await res.json()) as IssueDetail;
}

export async function updateIssue(
  issueId: string,
  fields: Partial<{
    status: string;
    assigneeAgentId: string | null;
    blockedByIssueIds: string[];
    comment: string;
  }>,
): Promise<IssueDetail> {
  const res = await apiPatch(`/api/issues/${issueId}`, fields);
  return (await res.json()) as IssueDetail;
}

export async function listIssuesByOriginId(
  companyId: string,
  originId: string,
): Promise<IssueDetail[]> {
  const res = await apiGet(
    `/api/companies/${companyId}/issues?originId=${encodeURIComponent(originId)}`,
  );
  return (await res.json()) as IssueDetail[];
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface IssueComment {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

export async function listIssueComments(issueId: string): Promise<IssueComment[]> {
  const res = await apiGet(`/api/issues/${issueId}/comments`);
  return (await res.json()) as IssueComment[];
}

export async function postIssueComment(issueId: string, body: string): Promise<IssueComment> {
  const res = await apiPost(`/api/issues/${issueId}/comments`, { body });
  return (await res.json()) as IssueComment;
}

// ── Documents ─────────────────────────────────────────────────────────────────

export interface IssueDocument {
  id: string;
  key: string;
  latestRevisionId: string;
  latestRevisionNumber: number;
  body: string | null;
}

export async function upsertIssueDocument(
  issueId: string,
  key: string,
  body: string,
): Promise<IssueDocument> {
  // Fetch existing document to get baseRevisionId (required for updates).
  let baseRevisionId: string | null = null;
  const existing = await apiGet(`/api/issues/${issueId}/documents/${key}`).catch(() => null);
  if (existing) {
    const doc = (await existing.json()) as IssueDocument;
    baseRevisionId = doc.latestRevisionId ?? null;
  }

  const res = await apiPut(`/api/issues/${issueId}/documents/${key}`, {
    format: "markdown",
    body,
    baseRevisionId,
  });
  return (await res.json()) as IssueDocument;
}

export async function getIssueDocument(
  issueId: string,
  key: string,
): Promise<IssueDocument | null> {
  const res = await apiGet(`/api/issues/${issueId}/documents/${key}`).catch(() => null);
  if (!res) return null;
  return (await res.json()) as IssueDocument;
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

export async function installWatchdogPlugin(): Promise<void> {
  await apiPost("/api/plugins/install", {
    packageName: WATCHDOG_PLUGIN_PATH,
    isLocalPath: true,
  }).catch((err) => {
    const msg = String(err);
    if (msg.includes("409") || msg.includes("already installed")) return;
    throw err;
  });
}

export async function enableWatchdogPlugin(): Promise<void> {
  await apiPost(`/api/plugins/${WATCHDOG_PLUGIN_ID}/enable`, undefined).catch((err) => {
    const msg = String(err);
    if (msg.includes("already") || msg.includes("'ready'") || msg.includes("status 'ready'")) return;
    throw err;
  });
  await waitForPluginReady(WATCHDOG_PLUGIN_ID, 20_000);
}

export async function disableWatchdogPlugin(): Promise<void> {
  await apiPost(`/api/plugins/${WATCHDOG_PLUGIN_ID}/disable`, undefined).catch(() => undefined);
}

async function waitForPluginReady(pluginId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/plugins/${pluginId}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === "ready") return;
      }
    } catch {
      // transient; keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `waitForPluginReady: plugin ${pluginId} did not reach "ready" within ${timeoutMs}ms`,
  );
}

// ── Watchdog cron job trigger ─────────────────────────────────────────────────

async function getWatchdogJobId(): Promise<string> {
  const res = await apiGet(`/api/plugins/${WATCHDOG_PLUGIN_ID}/jobs`);
  const jobs = (await res.json()) as Array<{ id: string; key?: string; jobKey?: string }>;
  const job = jobs.find((j) => (j.key ?? j.jobKey) === WATCHDOG_JOB_KEY);
  if (!job) {
    throw new Error(
      `Job '${WATCHDOG_JOB_KEY}' not found in plugin '${WATCHDOG_PLUGIN_ID}'. ` +
        `Available jobs: ${jobs.map((j) => j.key ?? j.jobKey).join(", ")}`,
    );
  }
  return job.id;
}

/**
 * Manually trigger the 'check-stale-blocked-parents' cron job and wait for
 * it to finish before returning.
 */
export async function triggerWatchdogCronJobAndWait(): Promise<void> {
  const jobId = await getWatchdogJobId();
  const res = await apiPost(
    `/api/plugins/${WATCHDOG_PLUGIN_ID}/jobs/${jobId}/trigger`,
    undefined,
  );
  const { runId } = (await res.json()) as { runId: string; jobId: string };

  // Poll for job run completion.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runsRes = await apiGet(
      `/api/plugins/${WATCHDOG_PLUGIN_ID}/jobs/${jobId}/runs`,
    );
    const runs = (await runsRes.json()) as Array<{ id: string; status: string }>;
    const run = runs.find((r) => r.id === runId);
    if (run && (run.status === "completed" || run.status === "succeeded" || run.status === "failed" || run.status === "error")) {
      if (run.status === "failed" || run.status === "error") {
        throw new Error(`Watchdog job run ${runId} ended with status '${run.status}'`);
      }
      return;
    }
  }
  throw new Error(`Watchdog job run ${runId} did not complete within 30s`);
}

// ── Stale heartbeat run seeding ───────────────────────────────────────────────

/**
 * Seed a heartbeat_run row that appears stale (>1 h silent) for the given
 * issue. Requires Lead Engineer's test-seeding endpoint (LIF-44).
 *
 * POST /api/test/seed-stale-heartbeat-run
 *   { companyId, issueId, ageMinutes }
 */
export async function seedStaleHeartbeatRun(
  companyId: string,
  issueId: string,
  ageMinutes = 70,
): Promise<void> {
  const res = await apiPost("/api/test/seed-stale-heartbeat-run", {
    companyId,
    issueId,
    ageMinutes,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `seedStaleHeartbeatRun failed ${res.status}: ${text}\n` +
        "This endpoint requires LIF-44 (Lead Engineer) to be merged first.",
    );
  }
}

// ── Heartbeat simulation helpers ──────────────────────────────────────────────

/**
 * Simulate a silent heartbeat on issue P: checkout + no comment + re-block.
 *
 * "Silent" = the agent checks in, determines nothing to do, checks out without
 * posting a comment. Status stays blocked.
 *
 * In local_trusted mode all API calls are board-actor — no agent auth needed.
 */
export async function simulateSilentHeartbeat(
  issueId: string,
  assigneeAgentId: string,
  blockedByIssueIds: string[],
): Promise<void> {
  // Checkout sets status=in_progress. Immediately re-set to blocked (silent exit).
  await apiPost(`/api/issues/${issueId}/checkout`, {
    agentId: assigneeAgentId,
    expectedStatuses: ["blocked", "todo", "in_progress"],
  }).catch(() => undefined); // tolerate if already checked out
  await apiPatch(`/api/issues/${issueId}`, {
    status: "blocked",
    blockedByIssueIds,
    assigneeAgentId,
  });
}

/**
 * Simulate the 4th (keep-alive) heartbeat: post the keep-alive comment format
 * defined in HEARTBEAT_APPENDIX §2.
 *
 * Format: keep-alive | parent.status=<status> | blockedByIssueIds=[<id...>]
 *         | child=<id>(<status>) | lastActivityAt=<ISO8601>
 */
export async function simulateKeepAliveHeartbeat(
  issueId: string,
  parentStatus: string,
  blockedByIssueIds: string[],
  child: { id: string; status: string; lastActivityAt: string },
): Promise<IssueComment> {
  const blockedByStr = `[${blockedByIssueIds.join(",")}]`;
  const body =
    `keep-alive | parent.status=${parentStatus} | blockedByIssueIds=${blockedByStr}` +
    ` | child=${child.id}(${child.status}) | lastActivityAt=${child.lastActivityAt}`;
  return postIssueComment(issueId, body);
}

/**
 * Simulate the agent action for HEARTBEAT_APPENDIX §3:
 * - PATCH issue to status=in_review
 * - POST comment naming documentKey and revisionId
 *
 * The step definition should call upsertIssueDocument first, then this function.
 */
export async function simulatePlanFrontmatterInReviewAction(
  issueId: string,
  revisionId: string,
): Promise<{ updatedIssue: IssueDetail; comment: IssueComment }> {
  const updatedIssue = await updateIssue(issueId, { status: "in_review" });
  const comment = await postIssueComment(
    issueId,
    `Plan document updated. documentKey=plan revisionId=${revisionId}`,
  );
  return { updatedIssue, comment };
}
