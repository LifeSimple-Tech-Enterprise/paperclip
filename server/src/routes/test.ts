import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";

const seedStaleHeartbeatRunSchema = z.object({
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  ageMinutes: z.number().int().min(1).optional().default(70),
});

export function testRoutes(db: Db) {
  const router = Router();

  router.post(
    "/seed-stale-heartbeat-run",
    validate(seedStaleHeartbeatRunSchema),
    async (req, res) => {
      const { companyId, issueId, ageMinutes } = req.body as z.infer<
        typeof seedStaleHeartbeatRunSchema
      >;

      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) {
        res.status(404).json({ error: `Issue ${issueId} not found` });
        return;
      }
      if (issue.companyId !== companyId) {
        res.status(400).json({
          error: `Issue ${issueId} belongs to company ${issue.companyId}, not ${companyId}`,
        });
        return;
      }

      let agentId = issue.assigneeAgentId;
      if (!agentId) {
        const fallback = await db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!fallback) {
          res.status(400).json({
            error: `No agent available in company ${companyId} to attach the seeded heartbeat run to`,
          });
          return;
        }
        agentId = fallback.id;
      }

      const stalePoint = new Date(Date.now() - ageMinutes * 60_000);

      const [inserted] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          status: "running",
          invocationSource: "on_demand",
          startedAt: stalePoint,
          processStartedAt: stalePoint,
          lastOutputAt: stalePoint,
          contextSnapshot: { issueId },
        })
        .returning({ id: heartbeatRuns.id, lastOutputAt: heartbeatRuns.lastOutputAt });

      res.status(201).json({
        id: inserted.id,
        lastOutputAt: inserted.lastOutputAt,
        agentId,
        issueId,
        companyId,
      });
    },
  );

  return router;
}
