import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  executionWorkspaces,
  handoffs,
  issueComments,
  issues,
} from "@paperclipai/db";
import { descriptiveError, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

const execFile = promisify(execFileCallback);

const SCOPE_GIT_TIMEOUT_MS = 60_000;

// Validates a git ref: matches /^[\w\-.\/]+$/ AND git check-ref-format
const GIT_REF_SAFE_RE = /^[\w\-.\/]+$/;

export async function assertValidGitRef(ref: string, workspaceDir: string): Promise<void> {
  if (!GIT_REF_SAFE_RE.test(ref)) {
    throw descriptiveError(
      "INVALID_GIT_REF",
      `git ref \`${ref}\` is not a valid branch/ref name; pass a real branch like 'main' or 'feature/my-branch'`,
      { ref },
    );
  }
  try {
    await execFile("git", ["check-ref-format", "--branch", ref], {
      timeout: 5_000,
      killSignal: "SIGTERM",
    });
  } catch {
    // check-ref-format uses --branch to accept plain branch names;
    // fall back to plain format check for other ref patterns
    try {
      await execFile("git", ["-C", workspaceDir, "check-ref-format", ref], {
        timeout: 5_000,
        killSignal: "SIGTERM",
      });
    } catch {
      throw descriptiveError(
      "INVALID_GIT_REF",
      `git ref \`${ref}\` is not a valid branch/ref name; pass a real branch like 'main' or 'feature/my-branch'`,
      { ref },
    );
    }
  }
}

async function resolveWorkspaceDir(
  db: Db,
  issueId: string,
): Promise<{ workspaceDir: string; baseRef: string | null } | null> {
  const rows = await db
    .select({
      cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef,
      baseRef: executionWorkspaces.baseRef,
    })
    .from(issues)
    .innerJoin(
      executionWorkspaces,
      eq(issues.executionWorkspaceId, executionWorkspaces.id),
    )
    .where(eq(issues.id, issueId))
    .limit(1);

  if (!rows[0]) return null;
  const row = rows[0];
  const workspaceDir = row.providerRef ?? row.cwd ?? null;
  if (!workspaceDir) return null;
  return { workspaceDir, baseRef: row.baseRef ?? null };
}

async function runScopeCheck(
  db: Db,
  opts: {
    handoffId: string;
    issueId: string;
    companyId: string;
    branch: string;
    baseBranch: string;
    scopeGlobs: string[];
    workspaceDir: string;
    actorAgentId: string | null;
    actorRunId: string | null;
  },
): Promise<{ accepted: true; verifiedSha: string } | { accepted: false; systemEnforced: true; outOfScopeFiles: string[] }> {
  const { branch, baseBranch, scopeGlobs, workspaceDir } = opts;

  // Step 1: Validate refs
  await assertValidGitRef(branch, workspaceDir);
  await assertValidGitRef(baseBranch, workspaceDir);

  // Step 2: Fetch the branch into the local object store
  try {
    await execFile(
      "git",
      ["-C", workspaceDir, "fetch", "--no-tags", "--quiet", "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { timeout: SCOPE_GIT_TIMEOUT_MS, killSignal: "SIGTERM" },
    );
  } catch (err: unknown) {
    const errAny = err as NodeJS.ErrnoException & { code?: string | number };
    if (errAny.code === "ENOENT") {
      const serverErr = new Error("git binary not found");
      (serverErr as unknown as Record<string, unknown>).status = 500;
      throw serverErr;
    }
    throw descriptiveError(
      "TRANSIENT_BRANCH_MISSING",
      `branch \`${branch}\` could not be fetched from origin; push the branch then retry`,
      { branch },
    );
  }

  // Step 3: Diff to find changed files
  let diffOutput = "";
  try {
    const result = await execFile(
      "git",
      ["-C", workspaceDir, "diff", "--name-only", `${baseBranch}..origin/${branch}`],
      { timeout: SCOPE_GIT_TIMEOUT_MS, killSignal: "SIGTERM" },
    );
    diffOutput = result.stdout;
  } catch {
    throw descriptiveError(
      "TRANSIENT_BRANCH_MISSING",
      `branch \`${branch}\` could not be fetched from origin; push the branch then retry`,
      { branch },
    );
  }

  const changedFiles = diffOutput.split("\n").filter((f) => f.trim().length > 0);

  // Check scope
  const outOfScopeFiles = changedFiles.filter((file) => {
    return !scopeGlobs.some((glob) => matchGlob(glob, file));
  });

  // Step 4: Capture verifiedSha
  let verifiedSha = "";
  try {
    const shaResult = await execFile(
      "git",
      ["-C", workspaceDir, "rev-parse", `origin/${branch}`],
      { timeout: SCOPE_GIT_TIMEOUT_MS, killSignal: "SIGTERM" },
    );
    verifiedSha = shaResult.stdout.trim();
  } catch {
    throw descriptiveError(
      "TRANSIENT_SHA_RESOLVE_FAILED",
      `failed to resolve HEAD sha for branch \`${branch}\` after fetch; the ref may have moved mid-check, retry once`,
      { branch },
    );
  }

  if (outOfScopeFiles.length > 0) {
    // Persist rejection atomically
    const now = new Date();
    await db.transaction(async (tx) => {
      // Update handoff status to rejected
      await tx
        .update(handoffs)
        .set({ status: "rejected", decision: "rejected", decidedAt: now, updatedAt: now })
        .where(eq(handoffs.id, opts.handoffId));

      // Insert courtesy comment
      await tx.insert(issueComments).values({
        companyId: opts.companyId,
        issueId: opts.issueId,
        authorAgentId: null,
        authorUserId: null,
        createdByRunId: opts.actorRunId as string | undefined,
        body: `Handoff auto-rejected: out-of-scope files detected.\n\nFiles outside scope: ${outOfScopeFiles.slice(0, 10).join(", ")}${outOfScopeFiles.length > 10 ? "..." : ""}`,
        metadata: {
          kind: "handoff_auto_reject",
          handoffId: opts.handoffId,
          outOfScopeFiles,
          scopeGlobs,
        },
      });

      // Append activity log
      await tx.insert(activityLog).values({
        companyId: opts.companyId,
        actorType: "system",
        actorId: opts.actorAgentId ?? "system",
        action: "handoff.auto_rejected",
        entityType: "handoff",
        entityId: opts.handoffId,
        agentId: opts.actorAgentId,
        runId: opts.actorRunId,
        details: { outOfScopeFiles, scopeGlobs, handoffId: opts.handoffId },
      });
    });

    return { accepted: false, systemEnforced: true, outOfScopeFiles };
  }

  return { accepted: true, verifiedSha };
}

// Minimal glob matcher supporting `**` and `*` patterns
function matchGlob(pattern: string, path: string): boolean {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "GLOBSTAR")
    .replace(/\*/g, "[^/]*")
    .replace(/GLOBSTAR/g, ".*");
  return new RegExp(`^${regexStr}$`).test(path);
}

export function handoffRoutes(db: Db) {
  const router = Router();

  // GET /api/issues/:id/handoffs — list chain for an issue
  router.get("/issues/:id/handoffs", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const rows = await db
      .select()
      .from(handoffs)
      .where(eq(handoffs.issueId, issueId))
      .orderBy(handoffs.createdAt);

    res.json(rows);
  });

  // GET /api/handoffs/:id — single handoff
  router.get("/handoffs/:id", async (req, res) => {
    const id = req.params.id as string;
    const handoff = await db
      .select()
      .from(handoffs)
      .where(eq(handoffs.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!handoff) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    assertCompanyAccess(req, handoff.companyId);
    res.json(handoff);
  });

  // POST /api/issues/:id/handoffs — Lead creates a Handoff
  router.post("/issues/:id/handoffs", async (req, res) => {
    const issueId = req.params.id as string;
    const actor = getActorInfo(req);

    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const { kind, toAgentId, branch, baseBranch, scopeGlobs, contract, parentHandoffId, idempotencyKey, payload } = req.body as {
      kind?: string;
      toAgentId?: string;
      branch?: string;
      baseBranch?: string;
      scopeGlobs?: string[];
      contract?: string;
      parentHandoffId?: string;
      idempotencyKey?: string;
      payload?: Record<string, unknown>;
    };

    if (!kind || !["delegate", "review", "acceptance"].includes(kind)) {
      throw descriptiveError(
        "INVALID_KIND",
        "Handoff `kind` must be one of: 'delegate' (Lead→Drafter), 'review' (Drafter→Critique), 'acceptance' (final). Pass `kind` in the JSON body.",
        { kind, allowed: ["delegate", "review", "acceptance"] },
      );
    }

    if (kind === "delegate" && !branch) {
      throw descriptiveError(
        "MISSING_BRANCH",
        "delegate handoffs require a `branch` field naming the working branch the Drafter pushes to (e.g. 'agent/<id>')",
        { kind },
      );
    }

    // Idempotency check
    if (idempotencyKey) {
      const existing = await db
        .select()
        .from(handoffs)
        .where(
          and(
            eq(handoffs.companyId, issue.companyId),
            eq(handoffs.issueId, issueId),
            eq(handoffs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existing) {
        res.status(200).json({ handoff: existing, idempotent: true });
        return;
      }
    }

    let resolvedBranch = branch;
    let resolvedBaseBranch = baseBranch;
    let resolvedScopeGlobs = scopeGlobs;

    if (kind === "review") {
      // Hard-inheritance: clone branch, baseBranch, scopeGlobs from parent delegate
      if (!parentHandoffId) {
        throw descriptiveError(
          "ORPHAN_REVIEW",
          "review handoffs must reference the parent delegate handoff via `parentHandoffId`; reviews never originate without a delegate",
          { kind: "review" },
        );
      }

      const parent = await db
        .select()
        .from(handoffs)
        .where(eq(handoffs.id, parentHandoffId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!parent) {
        throw descriptiveError(
          "ORPHAN_REVIEW",
          `parentHandoffId \`${parentHandoffId}\` does not exist; review handoffs must reference an existing delegate`,
          { parentHandoffId },
        );
      }

      // Cross-company check
      if (parent.companyId !== issue.companyId) {
        throw descriptiveError(
          "ORPHAN_REVIEW",
          "parentHandoffId belongs to a different company; review and parent must share the same company",
          { parentHandoffId, parentCompanyId: parent.companyId, issueCompanyId: issue.companyId },
        );
      }

      // Parent must be a delegate
      if (parent.kind !== "delegate") {
        throw descriptiveError(
          "ORPHAN_REVIEW",
          `parent handoff has kind='${parent.kind}'; reviews must reference a kind='delegate' handoff`,
          { parentHandoffId, parentKind: parent.kind },
        );
      }

      // Authz: authenticated agent must be parent's toAgentId
      if (actor.agentId !== parent.toAgentId) {
        throw forbidden("unauthorized_parent");
      }

      // Hard-inherit from parent
      resolvedBranch = parent.branch ?? undefined;
      resolvedBaseBranch = parent.baseBranch ?? undefined;
      resolvedScopeGlobs = (parent.scopeGlobs as string[] | null) ?? undefined;
    }

    const fromAgentId = actor.agentId ?? null;

    const now = new Date();
    const [created] = await db
      .insert(handoffs)
      .values({
        companyId: issue.companyId,
        issueId,
        kind,
        status: "pending",
        fromAgentId,
        toAgentId: toAgentId ?? null,
        scopeGlobs: resolvedScopeGlobs ?? null,
        contract: contract ?? null,
        branch: resolvedBranch ?? null,
        baseBranch: resolvedBaseBranch ?? null,
        parentHandoffId: parentHandoffId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        payload: payload ?? null,
        updatedAt: now,
      })
      .returning();

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "handoff.created",
      entityType: "handoff",
      entityId: created.id,
      details: { kind, issueId, branch: resolvedBranch },
    });

    res.status(201).json({ handoff: created });
  });

  // PATCH /api/handoffs/:id/decide — transition handoff
  router.patch("/handoffs/:id/decide", async (req, res) => {
    const id = req.params.id as string;
    const actor = getActorInfo(req);

    const handoff = await db
      .select()
      .from(handoffs)
      .where(eq(handoffs.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!handoff) {
      res.status(404).json({ error: "Handoff not found" });
      return;
    }
    assertCompanyAccess(req, handoff.companyId);

    const { decision, decisionReason } = req.body as {
      decision?: string;
      decisionReason?: string;
    };

    if (!decision || !["accepted", "rejected"].includes(decision)) {
      throw descriptiveError(
        "INVALID_DECISION",
        "PATCH /handoffs/:id/decide requires `decision` to be 'accepted' or 'rejected' in the JSON body",
        { decision, allowed: ["accepted", "rejected"] },
      );
    }

    // Idempotent replay keyed on decision (rev 13)
    if (handoff.status !== "pending") {
      // Terminal state: same decision → 200 idempotent; different → 422
      if (handoff.decision === decision) {
        res.status(200).json({ handoff, idempotent: true });
        return;
      }
      throw descriptiveError(
        "TERMINAL_HANDOFF_MISMATCH",
        `handoff is already in terminal status '${handoff.status}' with decision '${handoff.decision}'; create a new handoff instead of decoding ${decision} on this one`,
        { handoffId: id, currentStatus: handoff.status, currentDecision: handoff.decision, requestedDecision: decision },
      );
    }

    // Base resolution
    let resolvedBase = handoff.baseBranch;
    if (!resolvedBase) {
      // Try executionWorkspace.baseRef
      const wsInfo = await resolveWorkspaceDir(db, handoff.issueId);
      resolvedBase = wsInfo?.baseRef ?? null;
    }
    if (!resolvedBase) {
      throw descriptiveError(
        "UNRESOLVED_BASE",
        "cannot resolve a base branch for this handoff; set `baseBranch` on the handoff or set `baseRef` on the issue's executionWorkspace",
        { handoffId: id, issueId: handoff.issueId },
      );
    }

    if (decision === "rejected") {
      const now = new Date();
      const [updated] = await db
        .update(handoffs)
        .set({
          status: "rejected",
          decision: "rejected",
          decisionReason: decisionReason ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(handoffs.id, id))
        .returning();

      await logActivity(db, {
        companyId: handoff.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "handoff.rejected",
        entityType: "handoff",
        entityId: id,
        details: { decisionReason },
      });

      res.json({ handoff: updated });
      return;
    }

    // decision === "accepted" — run scope-coupling check
    const wsInfo = await resolveWorkspaceDir(db, handoff.issueId);
    if (!wsInfo) {
      throw descriptiveError(
        "UNRESOLVED_BASE",
        "no executionWorkspace is attached to this issue; the scope-coupling check requires a real working tree",
        { handoffId: id, issueId: handoff.issueId },
      );
    }
    const { workspaceDir } = wsInfo;

    // Compute effective scopeGlobs (for review: intersection with delegate)
    let effectiveScopeGlobs: string[] = (handoff.scopeGlobs as string[] | null) ?? [];
    if (handoff.kind === "review" && handoff.parentHandoffId) {
      const parent = await db
        .select({ scopeGlobs: handoffs.scopeGlobs })
        .from(handoffs)
        .where(eq(handoffs.id, handoff.parentHandoffId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      const parentGlobs = (parent?.scopeGlobs as string[] | null) ?? [];
      // Intersection: keep only globs that appear in both
      if (parentGlobs.length > 0 && effectiveScopeGlobs.length > 0) {
        effectiveScopeGlobs = effectiveScopeGlobs.filter((g) => parentGlobs.includes(g));
      } else {
        // Use whichever is non-empty (or both empty → no restriction)
        effectiveScopeGlobs = parentGlobs.length > 0 ? parentGlobs : effectiveScopeGlobs;
      }
    }

    const branch = handoff.branch;
    if (!branch) {
      throw descriptiveError(
        "UNRESOLVED_BASE",
        "handoff has no `branch` recorded; reviews/decisions need a branch to scope-check against",
        { handoffId: id },
      );
    }

    let scopeResult: Awaited<ReturnType<typeof runScopeCheck>>;
    try {
      scopeResult = await runScopeCheck(db, {
        handoffId: id,
        issueId: handoff.issueId,
        companyId: handoff.companyId,
        branch,
        baseBranch: resolvedBase,
        scopeGlobs: effectiveScopeGlobs,
        workspaceDir,
        actorAgentId: actor.agentId,
        actorRunId: actor.runId,
      });
    } catch (err: unknown) {
      const errAny = err as Record<string, unknown>;
      if (errAny.status === 500) {
        res.status(500).json({ error: "internal_error", message: "git binary unavailable" });
        return;
      }
      throw err;
    }

    if (!scopeResult.accepted) {
      // Auto-rejected by scope check (transaction already committed in runScopeCheck)
      const updatedHandoff = await db
        .select()
        .from(handoffs)
        .where(eq(handoffs.id, id))
        .limit(1)
        .then((rows) => rows[0] ?? handoff);

      res.json({
        handoff: updatedHandoff,
        systemEnforced: true,
        outOfScopeFiles: scopeResult.outOfScopeFiles,
      });
      return;
    }

    // Accepted — persist verifiedSha + accepted status
    const now = new Date();
    const [updated] = await db
      .update(handoffs)
      .set({
        status: "accepted",
        decision: "accepted",
        decisionReason: decisionReason ?? null,
        decidedAt: now,
        verifiedSha: scopeResult.verifiedSha,
        updatedAt: now,
      })
      .where(eq(handoffs.id, id))
      .returning();

    await logActivity(db, {
      companyId: handoff.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "handoff.accepted",
      entityType: "handoff",
      entityId: id,
      details: { verifiedSha: scopeResult.verifiedSha },
    });

    res.json({ handoff: updated });
  });

  return router;
}
