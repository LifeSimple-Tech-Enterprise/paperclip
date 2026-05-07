// Local copies of recovery-issue title / description / owner-resolution helpers,
// ported from server/src/services/recovery/service.ts (functions
// buildStrandedIssueRecoveryDescription, resolveStrandedIssueRecoveryOwnerAgentId,
// ensureStrandedIssueRecoveryIssue).  Description string kept byte-identical to
// upstream so the recovery-task UX is uniform.
import type { PluginContext, Issue } from "@paperclipai/plugin-sdk";
import type { StaleRunRow } from "./types.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function issueUiLink(identifier: string | null, id: string, prefix: string): string {
  const label = identifier ?? id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(runId: string, agentId: string, prefix: string): string {
  return `[\`${runId}\`](/${prefix}/agents/${agentId}/runs/${runId})`;
}

function summarizeRunFailureForIssueComment(run: StaleRunRow | null): string | null {
  if (!run) return null;
  if (readNonEmptyString(run.error) || readNonEmptyString(run.errorCode)) {
    return " Latest retry failure details were withheld from the issue thread; inspect the linked run for evidence.";
  }
  return null;
}

/**
 * Build the description for a stranded-issue recovery task.
 * The markdown body is kept byte-identical to `buildStrandedIssueRecoveryDescription`
 * in server/src/services/recovery/service.ts so the recovery-task UX is uniform.
 */
export function buildDescription(input: {
  parent: Issue;
  stalledRun: StaleRunRow | null;
}): string {
  const prefix = input.parent.identifier?.split("-")[0] ?? "LIF";
  const sourceIssue = issueUiLink(input.parent.identifier, input.parent.id, prefix);
  const runLink = input.stalledRun
    ? runUiLink(input.stalledRun.id, input.stalledRun.agentId, prefix)
    : "none";
  const retryReason =
    readNonEmptyString(
      (input.stalledRun?.contextSnapshot as Record<string, unknown> | null)?.retryReason,
    ) ?? "unknown";
  const failureSummary = summarizeRunFailureForIssueComment(input.stalledRun);

  return [
    "Paperclip exhausted automatic recovery for an assigned issue and created this explicit recovery task.",
    "",
    "## Source",
    "",
    `- Source issue: ${sourceIssue}`,
    `- Previous source status: \`blocked\``,
    `- Latest retry run: ${runLink}`,
    `- Latest retry status: \`${input.stalledRun?.status ?? "unknown"}\``,
    `- Detected invariant: \`stranded_assigned_issue\``,
    `- Retry reason: \`${retryReason}\``,
    failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
    "",
    "## Ownership",
    "",
    "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
    "",
    "## Required Action",
    "",
    "- Inspect the latest run and source issue state.",
    "- Fix the runtime/adapter problem, reassign the source issue, or convert the source issue into a clear manual-review state.",
    "- When the source issue has a live execution path or has been intentionally resolved, mark this recovery issue done.",
  ].join("\n");
}

/**
 * Resolve the agent that should own the recovery issue.
 * Mirrors resolveStrandedIssueRecoveryOwnerAgentId from
 * server/src/services/recovery/service.ts: assignee manager → creator manager →
 * creator → company CTO → company CEO → original assignee.
 */
export async function resolveOwner(
  ctx: PluginContext,
  parent: Issue,
  companyId: string,
): Promise<string | null> {
  const candidateIds: string[] = [];

  if (parent.assigneeAgentId) {
    const assignee = await ctx.agents.get(parent.assigneeAgentId, companyId);
    if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
  }
  if (parent.createdByAgentId) {
    const creator = await ctx.agents.get(parent.createdByAgentId, companyId);
    if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
    candidateIds.push(parent.createdByAgentId);
  }

  const allAgents = await ctx.agents.list({ companyId });
  const executives = allAgents
    .filter(a => a.role === "cto" || a.role === "ceo")
    .sort((a, b) => {
      if (a.role === "cto" && b.role !== "cto") return -1;
      if (b.role === "cto" && a.role !== "cto") return 1;
      return 0;
    });
  candidateIds.push(...executives.map(a => a.id));

  if (parent.assigneeAgentId) candidateIds.push(parent.assigneeAgentId);

  const seen = new Set<string>();
  for (const agentId of candidateIds) {
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent || agent.companyId !== companyId) continue;
    if (agent.status === "terminated" || agent.status === "pending_approval") continue;
    return agent.id;
  }

  return null;
}
