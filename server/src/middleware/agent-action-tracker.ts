import type { Request, Response, NextFunction, RequestHandler } from "express";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentActionAttempts,
  issueComments,
  issues,
} from "@paperclipai/db";
import { redactCurrentUserText } from "../log-redaction.js";
import { logger } from "./logger.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";
import {
  issueBlockedBypassService,
  type IssueBlockedBypassService,
} from "../services/issue-blocked-bypass.js";

// ---------------------------------------------------------------------------
// LIF-375 Stage 3a (rev 26) — agent_action_attempts tracker.
//
// `buildTrackerKey` is the **board-supplied verbatim** rev-26 key builder. Any
// edits to this regex MUST be synchronised with the plan and the regression
// tests below. Two correctness bugs from rev 25 are locked in:
//
//   1. `\b<id>\b` was matching inside `/api/export-LIF-375/`. Replaced with
//      slash-anchored lookarounds `(?<=^|/)<id>(?=/|$)`.
//   2. The first-id-wins fallback was capturing workspace-uuid on nested routes
//      like `/api/workspaces/<uuid>/issues/LIF-375`. Now the `EXPLICIT_ISSUE_PATTERN`
//      checks for `/issues/...` or `/issue-thread-interactions/...` first and
//      only falls back to the global match when no explicit prefix hits.
// ---------------------------------------------------------------------------

const ID_CORE = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Z]{2,6}-\\d+)";
const GLOBAL_ID_PATTERN = new RegExp(`(?<=^|\\/)${ID_CORE}(?=\\/|$)`, "g");
const EXPLICIT_ISSUE_PATTERN = new RegExp(`\\/(?:issues|issue-thread-interactions)\\/${ID_CORE}`);

export function normalizeAgentPath(rawPath: string): string {
  return rawPath.replace(GLOBAL_ID_PATTERN, ":id");
}

export interface TrackerKey {
  companyId: string;
  agentId: string;
  issueId: string;
  method: string;
  path: string;
}

export function buildTrackerKey(req: Request): TrackerKey | null {
  if (req.actor?.type !== "agent") return null;
  const { companyId, agentId } = req.actor;

  const rawPath = req.originalUrl.split("?")[0];

  // Prioritized extraction: explicit issue prefix wins over first-id fallback.
  const explicitMatch = rawPath.match(EXPLICIT_ISSUE_PATTERN);
  const fallbackMatch = rawPath.match(GLOBAL_ID_PATTERN);
  const issueId = explicitMatch?.[1] ?? fallbackMatch?.[0] ?? null;

  const normalizedPath = normalizeAgentPath(rawPath);

  if (!companyId || !agentId || !issueId) return null;
  return { companyId, agentId, issueId, method: req.method, path: normalizedPath };
}

// ---------------------------------------------------------------------------
// Bounded payload capture (rev 22 / rev 26).
// ---------------------------------------------------------------------------

const PAYLOAD_CAPTURE_MAX = 500;
const TRUNCATION_SUFFIX = "…[truncated]";

function boundedReplacer(maxStringLen = 200): (key: string, value: unknown) => unknown {
  // Keep payloads from blowing up — flatten huge strings + drop binary buffers.
  return (_key, value) => {
    if (typeof value === "string" && value.length > maxStringLen) {
      return `${value.slice(0, maxStringLen)}…`;
    }
    if (value && typeof value === "object" && (value as { type?: string }).type === "Buffer") {
      return "[Buffer]";
    }
    return value;
  };
}

export function captureRequestBody(body: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(body ?? {}, boundedReplacer());
  } catch {
    serialized = "[unserialisable]";
  }
  const redacted = redactCurrentUserText(serialized);
  if (redacted.length <= PAYLOAD_CAPTURE_MAX) return redacted;
  return `${redacted.slice(0, PAYLOAD_CAPTURE_MAX - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Comm-vs-non-comm template differentiation (rev 22 / rev 26).
//
// Communication routes (comments, issue-thread-interactions) get a softer
// template: the agent's message is fine, but the *content* needs revision.
// Non-comm routes (issue mutations, handoff creation, FSM transitions) get a
// harsher template: the agent should stop looping, change strategy, or escalate.
// ---------------------------------------------------------------------------

const COMM_PATH_RE = /\/(comments|interactions|issue-thread-interactions)(\b|\/)/;

export function isCommunicationPath(normalizedPath: string): boolean {
  return COMM_PATH_RE.test(normalizedPath);
}

function buildBypassCommentBody(input: {
  attempts: number;
  isComm: boolean;
  method: string;
  path: string;
  lastStatus: number;
  lastCode: string | null;
  lastMessage: string | null;
  payloadCapture: string | null;
}): string {
  const header = input.isComm
    ? `Auto-blocking issue: agent retried the same comm action ${input.attempts}× without change.`
    : `Auto-blocking issue: agent looped on the same action ${input.attempts}× — strategy is not converging.`;
  const advice = input.isComm
    ? "Re-read recent comments + the latest decision; rephrase the message body or pick a different recipient."
    : "Re-read the route contract + the structured `code` on each rejection; either change the request shape, escalate to manager, or mark the issue blocked with a reason.";

  const lines = [
    header,
    "",
    `Last action: \`${input.method} ${input.path}\` → HTTP ${input.lastStatus}${input.lastCode ? ` (${input.lastCode})` : ""}`,
    input.lastMessage ? `Last server message: ${input.lastMessage}` : null,
    input.payloadCapture ? `Last payload (truncated): \`${input.payloadCapture}\`` : null,
    "",
    advice,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 410 + WAKE_TERMINATED — terminal; do not track.
// 413 PAYLOAD_TOO_LARGE — terminal; do not track (the same body cannot succeed).
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<number>([410, 413]);

interface TrackingDecision {
  action: "increment" | "delete" | "ignore";
  status: number;
  code: string | null;
  message: string | null;
}

function classify(statusCode: number, envelope: ResponseEnvelope | null): TrackingDecision {
  if (statusCode >= 200 && statusCode < 300) {
    return { action: "delete", status: statusCode, code: null, message: null };
  }
  if (TERMINAL_STATUSES.has(statusCode)) {
    return { action: "ignore", status: statusCode, code: envelope?.code ?? null, message: envelope?.error ?? null };
  }
  if (statusCode === 410 && envelope?.code === "WAKE_TERMINATED") {
    return { action: "ignore", status: statusCode, code: envelope.code, message: envelope.error ?? null };
  }
  if (statusCode === 422 || statusCode === 409) {
    return { action: "increment", status: statusCode, code: envelope?.code ?? null, message: envelope?.error ?? null };
  }
  return { action: "ignore", status: statusCode, code: envelope?.code ?? null, message: envelope?.error ?? null };
}

interface ResponseEnvelope {
  error?: string;
  code?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Tracker middleware factory.
// ---------------------------------------------------------------------------

export interface AgentActionTrackerOptions {
  /** Default: 5. Number of repeated attempts before forceBlock fires. */
  blockThreshold?: number;
  /** Default: from INFRA_ERROR_AUTO_BLOCK_ENABLED env (false). */
  autoBlockEnabled?: boolean;
}

export function agentActionTrackerMiddleware(
  db: Db,
  opts: AgentActionTrackerOptions = {},
): RequestHandler {
  const blockThreshold = opts.blockThreshold ?? 5;
  const autoBlockEnabled =
    opts.autoBlockEnabled ?? process.env.INFRA_ERROR_AUTO_BLOCK_ENABLED === "1";
  const bypass = issueBlockedBypassService(db);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = buildTrackerKey(req);
    if (!key) {
      next();
      return;
    }

    // Capture the response envelope by overriding `res.json` (no read-after-send
    // on res.body — Express does not buffer responses).
    let envelope: ResponseEnvelope | null = null;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (body && typeof body === "object") {
        envelope = body as ResponseEnvelope;
      }
      return originalJson(body);
    }) as typeof res.json;

    // Capture body BEFORE the route handler may have mutated/cleared req.body.
    const payloadCapture = captureRequestBody(req.body);

    res.on("finish", () => {
      const decision = classify(res.statusCode, envelope);
      void handleDecision({
        db,
        bypass,
        key,
        decision,
        payloadCapture,
        autoBlockEnabled,
        blockThreshold,
      }).catch((err) => {
        logger.error({ err, trackerKey: key }, "agent_action_attempts tracker failed");
      });
    });

    next();
  };
}

async function handleDecision(args: {
  db: Db;
  bypass: IssueBlockedBypassService;
  key: TrackerKey;
  decision: TrackingDecision;
  payloadCapture: string;
  autoBlockEnabled: boolean;
  blockThreshold: number;
}): Promise<void> {
  const { db, bypass, key, decision, payloadCapture, autoBlockEnabled, blockThreshold } = args;
  if (decision.action === "ignore") return;

  if (decision.action === "delete") {
    await db
      .delete(agentActionAttempts)
      .where(
        and(
          eq(agentActionAttempts.companyId, key.companyId),
          eq(agentActionAttempts.agentId, key.agentId),
          eq(agentActionAttempts.issueId, key.issueId),
          eq(agentActionAttempts.method, key.method),
          eq(agentActionAttempts.path, key.path),
        ),
      );
    return;
  }

  // increment
  const now = new Date();
  const upsertResult = await db
    .insert(agentActionAttempts)
    .values({
      companyId: key.companyId,
      agentId: key.agentId,
      issueId: key.issueId,
      method: key.method,
      path: key.path,
      attempts: 1,
      lastStatus: decision.status,
      lastCode: decision.code,
      lastMessage: decision.message,
      lastPayloadCapture: payloadCapture,
      firstAt: now,
      lastAt: now,
    })
    .onConflictDoUpdate({
      target: [
        agentActionAttempts.companyId,
        agentActionAttempts.agentId,
        agentActionAttempts.issueId,
        agentActionAttempts.method,
        agentActionAttempts.path,
      ],
      set: {
        attempts: sql`${agentActionAttempts.attempts} + 1`,
        lastStatus: decision.status,
        lastCode: decision.code,
        lastMessage: decision.message,
        lastPayloadCapture: payloadCapture,
        lastAt: now,
      },
    })
    .returning({ attempts: agentActionAttempts.attempts });

  const attempts = upsertResult[0]?.attempts ?? 1;
  if (!autoBlockEnabled) return;
  if (attempts < blockThreshold) return;

  // Threshold tripped → bypass-block + (gated) system comment + live event.
  const blockResult = await bypass.forceBlock({
    issueId: key.issueId,
    companyId: key.companyId,
    reason: "infra_error_loop",
    details: {
      method: key.method,
      path: key.path,
      attempts,
      lastStatus: decision.status,
      lastCode: decision.code,
      agentId: key.agentId,
    },
  });

  if (!blockResult.changed) return; // rev-22 rowCount > 0 gate

  const isComm = isCommunicationPath(key.path);
  const body = buildBypassCommentBody({
    attempts,
    isComm,
    method: key.method,
    path: key.path,
    lastStatus: decision.status,
    lastCode: decision.code,
    lastMessage: decision.message,
    payloadCapture,
  });

  await db.insert(issueComments).values({
    companyId: key.companyId,
    issueId: key.issueId,
    authorAgentId: null,
    authorUserId: null,
    body,
    metadata: {
      kind: "infra_error_auto_block",
      attempts,
      method: key.method,
      path: key.path,
      lastStatus: decision.status,
      lastCode: decision.code,
      template: isComm ? "comm" : "non_comm",
    },
  });

  publishGlobalLiveEvent({
    type: "activity.logged",
    payload: {
      issueId: key.issueId,
      kind: "infra_error_auto_block",
      attempts,
      method: key.method,
      path: key.path,
    },
  });
}

// ---------------------------------------------------------------------------
// Sweepers.
// ---------------------------------------------------------------------------

/**
 * 24h cron sweep — drop stale tracker rows so a row from days ago doesn't
 * cause a sudden bypass when the agent finally retries the same action.
 */
export async function sweepStaleAgentActionAttempts(
  db: Db,
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const result = await db
    .delete(agentActionAttempts)
    .where(lt(agentActionAttempts.lastAt, cutoff));
  const deleted =
    (result as unknown as { rowCount?: number }).rowCount ??
    (result as unknown as { count?: number }).count ??
    0;
  return { deleted };
}

/**
 * Clear all tracker rows for an issue when it transitions out of `blocked`.
 * Used by the heartbeat status writer to give an unblocked agent a fresh slate.
 */
export async function clearAgentActionAttemptsForIssue(
  db: Db,
  issueId: string,
): Promise<void> {
  await db
    .delete(agentActionAttempts)
    .where(eq(agentActionAttempts.issueId, issueId));
}

/**
 * Verify an issue is currently in `blocked`. Helper for tests + the unblock
 * hook so we don't accidentally clear tracker state for a still-active issue.
 */
export async function isIssueCurrentlyBlocked(
  db: Db,
  issueId: string,
): Promise<boolean> {
  const rows = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0]?.status === "blocked";
}
