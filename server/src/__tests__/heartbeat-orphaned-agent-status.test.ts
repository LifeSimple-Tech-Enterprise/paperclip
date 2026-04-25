import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphaned-agent-status tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileOrphanedAgentStatus", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-orphaned-agent-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndAgent(opts: { agentStatus?: string; updatedAtOffset?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const updatedAt = opts.updatedAtOffset != null
      ? new Date(Date.now() - opts.updatedAtOffset)
      : new Date(Date.now() - 60 * 60 * 1000); // default 1h ago

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: opts.agentStatus ?? "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      updatedAt,
    });

    return { companyId, agentId };
  }

  it("case a: reconciles agent.status='running' with no live runs past staleness threshold", async () => {
    // Agent stuck running for 1 hour, no heartbeat_runs rows at all.
    const { agentId } = await insertCompanyAndAgent({ agentStatus: "running", updatedAtOffset: 60 * 60 * 1000 });

    const heartbeat = heartbeatService(db as any);
    const result = await heartbeat.reconcileOrphanedAgentStatus({ staleThresholdMs: 10 * 60 * 1000 });

    expect(result.reconciled).toBe(1);
    expect(result.agentIds).toContain(agentId);

    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("idle");
  });

  it("case b: does NOT reconcile agent.status='running' that has a live running heartbeat_run", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent({ agentStatus: "running", updatedAtOffset: 60 * 60 * 1000 });

    // Insert an active run for this agent.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date(),
      nextAction: "continue",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db as any);
    const result = await heartbeat.reconcileOrphanedAgentStatus({ staleThresholdMs: 10 * 60 * 1000 });

    expect(result.reconciled).toBe(0);
    expect(result.agentIds).not.toContain(agentId);

    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("running");
  });

  it("case c: does NOT reconcile agent.status='running' within the staleness threshold window", async () => {
    // Agent updated 30 seconds ago — well within 10 min threshold. Must not be touched.
    const { agentId } = await insertCompanyAndAgent({ agentStatus: "running", updatedAtOffset: 30 * 1000 });

    const heartbeat = heartbeatService(db as any);
    const result = await heartbeat.reconcileOrphanedAgentStatus({ staleThresholdMs: 10 * 60 * 1000 });

    expect(result.reconciled).toBe(0);

    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("running");
  });
});
