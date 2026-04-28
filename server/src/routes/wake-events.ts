import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { wakeEventsBaselineService } from "../services/wake-events-baseline.js";
import { assertCompanyAccess } from "./authz.js";

export function wakeEventRoutes(db: Db) {
  const router = Router();
  const svc = wakeEventsBaselineService(db);

  router.get("/companies/:companyId/wake-events/baseline", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const sinceParam = req.query.since as string | undefined;
    const untilParam = req.query.until as string | undefined;

    const since = sinceParam ? new Date(sinceParam) : undefined;
    const until = untilParam ? new Date(untilParam) : undefined;

    const baseline = await svc.getBaseline(companyId, { since, until });
    res.json(baseline);
  });

  return router;
}
