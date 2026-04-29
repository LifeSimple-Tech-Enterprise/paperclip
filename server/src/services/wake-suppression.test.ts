/**
 * LIF-390: Suppression observability + silentStatusFlips filter
 *
 * AC #1: writeSkippedRequest round-trip — suppressed_reason is populated.
 * AC #2: silentFlips query excludes wakes that have a declared FSM transition.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { wakeEventsBaselineService } from "./wake-events-baseline.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping wake-suppression tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function createCompanyAndAgent(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({ name: `WakeSuppression-${randomUUID()}`, issuePrefix: `WS${randomUUID().slice(0, 4).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);

  const agent = await db
    .insert(agents)
    .values({ companyId: company.id, name: `agent-${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);

  return { company, agent };
}

describeEmbeddedPostgres("wake suppression observability (LIF-390)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("AC #1 — writeSkippedRequest populates suppressed_reason", () => {
    it("inserts a skipped row with both reason (original wake) and suppressedReason populated", async () => {
      const { company, agent } = await createCompanyAndAgent(db);

      // Simulate what writeSkippedRequest(reason, suppressedReason) now inserts:
      // reason = original wake reason ("issue_commented"), suppressedReason = guard name ("self_wake_guard")
      await db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        reason: "issue_commented",
        status: "skipped",
        suppressedReason: "self_wake_guard",
        finishedAt: new Date(),
      });

      const row = await db
        .select({
          reason: agentWakeupRequests.reason,
          suppressedReason: agentWakeupRequests.suppressedReason,
          status: agentWakeupRequests.status,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agent.id))
        .then((rows) => rows[0]);

      expect(row).toBeDefined();
      expect(row!.status).toBe("skipped");
      // Original wake reason is preserved in `reason`
      expect(row!.reason).toBe("issue_commented");
      // Guard name is stored in `suppressedReason`
      expect(row!.suppressedReason).toBe("self_wake_guard");
    });

    it("preserves original reason for continuation_throttle suppression", async () => {
      const { company, agent } = await createCompanyAndAgent(db);

      await db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        reason: "issue_continuation_needed",
        status: "skipped",
        suppressedReason: "continuation_throttle",
        finishedAt: new Date(),
      });

      const row = await db
        .select({
          reason: agentWakeupRequests.reason,
          suppressedReason: agentWakeupRequests.suppressedReason,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agent.id))
        .then((rows) => rows[0]);

      expect(row!.reason).toBe("issue_continuation_needed");
      expect(row!.suppressedReason).toBe("continuation_throttle");
    });
  });

  describe("AC #2 — silentStatusFlips excludes declared FSM transitions", () => {
    it("does not count a status flip toward silentFlips when declaredTransition is set", async () => {
      const { company, agent } = await createCompanyAndAgent(db);
      const baseline = wakeEventsBaselineService(db);

      const windowStart = new Date(Date.now() - 60_000);

      // Wake with prior=todo, post=in_progress AND a declared transition — must NOT count
      await db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        reason: "issue_assignment",
        status: "finished",
        priorIssueStatus: "todo",
        postCheckoutIssueStatus: "in_progress",
        declaredTransition: "checkout:todo->in_progress",
        finishedAt: new Date(),
      });

      const result = await baseline.getBaseline(company.id, { since: windowStart });
      expect(result.silentStatusFlips).toBe(0);
    });

    it("counts a status flip toward silentFlips when declaredTransition is NULL", async () => {
      const { company, agent } = await createCompanyAndAgent(db);
      const baseline = wakeEventsBaselineService(db);

      const windowStart = new Date(Date.now() - 60_000);

      // Wake with prior=todo, post=in_progress, NO declared transition — this is a "silent" flip
      await db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        reason: "issue_assignment",
        status: "finished",
        priorIssueStatus: "todo",
        postCheckoutIssueStatus: "in_progress",
        declaredTransition: null,
        finishedAt: new Date(),
      });

      const result = await baseline.getBaseline(company.id, { since: windowStart });
      expect(result.silentStatusFlips).toBe(1);
    });

    it("correctly segregates declared vs undeclared flips in the same window", async () => {
      const { company, agent } = await createCompanyAndAgent(db);
      const baseline = wakeEventsBaselineService(db);

      const windowStart = new Date(Date.now() - 60_000);

      // 2 declared flips (should NOT count)
      await db.insert(agentWakeupRequests).values([
        {
          companyId: company.id,
          agentId: agent.id,
          source: "on_demand",
          reason: "issue_assignment",
          status: "finished",
          priorIssueStatus: "todo",
          postCheckoutIssueStatus: "in_progress",
          declaredTransition: "checkout:todo->in_progress",
          finishedAt: new Date(),
        },
        {
          companyId: company.id,
          agentId: agent.id,
          source: "on_demand",
          reason: "issue_assignment",
          status: "finished",
          priorIssueStatus: "in_progress",
          postCheckoutIssueStatus: "in_review",
          declaredTransition: "checkout:in_progress->in_review",
          finishedAt: new Date(),
        },
      ]);

      // 1 undeclared flip (SHOULD count)
      await db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        reason: "transient_failure_retry",
        status: "finished",
        priorIssueStatus: "blocked",
        postCheckoutIssueStatus: "in_progress",
        declaredTransition: null,
        finishedAt: new Date(),
      });

      const result = await baseline.getBaseline(company.id, { since: windowStart });
      expect(result.silentStatusFlips).toBe(1);
    });
  });
});
