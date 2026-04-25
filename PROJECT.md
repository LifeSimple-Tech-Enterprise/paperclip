# PROJECT.md — Paperclip (upstream)

> Architectural philosophy and load-bearing decisions for the Paperclip server. Companion to `TECH_STACK.md` (platform & tooling). Owned by the Lead Engineer.

## What this document is for

This file records the **non-derivable** architectural decisions — the ones a new agent cannot reconstruct by reading the source. If a decision is obvious from the code, it does not belong here. If a decision constrains future work in a way that would surprise someone who only read the code, it goes here.

## Decisions

### Plugin install transport — **git clone** (LIF-24, 2026-04-18)

**Decision.** `POST /api/plugins/install` resolves plugins by cloning a git repository at a pinned commit sha or annotated tag. `source: "git"` is the primary transport. Request shape:

```json
{ "source": "git", "repo": "<https-url>", "ref": "<sha-or-tag>" }
```

**Why.** Plugins in scope today are private, single-consumer tools (first concrete case: `process-adapter`). The npm-discoverability rationale that drove the earlier Option A decision (LIF-17) evaporated when the board clarified (LIF-19, 2026-04-18) that there is no marketplace cadence. Git-source install costs less to operate (no registry billing, no publish step, no scope squatting concern) and pins just as reproducibly (sha/tag).

**What this implies.**
- **No floating refs at launch.** The server rejects `main`, `HEAD`, and branch names. Reproducibility over ergonomics.
- **Public-repo anonymous HTTPS only at launch.** Deploy-key / PAT / SSH auth is deferred until the board explicitly asks for a private repo. Distribution intent ≠ repo visibility: a plugin can be "private by convention" while its source repo stays public.
- **`git` is a server runtime dependency.** Dev hosts already have it. Future container images need an SRE check — non-blocking follow-up ticket filed with SRE.
- **Dev-seed overlay (env-gated) is retained.** It solves local iteration without a push-then-bump-ref cycle. See `server/src/plugins/install/README.md` for the env contract.
- **Rejected alternatives** (recorded so we don't re-litigate):
  - `source: "npm"` — rejected under the private-plugin constraint; contract leaves room to add later.
  - `source: "tarball"` / file upload — rejected as per-machine friction.
- **Authoritative decision record:** LIF-24. Earlier records (LIF-17 Revision 3 of LIF-10 PLAN) are superseded.

### Routine_Process on Haiku 4.5 / `claude_local` — **upkeep cost over technical purity** (LIF-47, 2026-04-19)

**Decision.** `Routine_Process` runs on the stock `claude_local` adapter with Claude Haiku 4.5. The earlier private-fork `process` adapter path is retired. On-disk instruction files (`AGENTS.md`, `HEARTBEAT.md`, `SOUL.md` in the agent's `instructions/` directory) describe the LLM workflow; the adapter picks them up via `adapterConfig.instructionsFilePath`.

**Why.** The earlier version of this section proposed reverting `Routine_Process` to a `process`-adapter shell dispatcher (see git history for the full rationale). That recommendation was overridden by the founder on 2026-04-19 on LIF-47 with two operative reasons:

1. The `process` adapter was living in a private fork of Paperclip. Keeping it alive means maintaining fork-local mods on every upstream bump. The ongoing upkeep cost outweighs the per-run latency savings.
2. The run-timeout mismatch that drove most of the observed failures (120s cap vs. LLM cold-start floor) is being addressed separately — `Routine_Process`'s run timeout now follows the same policy as Lead_Engineer, so the "structural timeout floor" argument no longer applies.

In other words: the 2026-04-18 analysis was technically correct but economically wrong for this deployment. We trade a fraction of a second per routine run for the ability to stay on upstream Paperclip with no fork drift.

**What this implies.**
- **Adapter**: `claude_local`, model `claude-haiku-4-5-20251001`. No fork-local `process` adapter is required; the built-in `process` adapter in `server/src/adapters/registry.ts` is still registered but is not used by `Routine_Process`.
- **Instruction files**: `AGENTS.md`, `HEARTBEAT.md`, `SOUL.md` in the agent's `instructions/` directory. `AGENTS.md` is deliberately tight (tool budget: 5 shell + 5 API calls per routine) to keep Haiku runs fast and within the run-timeout envelope.
- **Run timeout**: follows Lead_Engineer policy (set at the harness/company level, not per-agent). No per-agent `timeoutSec` override in `adapterConfig`.
- **`adapterConfig.instructionsFilePath`** MUST point at the agent's `AGENTS.md`; without it, the Claude CLI runs without a system prompt and the agent has no instructions (this is exactly the 2026-04-18 failure mode that made the original migration look broken).
- **Escalation path** lives in the instruction files, not here: any routine that exceeds the Haiku tool budget or requires reasoning is escalated to SRE_Cloud_Guard. Failures are not self-recovered.
- **Rejected alternative — "revert to fork-local `process` adapter."** Rejected per the upkeep argument above. Acknowledged trade-off: we accept a small per-run latency cost and a thin layer of LLM-specific failure modes (rate limit, cold-start) in exchange for staying on upstream Paperclip.
- **Authoritative decision record:** LIF-47. Agent recovery and any subsequent adapter-config changes: SRE_Cloud_Guard on LIF-46.

### HermesAgent substrate — **hermes_local adapter, Gemma 4 A4B via Ollama, Discord approval gateway** ([LIF-232](/LIF/issues/LIF-232), Stage E3)

**Decision.** HermesAgent runs on the `hermes_local` adapter with model `gemma4:26b-a4b-it-q4_K_M` served locally via Ollama (`custom:ollama`). Its action surface is restricted to the V1 allowlist delivered through Stage C wrappers. Approval-required actions route to the Discord relay gateway before execution.

**Why.** Documented in Plan v5 amendment, Stage E3 expansion: [LIF-232](/LIF/issues/LIF-232) comment `b391a54e`. Key reasons:

1. Self-hosted Gemma 4 A4B provides a capable, cost-free inference tier for sudo-class system operations (restarting services, adjusting runner config) without routing sensitive host commands through a cloud LLM provider.
2. Ollama is already deployed on the host; `custom:ollama` backend binds to it without an additional process-adapter layer.
3. The Stage C action wrappers gate every shell invocation through an explicit allowlist — no open-ended shell access at launch. This is the primary safety control for V1.
4. Discord is the existing async notification path (discord-relay PM2 process). Routing approval requests there avoids a second notification surface and reuses the operator's established workflow.

**What this implies.**

- **Adapter**: `hermes_local`. Model identifier: `gemma4:26b-a4b-it-q4_K_M` (Ollama `custom:ollama` backend). Requires Ollama running on the host with the `gemma4:26b-a4b-it-q4_K_M` model pulled.
- **Action allowlist (V1)**: only actions defined in Stage C wrappers may execute. Any action outside the allowlist is rejected at the wrapper layer before reaching the OS.
- **Approval gateway**: actions flagged as approval-required are held and a Discord message is sent to the operator. Execution is blocked until the operator approves. Telegram is deferred (not V1).
- **Escalation path**: actions outside the allowlist or requiring judgment beyond the Stage C scope are escalated via Discord DM to the operator — not auto-executed.
- **Deferred**: Telegram notification path (noted in [LIF-232](/LIF/issues/LIF-232) as a future option alongside Discord). Not in scope for V1.
- **Authoritative decision record:** [LIF-232](/LIF/issues/LIF-232) (Plan v5 amendment, comment `b391a54e`).

### Other decisions

_Add further entries as they come up. Keep each one to the same shape: decision, why, what it implies, authoritative ticket._
