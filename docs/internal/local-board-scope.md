# Local-board scope, infra-error hook & UNLOGGED crash semantics

> Internal reference. Maintained by the Lead Engineer pack. Last updated under
> LIF-427 (LIF-375 Stage 3a, plan rev 26).

This document describes three load-bearing properties of the server that are
easy to break by accident:

1. The **local-board** actor surface (what `local_trusted` deployment mode
   silently grants).
2. The **bypass-service** that the infra-error hook uses to flip an issue to
   `blocked` outside the FSM.
3. The **UNLOGGED** crash semantics of `agent_action_attempts`.

It also pins a lifecycle invariant that is invisible from the call sites:
**actor resolution must run above the dynamic body parser.**

---

## 1. Local-board scope

`local_trusted` deployment mode short-circuits authentication. Any unauthenticated
request to the API is treated as the synthetic `local-board` user:

```
{ type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
```

This actor:
- Bypasses board API key verification.
- Has full company access (`isInstanceAdmin: true`).
- Is **not subject to** the agent self-wake guard (because it is not an agent).
- Is **not subject to** the per-agent dynamic body-size limit (it parses up to
  10 MB instead of 10 KB).

### Invariants the platform relies on

- This mode is enabled **only** when `deploymentMode === "local_trusted"`.
  Production runs with `authenticated`, where the same code paths require a
  real session/key.
- `local_trusted` is never combined with `deploymentExposure === "public"`.
  See `app.ts` → `shouldEnablePrivateHostnameGuard`.
- Operators who attach `Authorization: Bearer …` headers re-enter the normal
  identity path, even on local-trusted mode. **Always send Authorization on
  own-issue comments**, otherwise the self-wake guard silently fails (LIF
  gotcha `local-board bypasses self_wake_guard`).

### Auth-mount-order requirement

The actor middleware runs **before** the body parser:

```
privateHostnameGuard → actorMiddleware → dynamic-limit json parser → tracker → routes
```

Why: the dynamic parser inspects `req.actor?.type` to pick a 10 KB or 10 MB
limit. If actor resolution were attached after the parser, the parser would
always see `req.actor === undefined` and fall through to the user-tier 10 MB
limit. That would make the agent-tier 10 KB cap unenforceable.

**Do not move `actorMiddleware` below `express.json()`.** The architecture test
in `__tests__/architecture-status-codes.test.ts` does not catch this — it is a
load-bearing comment in `app.ts`.

---

## 2. Bypass service (`issue-blocked-bypass`)

The infra-error hook (`middleware/agent-action-tracker.ts`) needs to flip an
issue to `status='blocked'` after N repeated 422/409 responses from the same
agent on the same `(method, path)` tuple. The FSM in `services/heartbeat.ts`
intentionally rejects status writes from agent actors, so the hook must
side-step the FSM.

`services/issue-blocked-bypass.ts` exposes `forceBlock({ issueId, companyId,
reason, details })`. It:

1. Issues a raw `UPDATE issues SET status='blocked'` conditional on the issue
   being in a non-terminal status (`NOT IN ('blocked','done','cancelled')`).
2. If `rowCount > 0` (the issue actually changed), writes one `activity_log`
   row with `actor_type='system'`, `actor_id='infra_error_hook'`, and a
   structured `details` payload identifying the agent + route + attempt count.
3. Returns `{ changed }` to the caller, which **must** gate any follow-up side
   effects (system comments, live events) on `changed === true` per the rev-22
   contract.

### Why a raw UPDATE instead of the issues service

- `issuesService.updateIssue` enforces the FSM. The FSM correctly rejects
  agent-driven `status='blocked'` writes — but the infra-error hook is a
  **server-system** actor, not an agent. We do not want to introduce a
  server-system code path through the FSM because every other server-system
  flip would need the same back door.
- The bypass is intentionally rare and **explicit**. `git grep "forceBlock("`
  should always return a small set of call sites; reviewers should treat new
  callers as red flags.

### Audit trail

The bypass is fully auditable: every flip writes one `activity_log` row with
`action='issue.blocked.bypass'` and a `details.bypass = true` flag. Operators
investigating an unexpected `blocked` transition should look there first.

---

## 3. UNLOGGED crash semantics for `agent_action_attempts`

The migration that created `agent_action_attempts`
(`packages/db/src/migrations/0075_agent_action_attempts.sql`) declares it as
`CREATE UNLOGGED TABLE`. The migration carries a `WARNING: UNLOGGED` header so
operators reading the migration log see the choice immediately.

### Behaviour on PostgreSQL crash

Per PostgreSQL docs, an `UNLOGGED` table is **truncated** on the next start
after a crash (or any other unclean shutdown). Concretely:

- All rows are gone. No replication. No WAL.
- The table itself stays — schema, indexes, foreign keys.
- The next 24 h cron sweep is a no-op (already empty).

### Why this is acceptable

The tracker is a **recovery hint**, not a system of record. Losing it means:

- Agents that were on attempt N at crash time get one fresh chance before the
  hook re-engages. That is **better** than the alternative: a crash that
  unfairly preserved a stale attempt count would block a recovering agent on
  the first retry after restart.
- The audit trail (`activity_log.issue.blocked.bypass`) is preserved on the
  logged side, so post-mortem analysis still has the full record of every
  bypass that fired before the crash.

### What this means for migration testing

`pg_dump` does not dump rows from UNLOGGED tables (`--exclude-table-data` is
implicit). Backup/restore round-trip tests that rely on row preservation must
not assert on `agent_action_attempts` contents. Use schema-only assertions for
this table.

---

## 4. Operational checklist

When working in this area:

- [ ] If you add a new code path that flips an issue to `blocked` from outside
      the FSM, document it in this file and link to the `forceBlock` call.
- [ ] If you add a new naked `res.status(422)` outside `error-handler.ts`,
      replace it with `descriptiveError(code, prompt, details?)`. The
      `architecture-status-codes` test will fail otherwise.
- [ ] If you change the actor middleware mount order, verify the dynamic body
      parser still sees `req.actor.type === "agent"` for agent traffic. The
      10 KB cap is a load-bearing limit on the infra-error tracker.
- [ ] If you back up the database with a tool that copies UNLOGGED rows
      (e.g. a custom snapshot tool), make sure restore is idempotent for the
      tracker — it should not crash on a row-less table.

---

## 5. Cross-references

- Plan: LIF-375 rev 26 (issue `b081db57-…`).
- Implementation: LIF-427 (this stage).
- AST follow-up for the architecture test: LIF-371 backlog.
- Bypass service: `server/src/services/issue-blocked-bypass.ts`.
- Tracker middleware: `server/src/middleware/agent-action-tracker.ts`.
- Migration: `packages/db/src/migrations/0075_agent_action_attempts.sql`.
