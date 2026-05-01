import { and, asc, eq, gte, isNotNull, isNull, lte, sql, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests } from "@paperclipai/db";

const DEFAULT_WINDOW_DAYS = 7;

export interface WakeEventsBaselineOptions {
  since?: Date;
  until?: Date;
}

export interface ByReasonAndTransitionRow {
  wakeReason: string | null;
  priorStatus: string | null;
  postCheckoutStatus: string | null;
  suppressed: boolean;
  count: number;
}

export interface SuppressedRow {
  wakeReason: string | null;
  suppressedReason: string | null;
  count: number;
}

export interface CtxFieldUsageRow {
  ctxFieldUsed: string | null;
  count: number;
}

export interface DeclaredTransitionRow {
  transition: string;
  count: number;
}

export interface HandoffScopeRejectionRow {
  /** ISO date key (YYYY-MM-DD) bucket */
  date: string;
  count: number;
}

export interface WakeEventsBaseline {
  windowStart: string;
  windowEnd: string;
  totalWakes: number;
  /** Wakes where checkout changed the issue status (prior != post). Stage 1 (LIF-382). */
  silentStatusFlips: number;
  /** Declared checkout transitions grouped by kind. Stage 1 follow-up (LIF-384). */
  declaredTransitions: DeclaredTransitionRow[];
  byReasonAndTransition: ByReasonAndTransitionRow[];
  suppressed: SuppressedRow[];
  ctxFieldUsage: CtxFieldUsageRow[];
  /** Stage 2 (LIF-374) AC #2: handoff.auto_rejected events bucketed by UTC day. */
  handoffScopeRejections: HandoffScopeRejectionRow[];
  /** LIF-447: count of wakes where a role pack was rendered (rolePackRendered = true). */
  rolePackRenderedCount: number;
  /** LIF-447: instruction-token P50/P95 across wakes that rendered (excludes nulls). */
  instructionTokensP50: number;
  instructionTokensP95: number;
}

export function wakeEventsBaselineService(db: Db) {
  return {
    getBaseline: async (companyId: string, opts: WakeEventsBaselineOptions = {}): Promise<WakeEventsBaseline> => {
      const until = opts.until ?? new Date();
      const since = opts.since ?? new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const baseWhere = and(
        eq(agentWakeupRequests.companyId, companyId),
        gte(agentWakeupRequests.requestedAt, since),
        lte(agentWakeupRequests.requestedAt, until),
      );

      // Total wakes in window (excluding skipped/coalesced/deferred)
      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(agentWakeupRequests)
        .where(and(baseWhere, isNull(agentWakeupRequests.suppressedReason)));

      // Grouped counters by reason × status transition
      const byReasonRows = await db
        .select({
          wakeReason: agentWakeupRequests.reason,
          priorStatus: agentWakeupRequests.priorIssueStatus,
          postCheckoutStatus: agentWakeupRequests.postCheckoutIssueStatus,
          suppressed: sql<boolean>`(${agentWakeupRequests.suppressedReason} is not null)`,
          count: sql<number>`count(*)`,
        })
        .from(agentWakeupRequests)
        .where(baseWhere)
        .groupBy(
          agentWakeupRequests.reason,
          agentWakeupRequests.priorIssueStatus,
          agentWakeupRequests.postCheckoutIssueStatus,
          agentWakeupRequests.suppressedReason,
        );

      // Suppressed rows grouped by reason + suppressedReason
      const suppressedRows = await db
        .select({
          wakeReason: agentWakeupRequests.reason,
          suppressedReason: agentWakeupRequests.suppressedReason,
          count: sql<number>`count(*)`,
        })
        .from(agentWakeupRequests)
        .where(and(baseWhere, isNotNull(agentWakeupRequests.suppressedReason)))
        .groupBy(agentWakeupRequests.reason, agentWakeupRequests.suppressedReason);

      // ctxFieldUsed usage breakdown
      const ctxUsageRows = await db
        .select({
          ctxFieldUsed: agentWakeupRequests.ctxFieldUsed,
          count: sql<number>`count(*)`,
        })
        .from(agentWakeupRequests)
        .where(baseWhere)
        .groupBy(agentWakeupRequests.ctxFieldUsed);

      // Stage 1 (LIF-382): count wakes where checkout silently changed issue status
      // WITHOUT a declared FSM transition (LIF-390: filter out declared transitions so AC #1 = 0 means
      // every flip went through evaluateCheckout).
      const [{ silentFlips }] = await db
        .select({ silentFlips: sql<number>`count(*)` })
        .from(agentWakeupRequests)
        .where(
          and(
            baseWhere,
            isNotNull(agentWakeupRequests.priorIssueStatus),
            isNotNull(agentWakeupRequests.postCheckoutIssueStatus),
            sql`${agentWakeupRequests.postCheckoutIssueStatus} != ${agentWakeupRequests.priorIssueStatus}`,
            isNull(agentWakeupRequests.declaredTransition),
          ),
        );

      // Stage 1 follow-up (LIF-384): group by declaredTransition so Acceptance #1 is measurable.
      const declaredTransitionRows = await db
        .select({
          transition: agentWakeupRequests.declaredTransition,
          count: sql<number>`count(*)`,
        })
        .from(agentWakeupRequests)
        .where(and(baseWhere, isNotNull(agentWakeupRequests.declaredTransition)))
        .groupBy(agentWakeupRequests.declaredTransition)
        .orderBy(desc(sql<number>`count(*)`));

      // Stage 2 (LIF-374) AC #2: handoff.auto_rejected events bucketed by UTC day.
      const rejectionDayExpr = sql<string>`to_char(${activityLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const rejectionRows = await db
        .select({
          date: rejectionDayExpr,
          count: sql<number>`count(*)`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "handoff.auto_rejected"),
            gte(activityLog.createdAt, since),
            lte(activityLog.createdAt, until),
          ),
        )
        .groupBy(rejectionDayExpr)
        .orderBy(asc(rejectionDayExpr));

      // LIF-447 Stage 3e2: rolePackRenderedCount + instructionTokens percentiles.
      const [{ rolePackRenderedCount }] = await db
        .select({ rolePackRenderedCount: sql<number>`count(*)` })
        .from(agentWakeupRequests)
        .where(and(baseWhere, eq(agentWakeupRequests.rolePackRendered, true)));

      const tokenPercentileRows = await db.execute<{ p50: number | null; p95: number | null }>(sql`
        select
          percentile_cont(0.5) within group (order by instruction_tokens) as p50,
          percentile_cont(0.95) within group (order by instruction_tokens) as p95
        from agent_wakeup_requests
        where company_id = ${companyId}
          and requested_at >= ${since.toISOString()}::timestamptz
          and requested_at <= ${until.toISOString()}::timestamptz
          and instruction_tokens is not null
      `);
      const tokenPercentiles = (tokenPercentileRows as unknown as Array<{ p50: number | null; p95: number | null }>)[0] ?? null;

      return {
        windowStart: since.toISOString(),
        windowEnd: until.toISOString(),
        totalWakes: Number(total ?? 0),
        silentStatusFlips: Number(silentFlips ?? 0),
        declaredTransitions: declaredTransitionRows.map((row) => ({
          transition: row.transition ?? "",
          count: Number(row.count),
        })),
        byReasonAndTransition: byReasonRows.map((row) => ({
          wakeReason: row.wakeReason ?? null,
          priorStatus: row.priorStatus ?? null,
          postCheckoutStatus: row.postCheckoutStatus ?? null,
          suppressed: Boolean(row.suppressed),
          count: Number(row.count),
        })),
        suppressed: suppressedRows.map((row) => ({
          wakeReason: row.wakeReason ?? null,
          suppressedReason: row.suppressedReason ?? null,
          count: Number(row.count),
        })),
        ctxFieldUsage: ctxUsageRows.map((row) => ({
          ctxFieldUsed: row.ctxFieldUsed ?? null,
          count: Number(row.count),
        })),
        handoffScopeRejections: rejectionRows.map((row) => ({
          date: row.date,
          count: Number(row.count),
        })),
        rolePackRenderedCount: Number(rolePackRenderedCount ?? 0),
        instructionTokensP50: Number(tokenPercentiles?.p50 ?? 0),
        instructionTokensP95: Number(tokenPercentiles?.p95 ?? 0),
      };
    },
  };
}
