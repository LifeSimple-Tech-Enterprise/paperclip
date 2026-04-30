import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * LIF-375 Stage 3a — agent_action_attempts (UNLOGGED).
 *
 * Tracks repeated 422/409 attempts an agent makes against the same issue/route.
 * UPSERTed when an agent receives 422/409; awaited DELETE on 2xx; cron-swept
 * after 24h of inactivity; cleared when an issue unblocks.
 *
 * The table is **UNLOGGED**: it loses all rows on PostgreSQL crash. This is
 * intentional — the data is purely a recovery hint, not a system of record.
 * See `paperclip/docs/internal/local-board-scope.md` for the crash semantics
 * we depend on.
 */
export const agentActionAttempts = pgTable(
  "agent_action_attempts",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    method: text("method").notNull(),
    path: text("path").notNull(),
    attempts: integer("attempts").notNull().default(1),
    lastStatus: integer("last_status").notNull(),
    lastCode: text("last_code"),
    lastMessage: text("last_message"),
    lastPayloadCapture: text("last_payload_capture"),
    extra: jsonb("extra").$type<Record<string, unknown>>(),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.agentId, table.issueId, table.method, table.path] }),
    lastAtIdx: index("agent_action_attempts_last_at_idx").on(table.lastAt),
    issueIdx: index("agent_action_attempts_issue_idx").on(table.issueId),
  }),
);
