import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { StaleRunRow } from "./types.js";
import { buildDescription, resolveOwner } from "./templating.js";

export async function reconcileStaleBlockedParents(ctx: PluginContext): Promise<void> {
  const staleRuns = await ctx.db.query<StaleRunRow>(`
    SELECT hr.id,
           hr.company_id        AS "companyId",
           hr.agent_id          AS "agentId",
           (hr.context_snapshot->>'issueId')::uuid AS "issueId",
           hr.status,
           hr.context_snapshot  AS "contextSnapshot",
           hr.error,
           hr.error_code        AS "errorCode"
      FROM heartbeat_runs hr
     WHERE hr.status = 'running'
       AND coalesce(hr.last_output_at, hr.process_started_at, hr.started_at, hr.created_at)
             <= now() - interval '1 hour'
  `);

  if (staleRuns.length === 0) return;

  const byCompany = new Map<string, StaleRunRow[]>();
  for (const run of staleRuns) {
    if (!run.companyId) continue;
    const list = byCompany.get(run.companyId) ?? [];
    list.push(run);
    byCompany.set(run.companyId, list);
  }

  for (const [companyId, companyRuns] of byCompany) {
    const staleChildIds = new Set(
      companyRuns.map(r => r.issueId).filter((id): id is string => id !== null),
    );

    const blockedParents = await ctx.issues.list({ companyId, status: "blocked" });

    for (const parent of blockedParents) {
      const relations = await ctx.issues.relations.get(parent.id, companyId);
      const stalledRelation = relations.blockedBy.find(b => staleChildIds.has(b.id));
      if (!stalledRelation) continue;

      const stalledRun = companyRuns.find(r => r.issueId === stalledRelation.id) ?? null;

      const fingerprint = `stranded_blocker_under_blocked_parent:${parent.id}:${stalledRelation.id}`;

      const existing = (await ctx.issues.list({ companyId, originId: fingerprint }))
        .filter(i => i.status !== "done" && i.status !== "cancelled");
      if (existing.length > 0) continue;

      const assigneeAgentId = await resolveOwner(ctx, parent, companyId);
      if (!assigneeAgentId) continue;

      await ctx.issues.create({
        companyId,
        title: `Recover stalled issue ${parent.identifier ?? parent.title}`,
        description: buildDescription({ parent, stalledRun, previousStatus: parent.status }),
        originKind: "plugin:recovery-watchdog:stranded_issue_recovery",
        originId: fingerprint,
        assigneeAgentId,
        blockedByIssueIds: [parent.id],
      });
    }
  }
}
