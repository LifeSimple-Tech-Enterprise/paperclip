import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    kind: text("kind").notNull(), // 'delegate' | 'review' | 'acceptance'
    status: text("status").notNull().default("pending"), // 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'merged'
    fromAgentId: uuid("from_agent_id").references(() => agents.id),
    toAgentId: uuid("to_agent_id").references(() => agents.id),
    scopeGlobs: jsonb("scope_globs").$type<string[]>(),
    contract: text("contract"),
    branch: text("branch"),
    baseBranch: text("base_branch"),
    verifiedSha: text("verified_sha"),
    decision: text("decision"), // 'accepted' | 'rejected'
    decisionReason: text("decision_reason"),
    parentHandoffId: uuid("parent_handoff_id").references((): AnyPgColumn => handoffs.id),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedSha: text("merged_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("handoffs_company_issue_idx").on(table.companyId, table.issueId),
    toAgentIdx: index("handoffs_to_agent_idx").on(table.toAgentId),
    parentIdx: index("handoffs_parent_idx").on(table.parentHandoffId),
    unmergedReviewsIdx: index("handoffs_unmerged_reviews_idx")
      .on(table.issueId, table.kind, table.status)
      .where(sql`merged_at IS NULL`),
    companyIssueIdempotencyUq: uniqueIndex("handoffs_company_issue_idempotency_uq")
      .on(table.companyId, table.issueId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);
