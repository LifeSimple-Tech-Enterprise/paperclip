/**
 * lif375-integration.test.ts
 *
 * 10-scenario integration suite that gates the merge of LIF-375.
 * Scenarios 1–8 are HTTP integration tests against real embedded-postgres.
 * Scenarios 9–10 are unit-level function calls in the same describe block.
 *
 * Coverage: issue checkout FSM, handoff lifecycle, scope coupling, aggregate
 * merge gate, reviewRequest validation, role-pack resolution, adapter inventory.
 *
 * Hard rules: no production source edits; all 10 must pass; no regressions.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  handoffs,
  heartbeatRuns,
  issues,
  issueComments,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// execFile mock must be hoisted so it's in place before heartbeat.ts / handoffs.ts load
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mockExecFile };
});

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

import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";
import { heartbeatService } from "../services/index.js";
import {
  ADAPTER_INVENTORY,
  getAdapterInventory,
  resolveRolePack,
} from "../services/role-packs.js";

// ---------------------------------------------------------------------------
// Embedded postgres gate
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping lif375 integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Git mock helpers (mirrors handoffs-routes.test.ts)
// ---------------------------------------------------------------------------
function mockGitSuccess(sha = "abc123deadbeef") {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: `${sha}\n`, stderr: "" });
    },
  );
}

function mockGitInScope(sha = "abc123deadbeef") {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if ((args as string[]).includes("diff")) {
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(null, { stdout: `${sha}\n`, stderr: "" });
      }
    },
  );
}

function mockGitOutOfScope(outOfScopeFiles: string[], sha = "abc123deadbeef") {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      const argsArr = args as string[];
      if (argsArr.includes("diff")) {
        cb(null, { stdout: outOfScopeFiles.join("\n") + "\n", stderr: "" });
      } else if (argsArr.includes("rev-parse")) {
        cb(null, { stdout: `${sha}\n`, stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Handoffs table bootstrap (also adds metadata col to issue_comments)
// ---------------------------------------------------------------------------
async function ensureHandoffsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      issue_id uuid NOT NULL REFERENCES issues(id),
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      from_agent_id uuid REFERENCES agents(id),
      to_agent_id uuid REFERENCES agents(id),
      scope_globs jsonb,
      contract text,
      branch text,
      base_branch text,
      verified_sha text,
      decision text,
      decision_reason text,
      parent_handoff_id uuid REFERENCES handoffs(id),
      source_comment_id uuid,
      source_run_id uuid,
      idempotency_key text,
      payload jsonb,
      decided_at timestamp with time zone,
      merged_at timestamp with time zone,
      merged_sha text,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS handoffs_company_issue_idempotency_uq
      ON handoffs (company_id, issue_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `));
  await db.execute(sql.raw(
    `ALTER TABLE issue_comments ADD COLUMN IF NOT EXISTS metadata jsonb`,
  ));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("LIF-375 integration: 10-scenario coverage gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let agentAId: string;
  let agentBId: string;
  let issueId: string;
  let workspaceId: string;
  let runAId: string;
  let runBId: string;

  async function createApp(actorAgentId: string, actorRunId: string | null = null) {
    const { handoffRoutes } = await import("../routes/handoffs.js");
    const { issueRoutes } = await import("../routes/issues.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as any).actor = { type: "agent", agentId: actorAgentId, companyId, runId: actorRunId };
      next();
    });
    app.use("/api", issueRoutes(db as any, {} as any));
    app.use("/api", handoffRoutes(db as any));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lif375-integration-");
    db = createDb(tempDb.connectionString);
    await ensureHandoffsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE handoffs, issue_comments, activity_log,
               issues, execution_workspaces, project_workspaces,
               projects, goals, agents, companies
      RESTART IDENTITY CASCADE
    `));
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBaseData(
    issueStatus: "backlog" | "todo" | "in_progress" = "in_progress",
    assigneeVariant: "agentA" | "none" = "agentA",
  ) {
    companyId = randomUUID();
    agentAId = randomUUID();
    agentBId = randomUUID();
    issueId = randomUUID();
    workspaceId = randomUUID();
    runAId = randomUUID();
    runBId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "LIF-375 Test Company",
      issuePrefix: "LIF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "LIF-375 Test Project",
      status: "in_progress",
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Agent A",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Agent B",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "LIF-375 Test Workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/lif375-test",
      providerRef: "/tmp/lif375-test",
      baseRef: "main",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "LIF-375 Test Issue",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId: assigneeVariant === "agentA" ? agentAId : null,
      executionWorkspaceId: workspaceId,
    });
    // Seed heartbeat runs so activity_log FK(run_id → heartbeat_runs.id) is satisfied.
    await db.insert(heartbeatRuns).values([
      { id: runAId, companyId, agentId: agentAId, status: "running" },
      { id: runBId, companyId, agentId: agentBId, status: "running" },
    ]);
  }

  async function insertHandoff(values: {
    kind?: string;
    status?: string;
    fromAgentId?: string;
    toAgentId?: string | null;
    branch?: string;
    baseBranch?: string | null;
    scopeGlobs?: string[];
    parentHandoffId?: string | null;
  }) {
    const [row] = await db
      .insert(handoffs)
      .values({
        companyId,
        issueId,
        kind: values.kind ?? "delegate",
        status: values.status ?? "pending",
        fromAgentId: values.fromAgentId ?? agentAId,
        toAgentId: values.toAgentId ?? agentBId,
        branch: values.branch ?? "feature/lif375",
        baseBranch: values.baseBranch ?? null,
        scopeGlobs: values.scopeGlobs ?? ["src/**"],
        parentHandoffId: values.parentHandoffId ?? null,
        updatedAt: new Date(),
      } as any)
      .returning();
    return row;
  }

  // ============================================================
  // 1. Issue checkout FSM: unassigned todo → in_progress
  // ============================================================
  it("1. checkout: unassigned todo issue becomes in_progress with assignee set", async () => {
    await seedBaseData("todo", "none");
    mockGitSuccess();
    const app = await createApp(agentAId, runAId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: agentAId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.assigneeAgentId).toBe(agentAId);
  });

  // ============================================================
  // 2. Issue checkout FSM: conflict when another agent owns the issue
  // ============================================================
  it("2. checkout: conflict when issue already owned by different agent → 409", async () => {
    await seedBaseData("in_progress", "agentA");
    mockGitSuccess();
    const app = await createApp(agentBId, runBId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: agentBId, expectedStatuses: ["in_progress"] });

    expect(res.status).toBe(409);
  });

  // ============================================================
  // 3. Handoff lifecycle: delegate creation (happy path)
  // ============================================================
  it("3. handoff: delegate creation returns 201 with all expected fields", async () => {
    await seedBaseData("in_progress", "agentA");
    mockGitSuccess();
    const app = await createApp(agentAId);

    const res = await request(app)
      .post(`/api/issues/${issueId}/handoffs`)
      .send({
        kind: "delegate",
        toAgentId: agentBId,
        branch: "feature/lif375",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        contract: "implement the feature",
      });

    expect(res.status).toBe(201);
    expect(res.body.handoff).toMatchObject({
      companyId,
      issueId,
      kind: "delegate",
      status: "pending",
      fromAgentId: agentAId,
      toAgentId: agentBId,
      branch: "feature/lif375",
      scopeGlobs: ["src/**"],
    });
  });

  // ============================================================
  // 4. Scope coupling: out-of-scope decide → HTTP 200 + systemEnforced
  // ============================================================
  it("4. handoff decide: out-of-scope files → 200 with systemEnforced:true and handoff auto-rejected", async () => {
    await seedBaseData("in_progress", "agentA");
    const delegate = await insertHandoff({
      branch: "feature/lif375",
      scopeGlobs: ["src/**"],
    });

    mockGitOutOfScope(["lib/forbidden.ts"]);
    const app = await createApp(agentAId);

    const res = await request(app)
      .patch(`/api/handoffs/${delegate.id}/decide`)
      .send({ decision: "accepted" });

    expect(res.status).toBe(200);
    expect(res.body.systemEnforced).toBe(true);
    expect(res.body.outOfScopeFiles).toContain("lib/forbidden.ts");
    expect(res.body.handoff.status).toBe("rejected");
  });

  // ============================================================
  // 5. Handoff lifecycle: review inherits branch/scopeGlobs from parent
  // ============================================================
  it("5. handoff: review creation inherits branch and scopeGlobs from parent delegate", async () => {
    await seedBaseData("in_progress", "agentA");
    const delegate = await insertHandoff({
      fromAgentId: agentAId,
      toAgentId: agentBId,
      branch: "feature/lif375",
      scopeGlobs: ["src/**", "tests/**"],
    });

    const app = await createApp(agentBId);
    const res = await request(app)
      .post(`/api/issues/${issueId}/handoffs`)
      .send({ kind: "review", parentHandoffId: delegate.id });

    expect(res.status).toBe(201);
    expect(res.body.handoff.branch).toBe("feature/lif375");
    expect(res.body.handoff.scopeGlobs).toEqual(["src/**", "tests/**"]);
    expect(res.body.handoff.parentHandoffId).toBe(delegate.id);
  });

  // ============================================================
  // 6. Scope coupling: in-scope accept → verifiedSha populated
  // ============================================================
  it("6. handoff decide: in-scope accept → 200, status=accepted, verifiedSha set", async () => {
    await seedBaseData("in_progress", "agentA");
    const review = await insertHandoff({
      kind: "review",
      fromAgentId: agentBId,
      toAgentId: agentAId,
      branch: "feature/lif375",
      baseBranch: "main",
      scopeGlobs: ["src/**"],
    });

    const sha = "deadbeef12345678";
    mockGitInScope(sha);
    const app = await createApp(agentAId);

    const res = await request(app)
      .patch(`/api/handoffs/${review.id}/decide`)
      .send({ decision: "accepted" });

    expect(res.status).toBe(200);
    expect(res.body.handoff.status).toBe("accepted");
    expect(res.body.handoff.verifiedSha).toBe(sha);
  });

  // ============================================================
  // 7. Aggregate merge gate: gated when caller is not the assignee
  // ============================================================
  it("7. tryRunPreAdapterAggregateMerge: outcome=gated when agentId is not the issue assignee", async () => {
    await seedBaseData("in_progress", "agentA");
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.tryRunPreAdapterAggregateMerge({
      issueId,
      agentId: agentBId,
      workspaceDir: "/tmp/lif375-test",
    });

    expect(result.outcome).toBe("gated");
    expect(result.reason).toBe("not_issue_assignee");
  });

  // ============================================================
  // 8. reviewRequest validation: 422 when no active execution stage
  // ============================================================
  it("8. issues PATCH reviewRequest: 422 REVIEW_REQUEST_NOT_ACTIVE when issue has no active stage", async () => {
    await seedBaseData("todo", "none");
    const app = await createApp(agentAId);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ reviewRequest: { instructions: "please approve" } });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("REVIEW_REQUEST_NOT_ACTIVE");
  });

  // ============================================================
  // 9. Role-pack resolution: null when adapterConfig has no rolePack
  // ============================================================
  it("9. resolveRolePack: returns null for agent with empty adapterConfig", () => {
    const result = resolveRolePack({ id: "lif375-test-agent", adapterConfig: {} });
    expect(result).toBeNull();
  });

  // ============================================================
  // 10. Adapter inventory coverage: BUILTIN_ADAPTER_TYPES ↔ ADAPTER_INVENTORY
  // ============================================================
  it("10. ADAPTER_INVENTORY covers every BUILTIN_ADAPTER_TYPE — no gaps, no extras", () => {
    const inventoryKeys = new Set(Object.keys(ADAPTER_INVENTORY));
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      expect(
        inventoryKeys.has(adapterType),
        `ADAPTER_INVENTORY missing entry for '${adapterType}'`,
      ).toBe(true);
    }
    for (const key of inventoryKeys) {
      expect(
        BUILTIN_ADAPTER_TYPES.has(key),
        `ADAPTER_INVENTORY has extra key '${key}' not in BUILTIN_ADAPTER_TYPES`,
      ).toBe(true);
    }
    // Sanity: getAdapterInventory returns non-null for every builtin type
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      expect(
        getAdapterInventory(adapterType),
        `getAdapterInventory('${adapterType}') should not return null`,
      ).not.toBeNull();
    }
  });
});
