import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
