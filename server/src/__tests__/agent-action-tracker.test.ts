/**
 * agent-action-tracker.test.ts
 *
 * Integration test for agentActionTrackerMiddleware — specifically verifies the
 * "awaited 2xx-delete" contract: a 422 → 200 → 422 sequence against the same key
 * must end with attempt_count === 1, not 2.
 *
 * The 200 response must durably delete the tracker row before the next write
 * so the second 422 starts fresh from attempt=1.
 *
 * Uses real embedded-postgres (seeded company/agent/issue rows satisfy FK
 * constraints on agent_action_attempts). No git mocks needed.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
  publishLiveEvent: vi.fn(),
}));

import { agentActionTrackerMiddleware } from "../middleware/agent-action-tracker.js";

// ---------------------------------------------------------------------------
// Embedded postgres availability
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-action-tracker tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Main suite
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("agentActionTrackerMiddleware: 422 → 200 → 422 sequence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let agentId: string;
  let issueId: string;

  // Status code the test route will return — mutated per request.
  let nextStatus = 422;
  let nextBody: object = { error: "Validation failed", code: "SOME_CODE" };

  function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as any).actor = { type: "agent", agentId, companyId, runId: null };
      next();
    });
    app.use(agentActionTrackerMiddleware(db as any));
    app.post("/api/issues/:id/comments", (_req: express.Request, res: express.Response) => {
      res.status(nextStatus).json(nextBody);
    });
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tracker-seq-");
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

  async function seedBaseData() {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Tracker Test Company",
      issuePrefix: "TRK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Tracker Test Project",
      status: "in_progress",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tracker Test Agent",
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
      name: "Tracker Test Workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/tracker-test",
      providerRef: "/tmp/tracker-test",
      baseRef: "main",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Tracker Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionWorkspaceId: workspaceId,
    });
  }

  it("422 → 200 → 422: final attempt_count is 1, not accumulated", async () => {
    await seedBaseData();
    const app = createTestApp();

    // --- First request: 422 → creates row with attempts=1 ---
    nextStatus = 422;
    nextBody = { error: "Validation failed", code: "SOME_CODE" };
    await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "first" });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const rows1 = await db
      .select({ attempts: agentActionAttempts.attempts })
      .from(agentActionAttempts)
      .where(
        and(
          eq(agentActionAttempts.agentId, agentId),
          eq(agentActionAttempts.issueId, issueId),
        ),
      );
    expect(rows1).toHaveLength(1);
    expect(rows1[0].attempts).toBe(1);

    // --- Second request: 200 → deletes the row ---
    nextStatus = 200;
    nextBody = { ok: true };
    await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "success" });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const rows2 = await db
      .select()
      .from(agentActionAttempts)
      .where(
        and(
          eq(agentActionAttempts.agentId, agentId),
          eq(agentActionAttempts.issueId, issueId),
        ),
      );
    expect(rows2).toHaveLength(0);

    // --- Third request: 422 → creates fresh row with attempts=1 (not 2) ---
    nextStatus = 422;
    nextBody = { error: "Validation failed again", code: "SOME_CODE" };
    await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "third" });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const rows3 = await db
      .select({ attempts: agentActionAttempts.attempts })
      .from(agentActionAttempts)
      .where(
        and(
          eq(agentActionAttempts.agentId, agentId),
          eq(agentActionAttempts.issueId, issueId),
        ),
      );
    expect(rows3).toHaveLength(1);
    expect(rows3[0].attempts).toBe(1);
  });

  it("repeated 422s accumulate: two 422s → attempts=2", async () => {
    await seedBaseData();
    const app = createTestApp();

    nextStatus = 422;
    nextBody = { error: "Validation failed", code: "SOME_CODE" };

    await request(app).post(`/api/issues/${issueId}/comments`).send({});
    await new Promise((resolve) => setTimeout(resolve, 80));

    await request(app).post(`/api/issues/${issueId}/comments`).send({});
    await new Promise((resolve) => setTimeout(resolve, 80));

    const rows = await db
      .select({ attempts: agentActionAttempts.attempts })
      .from(agentActionAttempts)
      .where(
        and(
          eq(agentActionAttempts.agentId, agentId),
          eq(agentActionAttempts.issueId, issueId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(2);
  });
});
