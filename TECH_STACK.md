# TECH_STACK.md — Paperclip (upstream)

> Platform, tooling, test frameworks, and environment contract for Paperclip. Owned by the Lead Engineer. Downstream agents (QA_Acceptance, QA_Unit, Drafter, Critique, SRE) read this file on every heartbeat and auto-adapt.

## Language / runtime
- **Node.js** + **TypeScript** (pnpm workspace). See root `package.json` / `pnpm-workspace.yaml`.
- Package manager: `pnpm`.

## Application surface
- `server/` — Node.js HTTP API (the Paperclip control plane).
- `ui/` — React UI.
- `cli/` — admin CLI.

## Test frameworks
- **Unit / integration:** Vitest (`vitest.config.ts` at the repo root and per-package).
- **E2E:** Playwright (owned by QA_Acceptance). Spec lives under `tests/e2e/` in whichever repo owns the feature. For the process-adapter plugin the E2E suite lives in the **standalone plugin repo** (`github.com/isaacyip007/process-adapter`), not upstream.
- **Locator strategy:** `data-testid` attributes, snake-case names keyed to the feature spec. See `PLAN.md` §4 on each feature issue for the per-feature locator contract.
- **Test utility path convention:** `tests/e2e/support/test-utils.ts`. Mirrored in the standalone plugin repo.

## Commands
- Unit tests (root): `pnpm -r test` or `pnpm test` in the affected package.
- Lint: `pnpm -r lint`.
- Typecheck: `pnpm -r typecheck`.
- Build: `pnpm -r build`.

## Plugin system

### Install transport — **git clone** (load-bearing; per LIF-24)

- **`POST /api/plugins/install` primary path:** `source: "git"` with `{ repo, ref }`. `ref` is **required** and must be a pinned sha or annotated tag (no floating refs at launch).
- **Runtime dependency:** the `git` binary must be on `PATH`. Present on dev hosts; SRE follow-up tracks presence in any future container image (non-blocking).
- **Auth at launch:** public HTTPS only. Deploy-key / PAT / SSH plumbing is deferred — see `PROJECT.md` for the reasoning.
- **Dev fallback:** `PAPERCLIP_PLUGIN_DEV_SEED=1` + `PAPERCLIP_PLUGIN_DEV_SEED_MAP` (JSON `{ "<plugin-name>": "<abs-path>" }`). Prod boot logs a WARN if the dev-seed env gate is on.
- **Curated examples:** `source: "example"` resolves to canonical `{ repo, ref }` via an internal map. Initial entry: `process-adapter` → `github.com/isaacyip007/process-adapter` at a pinned ref.
- **Deferred sources** (contract leaves room): `source: "npm"`, `source: "tarball"`. Do not implement at launch.
- See `PROJECT.md` → "Plugin install transport" for the full decision context.

### Plugin repositories (first-party)
- **process-adapter** — `github.com/isaacyip007/process-adapter` (public; private-use plugin).

## Environment config
- `NODE_ENV` — `development` | `production`.
- `PAPERCLIP_PLUGIN_DEV_SEED` — `0` | `1` (dev overlay gate).
- `PAPERCLIP_PLUGIN_DEV_SEED_MAP` — JSON map of plugin name → absolute local path.
- `PAPERCLIP_E2E_PORT` — port the E2E suite targets when running against a local instance.

## AI / agents

- **Hermes Agent CLI** (Nous Research) — local agent runtime for the `hermes_local` adapter. Acts as a privileged system operator: executes allowlisted sudo-class actions (service restarts, runner config adjustments) on behalf of Paperclip issues. Pings the operator via Discord for approval-gated actions. Upstream repo: `https://github.com/NousResearch/hermes-function-calling`. Cross-reference: [LIF-232](/LIF/issues/LIF-232) Plan v5 amendment comment `b391a54e`.

## Infra

- **Ollama** — local LLM inference server. Serves `gemma4:26b-a4b-it-q4_K_M` (Gemma 4 A4B int4 quantised) as the HermesAgent model backend (`custom:ollama`). Must be running on the host with the model pulled before `hermes_local` adapter wakes. Cross-reference: [LIF-232](/LIF/issues/LIF-232) Plan v5 amendment comment `b391a54e`.

## Ownership notes
- This file is maintained by the **Lead Engineer**. Downstream agents adapt to platform pivots automatically on their next heartbeat — no AGENTS.md rewrites required.
- Change this file when: a test framework changes, the locator strategy changes, the plugin install transport changes, or an environment variable contract changes.
