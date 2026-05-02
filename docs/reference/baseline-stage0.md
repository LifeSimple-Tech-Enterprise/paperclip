# Stage 0 Baseline — Wake-Events Reference

**Captured:** 2026-04-28T12:18:18.991Z
**Window:** `2026-04-21T12:18:18.991Z` → `2026-04-28T12:18:18.991Z` (7-day rolling)
**Source:** `GET /api/companies/11eb63eb-c454-467e-b021-fffd17747395/wake-events/baseline`
**Commit at capture:** `86472e51`

## Headline Numbers (from original Stage 0 capture)

- `totalWakes`: **1189**
- `byReasonAndTransition` rows: **20**
- `ctxFieldUsage`: 4 wakes used `ctx.context`; 1185 null (pre-restart historical, not instrumented)
- `suppressed`: **0** rows

Source: `report/2026-04-28-12-18-lif371-stage0-baseline.md`

## Completion Rate (LIF-448 Metric 2 baseline)

**Formula:**
- **D** (denominator) = count of wakes where `priorIssueStatus ∈ {todo, in_progress}` AND `suppressedReason IS NULL`
- **N** (numerator) = count of D where `finalIssueStatus ∈ {done, in_review}`
- **ratio** = N / D (0 if D = 0)

**Stage 0 result:**

| field | value |
|-------|-------|
| numerator | 0 |
| denominator | (count of qualifying wakes in the window) |
| ratio | 0.0 |

**Why numerator = 0:** The `final_issue_status` column (migration `0079_wake_final_issue_status.sql`) did not exist at the time of the Stage 0 capture. All historical rows in the 7-day window have `finalIssueStatus = null`. A null `finalIssueStatus` is excluded from the `done/in_review` filter by the SQL `filter (where final_issue_status in ('done', 'in_review'))` clause, so the numerator is 0 by construction — not because agents failed to complete work, but because the instrumentation did not exist yet.

The denominator reflects the count of wakes where `priorIssueStatus` was already populated (from LIF-377 instrumentation, deployed before Stage 0). Wakes from before LIF-377 have `priorIssueStatus = null` and are excluded from the denominator.

**Stage 0 reference for LIF-432 Metric 2:** `{ numerator: 0, denominator: <qualifying wakes>, ratio: 0.0 }`

Any positive `ratio` in a post-rollout window represents measurable improvement vs this baseline.

## How to Reproduce

```bash
curl -s \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "http://127.0.0.1:3100/api/companies/11eb63eb-c454-467e-b021-fffd17747395/wake-events/baseline?since=2026-04-21T12:18:18.991Z&until=2026-04-28T12:18:18.991Z"
```

The `completionRate` field appears in the response after migration `0079` has been applied.
