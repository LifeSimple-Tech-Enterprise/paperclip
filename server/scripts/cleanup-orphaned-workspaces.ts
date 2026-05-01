/**
 * LIF-458 / LIF-453.e — Layer 3 retroactive cleanup migration
 *
 * Finds all issues where:
 *   - assignee agent has requiresWorkspace = true
 *   - issue.executionWorkspaceId IS NULL
 *   - issue.status is active (not done/cancelled)
 *
 * For each orphan:
 *   Option A: find a reuse-eligible execution workspace for the issue's project,
 *             or create a new shared_workspace record from the project's primary
 *             workspace. On success, persists executionWorkspaceId on the issue.
 *   Fallback: PATCH issue status=blocked with reason ORPHANED_NO_WORKSPACE.
 *
 * Idempotent: re-running on a clean DB (no orphans) is a no-op.
 */

import { createDb } from "@paperclipai/db";
import {
  agents,
  executionWorkspaces,
  issues,
  projectWorkspaces,
} from "@paperclipai/db";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://paperclip:paperclip@127.0.0.1:54331/paperclip";

const API_URL = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100";
const API_KEY = process.env.PAPERCLIP_API_KEY ?? "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID ?? "";

const TERMINAL_STATUSES = ["done", "cancelled"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrphanRow {
  issueId: string;
  identifier: string | null;
  status: string;
  companyId: string;
  projectId: string | null;
  assigneeAgentId: string;
}

interface AutoAllocatedRow extends OrphanRow {
  executionWorkspaceId: string;
  source: "reused" | "created";
}

interface BlockedRow extends OrphanRow {
  reason: string;
}

interface Artifact {
  runAt: string;
  total: number;
  auto_allocated: number;
  blocked: number;
  auto_allocated_rows: AutoAllocatedRow[];
  blocked_rows: BlockedRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function patchIssueBlocked(issueId: string, reason: string): Promise<void> {
  if (!API_KEY) {
    console.warn(`  [WARN] No PAPERCLIP_API_KEY set; cannot PATCH ${issueId} to blocked via API. Recording in log only.`);
    return;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (RUN_ID) headers["X-Paperclip-Run-Id"] = RUN_ID;

  const body = JSON.stringify({
    status: "blocked",
    comment: `Blocked by cleanup-orphaned-workspaces script: ${reason}`,
  });

  const resp = await fetch(`${API_URL}/api/issues/${issueId}`, {
    method: "PATCH",
    headers,
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    console.warn(`  [WARN] PATCH /api/issues/${issueId} → ${resp.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("cleanup-orphaned-workspaces starting…");
  console.log(`  DATABASE_URL: ${DATABASE_URL.replace(/:\/\/[^@]+@/, "://<credentials>@")}`);

  const db = createDb(DATABASE_URL);

  // --- 1. Query orphaned issues ------------------------------------------
  console.log("\nStep 1: querying orphaned issues…");

  const orphans: OrphanRow[] = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      companyId: issues.companyId,
      projectId: issues.projectId,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(
      and(
        eq(agents.requiresWorkspace, true),
        isNull(issues.executionWorkspaceId),
        isNull(issues.assigneeAgentId) === false,
        notInArray(issues.status, TERMINAL_STATUSES),
      ),
    ) as OrphanRow[];

  console.log(`  Found ${orphans.length} orphaned issue(s).`);

  if (orphans.length === 0) {
    const artifact: Artifact = {
      runAt: new Date().toISOString(),
      total: 0,
      auto_allocated: 0,
      blocked: 0,
      auto_allocated_rows: [],
      blocked_rows: [],
    };
    await writeArtifact(artifact);
    printReport(artifact);
    return;
  }

  // --- 2. Process each orphan -------------------------------------------
  console.log("\nStep 2: processing orphans…");

  const autoAllocated: AutoAllocatedRow[] = [];
  const blocked: BlockedRow[] = [];

  for (const orphan of orphans) {
    const tag = orphan.identifier ?? orphan.issueId;
    console.log(`\n  Processing ${tag} (status=${orphan.status})…`);

    if (!orphan.projectId) {
      console.log(`    No projectId → blocked (ORPHANED_NO_WORKSPACE)`);
      const reason = "ORPHANED_NO_WORKSPACE: issue has no projectId, cannot allocate workspace";
      await patchIssueBlocked(orphan.issueId, reason);
      blocked.push({ ...orphan, reason });
      continue;
    }

    // Step A1: look for reuse-eligible execution workspace on the project
    const existingWorkspaces = await db
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, orphan.companyId),
          eq(executionWorkspaces.projectId, orphan.projectId),
          inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
        ),
      )
      .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
      .limit(1);

    if (existingWorkspaces.length > 0) {
      const ws = existingWorkspaces[0]!;
      console.log(`    Reusing execution workspace ${ws.id} (${ws.status})`);
      await db
        .update(issues)
        .set({ executionWorkspaceId: ws.id, updatedAt: new Date() })
        .where(eq(issues.id, orphan.issueId));
      autoAllocated.push({ ...orphan, executionWorkspaceId: ws.id, source: "reused" });
      continue;
    }

    // Step A2: find the project's primary workspace and create a new exec workspace
    const projectWorkspaceRows = await db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, orphan.companyId),
          eq(projectWorkspaces.projectId, orphan.projectId),
        ),
      )
      .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt))
      .limit(1);

    if (projectWorkspaceRows.length === 0) {
      console.log(`    No project workspace found → blocked (ORPHANED_NO_WORKSPACE)`);
      const reason = "ORPHANED_NO_WORKSPACE: no project workspace exists for this issue's project";
      await patchIssueBlocked(orphan.issueId, reason);
      blocked.push({ ...orphan, reason });
      continue;
    }

    const pw = projectWorkspaceRows[0]!;

    if (!pw.cwd) {
      console.log(`    Project workspace has no cwd → blocked (ORPHANED_NO_WORKSPACE)`);
      const reason = `ORPHANED_NO_WORKSPACE: project workspace ${pw.id} has no configured cwd`;
      await patchIssueBlocked(orphan.issueId, reason);
      blocked.push({ ...orphan, reason });
      continue;
    }

    // Create a shared_workspace execution workspace record
    const [newWs] = await db
      .insert(executionWorkspaces)
      .values({
        companyId: orphan.companyId,
        projectId: orphan.projectId,
        projectWorkspaceId: pw.id,
        sourceIssueId: orphan.issueId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: orphan.identifier ?? `workspace-${orphan.issueId.slice(0, 8)}`,
        status: "active",
        cwd: pw.cwd,
        repoUrl: pw.repoUrl ?? null,
        baseRef: pw.repoRef ?? null,
        branchName: null,
        providerType: "local_fs",
        providerRef: null,
        lastUsedAt: new Date(),
        openedAt: new Date(),
        metadata: { createdByRuntime: false, source: "cleanup_script_lif458" },
      })
      .returning();

    if (!newWs) {
      const reason = "ORPHANED_NO_WORKSPACE: failed to insert execution workspace record";
      console.log(`    Insert failed → blocked`);
      await patchIssueBlocked(orphan.issueId, reason);
      blocked.push({ ...orphan, reason });
      continue;
    }

    console.log(`    Created execution workspace ${newWs.id}`);
    await db
      .update(issues)
      .set({ executionWorkspaceId: newWs.id, updatedAt: new Date() })
      .where(eq(issues.id, orphan.issueId));

    autoAllocated.push({ ...orphan, executionWorkspaceId: newWs.id, source: "created" });
  }

  // --- 3. Write artifact and print report --------------------------------
  const artifact: Artifact = {
    runAt: new Date().toISOString(),
    total: orphans.length,
    auto_allocated: autoAllocated.length,
    blocked: blocked.length,
    auto_allocated_rows: autoAllocated,
    blocked_rows: blocked,
  };

  await writeArtifact(artifact);
  printReport(artifact);
}

async function writeArtifact(artifact: Artifact) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outputDir = path.join(scriptDir, "output");
  await mkdir(outputDir, { recursive: true });
  const timestamp = artifact.runAt.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const filePath = path.join(outputDir, `cleanup-orphaned-workspaces-${timestamp}.json`);
  await writeFile(filePath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nArtifact written to: ${filePath}`);
  return filePath;
}

function printReport(artifact: Artifact) {
  console.log("\n========================================");
  console.log("  CLEANUP REPORT");
  console.log("========================================");
  console.log(`  total:          ${artifact.total}`);
  console.log(`  auto_allocated: ${artifact.auto_allocated}`);
  console.log(`  blocked:        ${artifact.blocked}`);
  if (artifact.auto_allocated_rows.length > 0) {
    console.log("\n  Auto-allocated:");
    for (const row of artifact.auto_allocated_rows) {
      console.log(`    ${row.identifier ?? row.issueId}  workspace=${row.executionWorkspaceId}  (${row.source})`);
    }
  }
  if (artifact.blocked_rows.length > 0) {
    console.log("\n  Blocked:");
    for (const row of artifact.blocked_rows) {
      console.log(`    ${row.identifier ?? row.issueId}  reason=${row.reason}`);
    }
  }
  console.log("========================================\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
