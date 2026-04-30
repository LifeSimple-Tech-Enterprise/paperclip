/**
 * issue-blocked-bypass.test.ts
 *
 * Verifies the rev-22 "rowCount > 0" gate in agentActionTrackerMiddleware:
 * publishGlobalLiveEvent must fire exactly once (changed=true) and must NOT
 * fire when forceBlock returns changed=false (issue already blocked/done/cancelled).
 *
 * Uses real embedded-postgres so forceBlock's raw UPDATE runs against a real
 * issues table and the rowCount is genuine.
 *
 * publishGlobalLiveEvent is mocked to capture calls without side-effects.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentActionAttempts,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock publishGlobalLiveEvent to observe calls without broadcasting.
vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
  publishLiveEvent: vi.fn(),
}));

import { publishGlobalLiveEvent } from "../services/live-events.js";
import { agentActionTrackerMiddleware } from "../middleware/agent-action-tracker.js";

// ---------------------------------------------------------------------------
// Embedded postgres
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-blocked-bypass tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeEmbeddedPostgres(
  "publishGlobalLiveEvent gate: fires only when forceBlock returns changed=true",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    let companyId: string;
    let agentId: string;
    let issueId: string;

    // The test route always returns 422 to trigger the tracker's increment path.
    // blockThreshold=1 + autoBlockEnabled=true means the first 422 trips the bypass.
    function createBypassApp() {
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
        (req as any).actor = { type: "agent", agentId, companyId, runId: null };
        next();
      });
      app.use(
        agentActionTrackerMiddleware(db as any, {
          autoBlockEnabled: true,
          blockThreshold: 1,
        }),
      );
      app.post("/api/issues/:id/comments", (_req: express.Request, res: express.Response) => {
        res.status(422).json({ error: "Validation failed", code: "SOME_CODE" });
      });
      return app;
    }

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bypass-gate-");
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.execute(sql.raw(`
        TRUNCATE agent_action_attempts, issue_comments, activity_log,
                 issues, execution_workspaces, project_workspaces,
                 projects, goals, agents, companies
        RESTART IDENTITY CASCADE
      `));
      vi.clearAllMocks();
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedIssue(status: "in_progress" | "blocked" | "done" | "cancelled") {
      companyId = randomUUID();
      agentId = randomUUID();
      issueId = randomUUID();
      const projectId = randomUUID();
      const workspaceId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Bypass Gate Company",
        issuePrefix: "BYP",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Bypass Gate Project",
        status: "in_progress",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Bypass Gate Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(executionWorkspaces).values({
        id: workspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Bypass Gate Workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/bypass-test",
        providerRef: "/tmp/bypass-test",
        baseRef: "main",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Bypass Gate Issue",
        status,
        priority: "medium",
        assigneeAgentId: agentId,
        executionWorkspaceId: workspaceId,
      });
    }

    it("does NOT call publishGlobalLiveEvent when issue is already blocked (rowCount=0)", async () => {
      // Issue is already 'blocked' — forceBlock UPDATE matches 0 rows → changed=false.
      await seedIssue("blocked");
      const app = createBypassApp();

      await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "test" });
      // Wait for the async finish handler.
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(vi.mocked(publishGlobalLiveEvent)).not.toHaveBeenCalled();
    });

    it("DOES call publishGlobalLiveEvent exactly once when issue transitions to blocked (rowCount=1)", async () => {
      // Issue is 'in_progress' — forceBlock UPDATE matches 1 row → changed=true.
      await seedIssue("in_progress");
      const app = createBypassApp();

      await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "test" });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(vi.mocked(publishGlobalLiveEvent)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(publishGlobalLiveEvent)).toHaveBeenCalledWith(
        expect.objectContaining({ type: "activity.logged" }),
      );

      // Confirm the issue status was actually updated to 'blocked' in the DB.
      const [row] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(row?.status).toBe("blocked");
    });

    it("does NOT call publishGlobalLiveEvent when issue is already done (rowCount=0)", async () => {
      await seedIssue("done");
      const app = createBypassApp();

      await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "test" });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(vi.mocked(publishGlobalLiveEvent)).not.toHaveBeenCalled();
    });
  },
);
