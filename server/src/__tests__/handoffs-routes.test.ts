import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  handoffs,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
  goals,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// --- vi.hoisted mock for execFile (must be before vi.mock) ---
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

// ---------------------------------------------------------------------------
// Embedded postgres availability check
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres handoffs-routes tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function ensureHandoffsTable(db: ReturnType<typeof createDb>) {
  // Create handoffs table from migration SQL
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

  // Add metadata column to issue_comments if missing
  await db.execute(sql.raw(`
    ALTER TABLE issue_comments ADD COLUMN IF NOT EXISTS metadata jsonb
  `));
}

// Helper to insert a handoff and return the created row
async function insertHandoff(
  db: ReturnType<typeof createDb>,
  values: Parameters<ReturnType<typeof db.insert>["values"]>[0],
) {
  const [row] = await db.insert(handoffs).values(values as any).returning();
  return row;
}

// Default mock for git calls: success on all commands
function mockGitSuccess(sha = "abc123deadbeef") {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: `${sha}\n`, stderr: "" });
    },
  );
}

// Mock git fetch success, diff returns no files, rev-parse returns sha
function mockGitInScope(sha = "abc123deadbeef") {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      const argsArr = args as string[];
      if (argsArr.includes("diff")) {
        // Return empty diff → no files changed → in scope
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(null, { stdout: `${sha}\n`, stderr: "" });
      }
    },
  );
}

// Mock git diff to return out-of-scope files
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

// Mock git fetch to fail (branch missing)
function mockGitFetchFail() {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      const argsArr = args as string[];
      if (argsArr.includes("fetch")) {
        const err = new Error("fetch failed") as NodeJS.ErrnoException & {
          code?: string | number;
        };
        err.code = 1;
        cb(err, { stdout: "", stderr: "error: branch not found" });
      } else {
        cb(null, { stdout: "abc123\n", stderr: "" });
      }
    },
  );
}

// Mock rev-parse to fail after successful fetch + diff
function mockGitRevParseFail() {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      const argsArr = args as string[];
      if (argsArr.includes("rev-parse") && argsArr.some((a) => a.startsWith("origin/"))) {
        const err = new Error("rev-parse failed");
        (err as any).code = 128;
        cb(err, { stdout: "", stderr: "fatal: bad revision" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("handoffs routes (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Seed IDs used across tests
  let companyId: string;
  let actorAgentId: string;
  let toAgentId: string;
  let issueId: string;
  let workspaceId: string;

  async function createApp(overrideActorAgentId?: string) {
    const { handoffRoutes } = await import("../routes/handoffs.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: overrideActorAgentId ?? actorAgentId,
        companyId,
        runId: null,
      };
      next();
    });
    app.use("/api", handoffRoutes(db));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handoffs-routes-");
    db = createDb(tempDb.connectionString);
    await ensureHandoffsTable(db);
  }, 20_000);

  afterEach(async () => {
    // Clear data in dependency order
    await db.execute(sql.raw(`DELETE FROM handoffs`));
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);

    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Helper to seed base data
  async function seedBaseData() {
    companyId = randomUUID();
    actorAgentId = randomUUID();
    toAgentId = randomUUID();
    issueId = randomUUID();
    workspaceId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });

    await db.insert(agents).values([
      {
        id: actorAgentId,
        companyId,
        name: "Lead Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: toAgentId,
        companyId,
        name: "Worker Agent",
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
      name: "Test Workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/test-workspace",
      providerRef: "/tmp/test-workspace",
      baseRef: "main",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: actorAgentId,
      executionWorkspaceId: workspaceId,
    });
  }

  // ===========================================================================
  // POST /api/issues/:id/handoffs — delegate creation
  // ===========================================================================
  describe("POST /api/issues/:id/handoffs - delegate creation", () => {
    it("creates a delegate handoff with all fields", async () => {
      await seedBaseData();
      mockGitSuccess();

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({
          kind: "delegate",
          toAgentId,
          branch: "feature/test-branch",
          baseBranch: "main",
          scopeGlobs: ["src/**"],
          contract: "Test contract",
          payload: { key: "value" },
        });

      expect(res.status).toBe(201);
      expect(res.body.handoff).toMatchObject({
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        fromAgentId: actorAgentId,
        toAgentId,
        branch: "feature/test-branch",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        contract: "Test contract",
        payload: { key: "value" },
      });
      expect(res.body.handoff.id).toBeDefined();
    });

    it("requires branch for kind=delegate → 422", async () => {
      await seedBaseData();

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({ kind: "delegate", toAgentId });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("MISSING_BRANCH");
    });

    it("rejects invalid kind → 422", async () => {
      await seedBaseData();

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({ kind: "bogus_kind", branch: "main" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("INVALID_KIND");
    });

    it("returns 404 for unknown issue", async () => {
      await seedBaseData();

      const app = await createApp();
      const res = await request(app)
        .post(`/api/issues/${randomUUID()}/handoffs`)
        .send({ kind: "delegate", branch: "main" });

      expect(res.status).toBe(404);
    });

    it("idempotency: same idempotencyKey returns existing row with idempotent:true", async () => {
      await seedBaseData();

      const app = await createApp();
      const idempotencyKey = randomUUID();

      const first = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({
          kind: "delegate",
          branch: "feature/idempotent",
          idempotencyKey,
        });

      expect(first.status).toBe(201);
      const firstId = first.body.handoff.id;

      const second = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({
          kind: "delegate",
          branch: "feature/idempotent",
          idempotencyKey,
        });

      expect(second.status).toBe(200);
      expect(second.body.idempotent).toBe(true);
      expect(second.body.handoff.id).toBe(firstId);
    });
  });

  // ===========================================================================
  // POST /api/issues/:id/handoffs — review hard-inheritance
  // ===========================================================================
  describe("POST /api/issues/:id/handoffs - review hard-inheritance", () => {
    it("hard-inherits branch/baseBranch/scopeGlobs from parent delegate byte-for-byte", async () => {
      await seedBaseData();

      // Create delegate handoff from lead agent → to toAgentId
      const delegate = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        fromAgentId: actorAgentId,
        toAgentId,
        branch: "feature/my-branch",
        baseBranch: "main",
        scopeGlobs: ["src/**", "tests/**"],
        updatedAt: new Date(),
      });

      // toAgentId actor creates review handoff
      const app = await createApp(toAgentId);
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({
          kind: "review",
          parentHandoffId: delegate.id,
          // Intentionally omit branch/baseBranch/scopeGlobs to test hard-inherit
        });

      expect(res.status).toBe(201);
      const created = res.body.handoff;
      expect(created.branch).toBe("feature/my-branch");
      expect(created.baseBranch).toBe("main");
      expect(created.scopeGlobs).toEqual(["src/**", "tests/**"]);
      expect(created.parentHandoffId).toBe(delegate.id);
    });

    it("POST review with mismatched branch/baseBranch body → persisted row equals parent delegate values", async () => {
      await seedBaseData();

      const delegate = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        fromAgentId: actorAgentId,
        toAgentId,
        branch: "canonical-branch",
        baseBranch: "canonical-base",
        scopeGlobs: ["canonical/**"],
        updatedAt: new Date(),
      });

      const app = await createApp(toAgentId);
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({
          kind: "review",
          parentHandoffId: delegate.id,
          branch: "different-branch",    // Should be overridden
          baseBranch: "different-base",  // Should be overridden
          scopeGlobs: ["other/**"],       // Should be overridden
        });

      expect(res.status).toBe(201);
      // Persisted values match parent delegate, not body
      expect(res.body.handoff.branch).toBe("canonical-branch");
      expect(res.body.handoff.baseBranch).toBe("canonical-base");
      expect(res.body.handoff.scopeGlobs).toEqual(["canonical/**"]);
    });

    it("parent owned by different agent → 403 unauthorized_parent, no row inserted", async () => {
      await seedBaseData();
      const anotherAgentId = randomUUID();

      await db.insert(agents).values({
        id: anotherAgentId,
        companyId,
        name: "Another Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      // Delegate goes to anotherAgentId, not actorAgentId
      const delegate = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        fromAgentId: actorAgentId,
        toAgentId: anotherAgentId,
        branch: "feature/x",
        updatedAt: new Date(),
      });

      const countBefore = await db.select().from(handoffs);
      const beforeCount = countBefore.length;

      // actorAgentId tries to create review but delegate goes to anotherAgentId
      const app = await createApp(actorAgentId);
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({ kind: "review", parentHandoffId: delegate.id });

      expect(res.status).toBe(403);

      const countAfter = await db.select().from(handoffs);
      expect(countAfter.length).toBe(beforeCount); // no new row
    });

    it("cross-company parent → 422 orphan_review", async () => {
      await seedBaseData();

      // Create a different company and issue
      const otherCompanyId = randomUUID();
      const otherIssueId = randomUUID();
      const otherProjectId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Company",
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(projects).values({
        id: otherProjectId,
        companyId: otherCompanyId,
        name: "Other Project",
        status: "in_progress",
      });
      await db.insert(issues).values({
        id: otherIssueId,
        companyId: otherCompanyId,
        title: "Other Issue",
        status: "in_progress",
        priority: "medium",
      });

      // Create delegate in other company
      const otherDelegate = await insertHandoff(db, {
        companyId: otherCompanyId,
        issueId: otherIssueId,
        kind: "delegate",
        status: "pending",
        fromAgentId: actorAgentId,
        toAgentId,
        branch: "feature/x",
        updatedAt: new Date(),
      });

      // Try to create review in original company pointing to other-company delegate
      const app = await createApp(toAgentId);
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({ kind: "review", parentHandoffId: otherDelegate.id });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("ORPHAN_REVIEW");
    });

    it("non-delegate parent → 422 orphan_review", async () => {
      await seedBaseData();

      // Create an acceptance handoff (not delegate) as parent
      const acceptance = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "acceptance",
        status: "pending",
        fromAgentId: actorAgentId,
        toAgentId,
        branch: "feature/x",
        updatedAt: new Date(),
      });

      const app = await createApp(toAgentId);
      const res = await request(app)
        .post(`/api/issues/${issueId}/handoffs`)
        .send({ kind: "review", parentHandoffId: acceptance.id });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("ORPHAN_REVIEW");
    });
  });

  // ===========================================================================
  // PATCH /api/handoffs/:id/decide — terminal idempotency
  // ===========================================================================
  describe("PATCH /api/handoffs/:id/decide - terminal idempotency", () => {
    it("same decision → 200 { idempotent: true }", async () => {
      await seedBaseData();

      // Create an already-rejected handoff
      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "rejected",
        decision: "rejected",
        branch: "feature/x",
        baseBranch: "main",
        decidedAt: new Date(),
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "rejected" });

      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(true);
    });

    it("different decision → 422 terminal_handoff_mismatch", async () => {
      await seedBaseData();

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "rejected",
        decision: "rejected",
        branch: "feature/x",
        baseBranch: "main",
        decidedAt: new Date(),
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("TERMINAL_HANDOFF_MISMATCH");
    });

    it("decisionReason ignored on replay: persisted decisionReason is canonical, body decisionReason NOT overwritten", async () => {
      await seedBaseData();

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "rejected",
        decision: "rejected",
        decisionReason: "original_reason",
        branch: "feature/x",
        baseBranch: "main",
        decidedAt: new Date(),
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "rejected", decisionReason: "new_reason_attempt" });

      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(true);
      // The returned handoff should have the ORIGINAL decision_reason
      expect(res.body.handoff.decisionReason).toBe("original_reason");
    });

    it("rejecting a pending handoff → status=rejected", async () => {
      await seedBaseData();

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/x",
        baseBranch: "main",
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "rejected", decisionReason: "not_good_enough" });

      expect(res.status).toBe(200);
      expect(res.body.handoff.status).toBe("rejected");
      expect(res.body.handoff.decision).toBe("rejected");
      expect(res.body.handoff.decisionReason).toBe("not_good_enough");
    });
  });

  // ===========================================================================
  // PATCH /api/handoffs/:id/decide — scope check (mocked git)
  // ===========================================================================
  describe("PATCH /api/handoffs/:id/decide - scope check (mocked git)", () => {
    it("accepted with in-scope files → status=accepted, verifiedSha captured", async () => {
      await seedBaseData();

      const sha = "cafebabe12345678";
      mockGitInScope(sha);

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/in-scope",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      expect(res.status).toBe(200);
      expect(res.body.handoff.status).toBe("accepted");
      expect(res.body.handoff.verifiedSha).toBe(sha);
    });

    it("scope violation: persists status=rejected BEFORE responding (auto-reject persistence)", async () => {
      await seedBaseData();

      mockGitOutOfScope(["outside/file.ts"], "abc123");

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/out-of-scope",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        updatedAt: new Date(),
      });

      const app = await createApp();
      await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      // Verify persistence in DB
      const [updated] = await db
        .select({ status: handoffs.status, decision: handoffs.decision })
        .from(handoffs)
        .where(eq(handoffs.id, row.id));
      expect(updated.status).toBe("rejected");
      expect(updated.decision).toBe("rejected");
    });

    it("scope violation: inserts courtesy comment with metadata.kind=handoff_auto_reject in same tx", async () => {
      await seedBaseData();

      mockGitOutOfScope(["outside/file.ts"], "abc123");

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/out-of-scope",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        updatedAt: new Date(),
      });

      const app = await createApp();
      await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      // Check for courtesy comment
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.length).toBeGreaterThan(0);

      const autoRejectComment = comments.find(
        (c) => (c.metadata as any)?.kind === "handoff_auto_reject",
      );
      expect(autoRejectComment).toBeDefined();
      expect((autoRejectComment!.metadata as any).handoffId).toBe(row.id);
    });

    it("scope violation: response is 200 with systemEnforced:true", async () => {
      await seedBaseData();

      mockGitOutOfScope(["outside/other.ts"], "abc123");

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/out-of-scope",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      expect(res.status).toBe(200);
      expect(res.body.systemEnforced).toBe(true);
      expect(res.body.outOfScopeFiles).toContain("outside/other.ts");
    });

    it("git fetch failure → 422 transient_branch_missing", async () => {
      await seedBaseData();
      mockGitFetchFail();

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/missing-branch",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("TRANSIENT_BRANCH_MISSING");
    });

    it("sha resolve failure → 422 transient_sha_resolve_failed", async () => {
      await seedBaseData();
      mockGitRevParseFail();

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/sha-fail",
        baseBranch: "main",
        scopeGlobs: ["src/**"],
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app)
        .patch(`/api/handoffs/${row.id}/decide`)
        .send({ decision: "accepted" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("TRANSIENT_SHA_RESOLVE_FAILED");
    });
  });

  // ===========================================================================
  // GET /api/issues/:id/handoffs
  // ===========================================================================
  describe("GET /api/issues/:id/handoffs", () => {
    it("lists handoffs for issue in createdAt order", async () => {
      await seedBaseData();

      const now = new Date();
      const earlier = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago
      const later = new Date(now.getTime() - 5 * 60 * 1000);    // 5 min ago

      // Insert two handoffs with different creation times
      await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        updatedAt: now,
        createdAt: earlier,
      } as any);
      await insertHandoff(db, {
        companyId,
        issueId,
        kind: "review",
        status: "pending",
        updatedAt: now,
        createdAt: later,
      } as any);

      const app = await createApp();
      const res = await request(app).get(`/api/issues/${issueId}/handoffs`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
      // First item should be the delegate (older)
      expect(res.body[0].kind).toBe("delegate");
      expect(res.body[1].kind).toBe("review");
    });

    it("returns 404 for unknown issue", async () => {
      await seedBaseData();

      const app = await createApp();
      const res = await request(app).get(`/api/issues/${randomUUID()}/handoffs`);

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // GET /api/handoffs/:id
  // ===========================================================================
  describe("GET /api/handoffs/:id", () => {
    it("returns single handoff", async () => {
      await seedBaseData();

      const row = await insertHandoff(db, {
        companyId,
        issueId,
        kind: "delegate",
        status: "pending",
        branch: "feature/get-test",
        updatedAt: new Date(),
      });

      const app = await createApp();
      const res = await request(app).get(`/api/handoffs/${row.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(row.id);
      expect(res.body.kind).toBe("delegate");
      expect(res.body.branch).toBe("feature/get-test");
    });

    it("returns 404 for unknown handoff", async () => {
      await seedBaseData();

      const app = await createApp();
      const res = await request(app).get(`/api/handoffs/${randomUUID()}`);

      expect(res.status).toBe(404);
    });
  });
});
