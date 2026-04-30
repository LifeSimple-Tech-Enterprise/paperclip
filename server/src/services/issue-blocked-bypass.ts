import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";

/**
 * LIF-375 Stage 3a — bypass service for forcing an issue to status='blocked'
 * from the infra-error hook.
 *
 * Why a raw `UPDATE` instead of going through `issuesService.updateIssue`:
 *  - The hook is reacting to an agent that just received its Nth 422/409. The
 *    normal status FSM rejects status writes from agent actors (rightly so), so
 *    we must side-step the FSM with a server-system mutation.
 *  - We still want this to be auditable: every flip writes one row to
 *    `activity_log` with `actorType='system'` + a structured `details` payload
 *    so investigators can trace why an issue went blocked.
 *
 * The UPDATE is conditional (`status NOT IN ('blocked','done','cancelled')`) so
 * that issues already in a terminal/blocked state do not double-block. Callers
 * MUST gate side-effects (system comments, live events) on `result.changed`,
 * matching the rev-22 `rowCount > 0` contract.
 *
 * Documented in `paperclip/docs/internal/local-board-scope.md`.
 */
export interface BypassBlockResult {
  changed: boolean;
}

export interface BypassBlockInput {
  issueId: string;
  companyId: string;
  /** Stable tag describing why the bypass fired (`infra_error_loop`, etc.). */
  reason: string;
  /** Free-form structured context written into the activity log. */
  details: Record<string, unknown>;
}

export function issueBlockedBypassService(db: Db) {
  return {
    /**
     * Force an issue to status='blocked' if it is currently active. Skips when
     * the issue is already blocked / done / cancelled (returns `changed:false`,
     * which the caller MUST honour by suppressing follow-up comments).
     */
    async forceBlock(input: BypassBlockInput): Promise<BypassBlockResult> {
      const result = await db.execute(sql`
        UPDATE issues
        SET status = 'blocked', updated_at = now()
        WHERE id = ${input.issueId}
          AND status NOT IN ('blocked', 'done', 'cancelled')
      `);

      // drizzle's pg result objects expose rowCount on .rowCount or .count
      const rowCount =
        (result as unknown as { rowCount?: number }).rowCount ??
        (result as unknown as { count?: number }).count ??
        0;
      const changed = rowCount > 0;

      if (changed) {
        await db.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "system",
          actorId: "infra_error_hook",
          action: "issue.blocked.bypass",
          entityType: "issue",
          entityId: input.issueId,
          details: { ...input.details, reason: input.reason, bypass: true },
        });
      }

      return { changed };
    },
  };
}

export type IssueBlockedBypassService = ReturnType<typeof issueBlockedBypassService>;
