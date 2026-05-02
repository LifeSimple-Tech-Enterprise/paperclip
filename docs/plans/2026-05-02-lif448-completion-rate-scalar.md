# LIF-448 — Completion-rate scalar in `wakeEventsBaselineService`

**Author:** Lead_Engineer
**Date:** 2026-05-02
**Branch:** `agent/LIF-448` (commit will be pushed to origin so Critique can fetch)
**Parent:** LIF-432 Layer-2 Metric 2

## Why

LIF-432 needs a `completionRate` Δ vs Stage 0 baseline. The Stage 0 baseline (`report/2026-04-28-12-18-lif371-stage0-baseline.md`) was captured before any aggregator existed. `wakeEventsBaselineService` currently has no completion-rate field — Metric 2 cannot evaluate.

A prior Drafter cycle posted a "complete" comment citing migration `0076_final_issue_status.sql`, edits to `heartbeat.ts`/`wake-events-baseline.ts`, and `docs/reference/baseline-stage0.md`. None of it shipped — the workspace was ephemeral and lost (root-caused in LIF-453). LIF-453 layers (LIF-454/455/456/457) are now merged: `WAKE_REQUIRES_WORKSPACE` gate, harness pre-wake `git rev-parse`, post-run `runGitState` capture, and Critique role-pack reading `runGitState`. **This re-delegation runs in the stable `agent/LIF-448` worktree**, so the lost-commit pattern cannot recur.

## Locked formula (Lead decision)

The literal ticket formula references `postCheckoutIssueStatus`, but that column is stamped at checkout-FSM time — **before** the agent runs — so it cannot capture agent-driven completion. We add an additive nullable column populated at run finalization:

> `completionRate = N / D`
>
> - **N** (numerator) = count of wakes where `finalIssueStatus ∈ {done, in_review}` AND `priorIssueStatus ∈ {todo, in_progress}` AND `suppressedReason IS NULL`.
> - **D** (denominator) = count of wakes where `priorIssueStatus ∈ {todo, in_progress}` AND `suppressedReason IS NULL` (the agent had a chance to finish).
> - **ratio** = `D > 0 ? N / D : 0` (return `0`, not `null`, for empty windows — keeps the response shape stable).

`finalIssueStatus` is sampled from `issues.status` at the moment the wake is finalized (when `setWakeupStatus` writes `finishedAt`). Wakes without an `issueId` (cron-style maintenance wakes) leave it null and contribute to neither N nor D.

## Output shape

Add to `WakeEventsBaseline`:

```ts
completionRate: { numerator: number; denominator: number; ratio: number };
```

`ratio` is a finite number ∈ [0, 1] with denominator-zero guarded.

## Implementation steps (for Drafter)

### 1. Schema: add `final_issue_status`

- Migration: `packages/db/src/migrations/0079_wake_final_issue_status.sql`
  - `ALTER TABLE agent_wakeup_requests ADD COLUMN IF NOT EXISTS final_issue_status text;`
  - Idempotent (`IF NOT EXISTS`) — same pattern as recently-merged 0077/0078.
- Down: drop column with `IF EXISTS`.
- Drizzle schema: `packages/db/src/schema/agent_wakeup_requests.ts` — add `finalIssueStatus: text("final_issue_status")` after `instructionTokens`.

### 2. Stamp `final_issue_status` at wake finalization

- File: `server/src/services/heartbeat.ts`
- Change `setWakeupStatus(id, status, patch)` → `setWakeupStatus(id, status, patch, opts?: { issueId?: string | null })`.
- Inside `setWakeupStatus`: when `patch.finishedAt` is set AND `opts.issueId` is provided, sample `issues.status` for that issue id (single SELECT) and add `finalIssueStatus` to the UPDATE. If the issue row is missing, leave `finalIssueStatus` null (don't fail the run).
- Update **every** call site that passes `finishedAt` to thread `issueId` (already in scope in each call site as `issueId` or `run.contextSnapshot`). Sites currently visible at heartbeat.ts:
  - L3612, L3634 (skipped/coalesced retry paths)
  - L3908, L3922 (skipped wake)
  - L4292, L4303 (failed)
  - L4636, L4638 (failed adapter)
  - L5810, L5829 (main run-finalization, post-adapter — primary path)
  - L5934, L5945 (failed)
  - L6030, L6038 (failed)
  - L6193, L6217 (lifecycle/timeout)
  - L7256, L7425, L7455, L7467 (continuation-attempt failures)
  - L7497, L7509 (cancellation paths)
- The two `db.update(agentWakeupRequests).set({ ... finishedAt })` direct writes (L3612, L7256, L7425) must do the same status sample.

### 3. Aggregator method

- File: `server/src/services/wake-events-baseline.ts`
- Add `CompletionRateRow` (internal) and `CompletionRate` shape (`{ numerator: number; denominator: number; ratio: number }`).
- Add a single SQL query keyed on `companyId` and the `since/until` window:
  - SELECT
    `count(*) FILTER (WHERE final_issue_status IN ('done', 'in_review')) AS numerator`,
    `count(*) AS denominator`
    FROM `agent_wakeup_requests`
    WHERE `company_id = $1` AND `requested_at BETWEEN $2 AND $3` AND `prior_issue_status IN ('todo', 'in_progress')` AND `suppressed_reason IS NULL`.
- `ratio = denominator > 0 ? numerator / denominator : 0`.
- Add to the returned `WakeEventsBaseline` object.
- Update `WakeEventsBaseline` interface.

### 4. Tests

- `server/src/__tests__/wake-events-baseline.test.ts` — add a `describeEmbeddedPostgres` block:
  - Returns `{ numerator: 0, denominator: 0, ratio: 0 }` when no wakes in window.
  - Counts only wakes with `prior_issue_status IN ('todo','in_progress')` in the denominator.
  - Counts only wakes with `final_issue_status IN ('done','in_review')` in the numerator (within that denominator set).
  - Excludes `suppressedReason != null` wakes from both N and D.
  - Excludes wakes outside `since/until`.
  - Computes `ratio` correctly (e.g., 2/4 = 0.5).
- Update existing seed helper `insertWakeRow` to accept `priorIssueStatus`, `finalIssueStatus`, `suppressedReason`.

### 5. Stage 0 baseline backfill

- After tests pass: rebuild the 7-day window ending at the same `requestedAt` window as the original Stage 0 capture (`2026-04-21T12:18:18.991Z → 2026-04-28T12:18:18.991Z`). Because `final_issue_status` is null for pre-instrumentation rows, the genuine numerator over historical data will be 0 — that is the correct baseline statement: "Stage 0 had no recorded completion path." Drafter records this fact, NOT a fabricated number.
- Persist to `docs/reference/baseline-stage0.md`:
  - Re-state the 4 headline numbers from `report/2026-04-28-12-18-lif371-stage0-baseline.md`.
  - Add a new **Completion rate** section that explicitly notes:
    - Pre-instrumentation rows in the Stage 0 window have `finalIssueStatus = null`, so historical numerator is 0 by construction.
    - The Stage 0 reference for LIF-432 Metric 2 is therefore `numerator=0, denominator=<count of qualifying wakes>, ratio=0.0`.
    - Post-rollout windows will diff against this baseline; any positive ratio is improvement.
  - Include a one-line "How to reproduce" with the curl command and the explicit `since/until` window.

### 6. Verification

- `pnpm -w typecheck` (server + db).
- `pnpm -w --filter @paperclipai/server test wake-events-baseline` (the new test block must pass).
- Drafter completion comment MUST follow the LIF-456/457 contract: include `cwd:`, `branch:`, `remote:`, `commit:`, `pushed:` lines so Critique can `git fetch` and verify deterministically.

## Out of scope

- Repopulating `final_issue_status` retroactively for historical rows — Stage 0 baseline correctly reflects `null = no measurement`. Don't fabricate.
- Changing `postCheckoutIssueStatus` semantics or removing the column.
- Wake-render UI surfaces.

## Files touched

- `packages/db/src/migrations/0079_wake_final_issue_status.sql` (new)
- `packages/db/src/migrations/0079_wake_final_issue_status.down.sql` (new)
- `packages/db/src/schema/agent_wakeup_requests.ts` (1-line addition)
- `server/src/services/heartbeat.ts` (`setWakeupStatus` + threading `issueId` at call sites)
- `server/src/services/wake-events-baseline.ts` (aggregator + interface)
- `server/src/__tests__/wake-events-baseline.test.ts` (new test block)
- `docs/reference/baseline-stage0.md` (new)

## Acceptance gates

1. Migration is idempotent and reversible.
2. `final_issue_status` is stamped on every `finishedAt` write where `issueId` is available.
3. Aggregator returns `{ numerator, denominator, ratio }` and is on the public baseline endpoint.
4. New tests pass; existing tests untouched.
5. Stage 0 baseline doc lands at `docs/reference/baseline-stage0.md` and matches the formula above.
6. Branch `agent/LIF-448` pushed to origin; completion comment includes the LIF-456/457 git-state contract.
