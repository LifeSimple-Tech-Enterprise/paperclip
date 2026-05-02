import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { wakeEventsBaselineService } from "../services/wake-events-baseline.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping wake-events-baseline tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function seedCompany(db: ReturnType<typeof createDb>) {
  const [company] = await db
    .insert(companies)
    .values({
      name: `Test-${randomUUID()}`,
      issuePrefix: `T${randomUUID().slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    })
    .returning();
  return company!;
}

async function seedAgent(db: ReturnType<typeof createDb>, companyId: string) {
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      name: `Agent-${randomUUID().slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning();
  return agent!;
}

function insertWakeRow(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  requestedAt: Date,
  opts: {
    rolePackRendered?: boolean | null;
    instructionTokens?: number | null;
    priorIssueStatus?: string | null;
    finalIssueStatus?: string | null;
    suppressedReason?: string | null;
  } = {},
) {
  return db.insert(agentWakeupRequests).values({
    companyId,
    agentId,
    source: "test",
    status: "done",
    requestedAt,
    rolePackRendered: opts.rolePackRendered ?? null,
    instructionTokens: opts.instructionTokens ?? null,
    priorIssueStatus: opts.priorIssueStatus ?? null,
    finalIssueStatus: opts.finalIssueStatus ?? null,
    suppressedReason: opts.suppressedReason ?? null,
  });
}

function insertRejection(
  db: ReturnType<typeof createDb>,
  companyId: string,
  createdAt: Date,
) {
  return db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "system",
    action: "handoff.auto_rejected",
    entityType: "handoff",
    entityId: randomUUID(),
    createdAt,
  });
}

describeEmbeddedPostgres("wakeEventsBaselineService — rolePackRenderedCount + instructionTokens percentiles (LIF-447)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-events-lif447-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns zeros when no wakes in window", async () => {
    const company = await seedCompany(db);
    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, {
      since: new Date("2026-04-01T00:00:00.000Z"),
      until: new Date("2026-04-07T23:59:59.999Z"),
    });
    expect(result.rolePackRenderedCount).toBe(0);
    expect(result.instructionTokensP50).toBe(0);
    expect(result.instructionTokensP95).toBe(0);
  });

  it("counts only wakes where rolePackRendered = true", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-10T00:00:00.000Z");
    const until = new Date("2026-04-10T23:59:59.999Z");
    const at = new Date("2026-04-10T12:00:00.000Z");

    await insertWakeRow(db, company.id, agent.id, at, { rolePackRendered: true, instructionTokens: 100 });
    await insertWakeRow(db, company.id, agent.id, at, { rolePackRendered: true, instructionTokens: 200 });
    await insertWakeRow(db, company.id, agent.id, at, { rolePackRendered: false, instructionTokens: 50 });
    await insertWakeRow(db, company.id, agent.id, at, { rolePackRendered: null, instructionTokens: null });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.rolePackRenderedCount).toBe(2);
  });

  it("computes P50 and P95 over non-null instruction_tokens only", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-11T00:00:00.000Z");
    const until = new Date("2026-04-11T23:59:59.999Z");
    const at = new Date("2026-04-11T12:00:00.000Z");

    // Seed 5 rows with known tokens: 100, 200, 300, 400, 500
    // P50 = 300, P95 = 500 (with continuous interpolation over 5 values)
    for (const tokens of [100, 200, 300, 400, 500]) {
      await insertWakeRow(db, company.id, agent.id, at, { rolePackRendered: true, instructionTokens: tokens });
    }
    // One null row — should not affect percentile
    await insertWakeRow(db, company.id, agent.id, at, { rolePackRendered: null, instructionTokens: null });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    // percentile_cont(0.5) over [100,200,300,400,500] = 300
    expect(result.instructionTokensP50).toBe(300);
    // percentile_cont(0.95) over [100,200,300,400,500] ≈ 480
    expect(result.instructionTokensP95).toBeGreaterThanOrEqual(400);
    expect(result.instructionTokensP95).toBeLessThanOrEqual(500);
  });

  it("excludes wakes outside the time window", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-12T00:00:00.000Z");
    const until = new Date("2026-04-12T23:59:59.999Z");

    // In window
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-12T06:00:00.000Z"), { rolePackRendered: true, instructionTokens: 400 });
    // Before window
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-11T23:59:00.000Z"), { rolePackRendered: true, instructionTokens: 1000 });
    // After window
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-13T00:00:01.000Z"), { rolePackRendered: true, instructionTokens: 1000 });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.rolePackRenderedCount).toBe(1);
    expect(result.instructionTokensP50).toBe(400);
  });
});

describeEmbeddedPostgres("wakeEventsBaselineService — handoffScopeRejections (LIF-374 AC #2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-events-baseline-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns empty handoffScopeRejections array when no events in window", async () => {
    const company = await seedCompany(db);
    const since = new Date("2026-04-01T00:00:00.000Z");
    const until = new Date("2026-04-07T23:59:59.999Z");

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.handoffScopeRejections).toEqual([]);
  });

  it("bucketizes handoff.auto_rejected events by UTC day, ascending", async () => {
    const company = await seedCompany(db);
    const since = new Date("2026-04-10T00:00:00.000Z");
    const until = new Date("2026-04-12T23:59:59.999Z");

    // 2 events on day 10, 3 events on day 12, 1 event on day 11
    await insertRejection(db, company.id, new Date("2026-04-10T08:00:00.000Z"));
    await insertRejection(db, company.id, new Date("2026-04-10T16:00:00.000Z"));
    await insertRejection(db, company.id, new Date("2026-04-11T12:00:00.000Z"));
    await insertRejection(db, company.id, new Date("2026-04-12T09:00:00.000Z"));
    await insertRejection(db, company.id, new Date("2026-04-12T14:00:00.000Z"));
    await insertRejection(db, company.id, new Date("2026-04-12T22:00:00.000Z"));

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.handoffScopeRejections).toEqual([
      { date: "2026-04-10", count: 2 },
      { date: "2026-04-11", count: 1 },
      { date: "2026-04-12", count: 3 },
    ]);
  });

  it("respects since/until window — events outside window are excluded", async () => {
    const company = await seedCompany(db);
    const since = new Date("2026-04-20T00:00:00.000Z");
    const until = new Date("2026-04-21T23:59:59.999Z");

    // Event before window
    await insertRejection(db, company.id, new Date("2026-04-19T23:59:59.999Z"));
    // Event in window
    await insertRejection(db, company.id, new Date("2026-04-20T10:00:00.000Z"));
    // Event after window
    await insertRejection(db, company.id, new Date("2026-04-22T00:00:00.000Z"));

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.handoffScopeRejections).toHaveLength(1);
    expect(result.handoffScopeRejections[0]).toEqual({ date: "2026-04-20", count: 1 });
  });
});

describeEmbeddedPostgres("wakeEventsBaselineService — completionRate (LIF-448)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-events-lif448-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns { numerator: 0, denominator: 0, ratio: 0 } when no wakes in window", async () => {
    const company = await seedCompany(db);
    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, {
      since: new Date("2026-04-01T00:00:00.000Z"),
      until: new Date("2026-04-07T23:59:59.999Z"),
    });
    expect(result.completionRate).toEqual({ numerator: 0, denominator: 0, ratio: 0 });
  });

  it("counts only wakes with priorIssueStatus in todo/in_progress in denominator", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-13T00:00:00.000Z");
    const until = new Date("2026-04-13T23:59:59.999Z");
    const at = new Date("2026-04-13T12:00:00.000Z");

    // Qualifies for denominator
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "in_progress" });
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "in_progress", finalIssueStatus: "in_progress" });
    // Does not qualify (prior is blocked/done/null)
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "blocked", finalIssueStatus: "done" });
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "done", finalIssueStatus: "done" });
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: null, finalIssueStatus: "done" });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.completionRate.denominator).toBe(2);
    expect(result.completionRate.numerator).toBe(0);
    expect(result.completionRate.ratio).toBe(0);
  });

  it("counts only wakes with finalIssueStatus in done/in_review in numerator", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-14T00:00:00.000Z");
    const until = new Date("2026-04-14T23:59:59.999Z");
    const at = new Date("2026-04-14T12:00:00.000Z");

    // Numerator: done
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "done" });
    // Numerator: in_review
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "in_review" });
    // Denominator only: final is in_progress (not done/in_review)
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "in_progress", finalIssueStatus: "in_progress" });
    // Denominator only: final is null (instrumentation not yet present)
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: null });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.completionRate.denominator).toBe(4);
    expect(result.completionRate.numerator).toBe(2);
    expect(result.completionRate.ratio).toBe(0.5);
  });

  it("excludes suppressed wakes from both numerator and denominator", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-15T00:00:00.000Z");
    const until = new Date("2026-04-15T23:59:59.999Z");
    const at = new Date("2026-04-15T12:00:00.000Z");

    // Counts: prior=todo, not suppressed
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "done" });
    // Suppressed — must be excluded even if finalIssueStatus = done
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "done", suppressedReason: "coalesced" });
    // Suppressed — must be excluded from denominator too
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "in_progress", finalIssueStatus: "in_progress", suppressedReason: "deferred" });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.completionRate.denominator).toBe(1);
    expect(result.completionRate.numerator).toBe(1);
    expect(result.completionRate.ratio).toBe(1);
  });

  it("excludes wakes outside the time window", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-16T00:00:00.000Z");
    const until = new Date("2026-04-16T23:59:59.999Z");

    // In window — counts
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-16T12:00:00.000Z"), { priorIssueStatus: "todo", finalIssueStatus: "done" });
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-16T12:00:00.000Z"), { priorIssueStatus: "in_progress", finalIssueStatus: "in_progress" });
    // Before window — excluded
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-15T23:59:59.000Z"), { priorIssueStatus: "todo", finalIssueStatus: "done" });
    // After window — excluded
    await insertWakeRow(db, company.id, agent.id, new Date("2026-04-17T00:00:01.000Z"), { priorIssueStatus: "todo", finalIssueStatus: "done" });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.completionRate.denominator).toBe(2);
    expect(result.completionRate.numerator).toBe(1);
    expect(result.completionRate.ratio).toBe(0.5);
  });

  it("computes ratio correctly for 2/4 = 0.5", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const since = new Date("2026-04-17T00:00:00.000Z");
    const until = new Date("2026-04-17T23:59:59.999Z");
    const at = new Date("2026-04-17T12:00:00.000Z");

    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "done" });
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "todo", finalIssueStatus: "in_review" });
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "in_progress", finalIssueStatus: "in_progress" });
    await insertWakeRow(db, company.id, agent.id, at, { priorIssueStatus: "in_progress", finalIssueStatus: null });

    const svc = wakeEventsBaselineService(db);
    const result = await svc.getBaseline(company.id, { since, until });

    expect(result.completionRate.denominator).toBe(4);
    expect(result.completionRate.numerator).toBe(2);
    expect(result.completionRate.ratio).toBe(0.5);
  });
});
