import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

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

export interface WakeEventsBaseline {
  windowStart: string;
  windowEnd: string;
  totalWakes: number;
  byReasonAndTransition: ByReasonAndTransitionRow[];
  suppressed: SuppressedRow[];
  ctxFieldUsage: CtxFieldUsageRow[];
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

      return {
        windowStart: since.toISOString(),
        windowEnd: until.toISOString(),
        totalWakes: Number(total ?? 0),
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
      };
    },
  };
}
