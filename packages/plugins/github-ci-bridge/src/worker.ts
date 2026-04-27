import { createHmac, timingSafeEqual } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginConfigValidationResult,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import {
  IDEMPOTENCY_HEADER,
  PLUGIN_ID,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  TIMESTAMP_WINDOW_SECONDS,
  WEBHOOK_KEYS,
} from "./constants.js";

void PLUGIN_ID; // silence unused-import lint — used in manifest, kept here for co-location

// ---------------------------------------------------------------------------
// PluginWebhookResponse
//
// LIF-336 adds this interface to @paperclipai/plugin-sdk and changes
// onWebhook's return type from Promise<void> to Promise<PluginWebhookResponse | void>.
// Until that branch merges, we define it locally and cast at the call site.
// When LIF-336 lands: remove this block and import from "@paperclipai/plugin-sdk".
// ---------------------------------------------------------------------------
interface PluginWebhookResponse {
  ok: boolean;
  status: number;
  reason?: string;
  deliveryMetadata?: {
    deliveryStatus?: "accepted" | "unresolved";
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface GithubCiBridgeConfig {
  webhookSecret: string[];
  repoAllowlist?: string[];
}

function parseConfig(raw: Record<string, unknown>): GithubCiBridgeConfig {
  const secrets = Array.isArray(raw.webhookSecret)
    ? (raw.webhookSecret as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const allowlist = Array.isArray(raw.repoAllowlist)
    ? (raw.repoAllowlist as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  return { webhookSecret: secrets, repoAllowlist: allowlist };
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

function computeSignature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time string comparison — avoids timing oracle on different-length strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Returns true if any secret in `secrets` produces a signature matching `sig`. */
function verifySignature(secrets: string[], sig: string, body: string): boolean {
  for (const secret of secrets) {
    if (safeEqual(computeSignature(secret, body), sig)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function accept(meta?: PluginWebhookResponse["deliveryMetadata"]): PluginWebhookResponse {
  return {
    ok: true,
    status: 202,
    deliveryMetadata: { deliveryStatus: "accepted", ...meta },
  };
}

function unresolved(meta: Record<string, unknown>): PluginWebhookResponse {
  return {
    ok: true,
    status: 202,
    deliveryMetadata: { deliveryStatus: "unresolved", ...meta },
  };
}

function reject401(reason: "invalid_signature" | "replay" | "malformed"): PluginWebhookResponse {
  return { ok: false, status: 401, reason };
}

// ---------------------------------------------------------------------------
// Payload shape helpers
// ---------------------------------------------------------------------------

interface WorkflowRunPr {
  number: number;
  head: { ref: string; sha?: string };
}

interface WorkflowRunPayload {
  workflow_run: {
    id: number;
    run_attempt: number;
    head_branch: string | null;
    conclusion: string | null;
    html_url?: string;
    pull_requests: WorkflowRunPr[];
  };
  repository: {
    full_name: string;
  };
}

function parseWorkflowRunPayload(body: unknown): WorkflowRunPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!b.workflow_run || typeof b.workflow_run !== "object") return null;
  if (!b.repository || typeof b.repository !== "object") return null;
  const wf = b.workflow_run as Record<string, unknown>;
  const repo = b.repository as Record<string, unknown>;
  if (typeof repo.full_name !== "string") return null;
  return {
    workflow_run: {
      id: typeof wf.id === "number" ? wf.id : 0,
      run_attempt: typeof wf.run_attempt === "number" ? wf.run_attempt : 1,
      head_branch: typeof wf.head_branch === "string" ? wf.head_branch : null,
      conclusion: typeof wf.conclusion === "string" ? wf.conclusion : null,
      html_url: typeof wf.html_url === "string" ? wf.html_url : undefined,
      pull_requests: Array.isArray(wf.pull_requests)
        ? (wf.pull_requests as unknown[]).filter(
            (pr): pr is WorkflowRunPr =>
              typeof pr === "object" &&
              pr !== null &&
              typeof (pr as Record<string, unknown>).number === "number" &&
              typeof ((pr as Record<string, unknown>).head as Record<string, unknown> | undefined)?.ref === "string",
          )
        : [],
    },
    repository: { full_name: repo.full_name as string },
  };
}

// ---------------------------------------------------------------------------
// Issue resolver (payload-only, no outbound HTTP) — LIF-335 plan §4.2
// ---------------------------------------------------------------------------

/** Matches standard company issue identifiers like LIF-344, PAP-12 (known prefixes first, then 2–5 caps, dash, digits). */
const ISSUE_IDENTIFIER_RE = /((?:LIF|PAP|[A-Z]{2,5})-\d+)/;

interface ResolveResult {
  issueId: string;
  prNumber?: number;
}

/**
 * Attempt to resolve a workflow_run event to a Paperclip issue using only
 * local DB state — no outbound HTTP calls.
 *
 * Resolution order (per §4.2):
 * 1. execution_workspaces lookup: branch_name exact match + repo_url LIKE %repoFullName%
 * 2. Regex on branch for a known issue identifier prefix, then issues lookup.
 *
 * Returns null when neither approach resolves.
 */
async function resolveIssue(
  ctx: PluginContext,
  branch: string,
  repoFullName: string,
  prNumber?: number,
): Promise<ResolveResult | null> {
  // Step 1 (plan §4.2 step 3): execution_workspaces lookup
  try {
    const rows = await ctx.db.query<{ source_issue_id: string | null }>(
      `SELECT source_issue_id
       FROM public.execution_workspaces
       WHERE branch_name = $1
         AND repo_url LIKE $2
         AND source_issue_id IS NOT NULL
       LIMIT 1`,
      [branch, `%${repoFullName}%`],
    );
    if (rows.length > 0 && rows[0]!.source_issue_id) {
      return { issueId: rows[0]!.source_issue_id, prNumber };
    }
  } catch {
    // DB namespace may not be active yet or query failed — fall through to regex
  }

  // Step 2 (plan §4.2 step 4): Regex fallback — extract identifier from branch name
  const match = ISSUE_IDENTIFIER_RE.exec(branch);
  if (match) {
    const identifier = match[1]!.toUpperCase();
    try {
      const rows = await ctx.db.query<{ id: string }>(
        `SELECT id
         FROM public.issues
         WHERE UPPER(identifier) = $1
         LIMIT 1`,
        [identifier],
      );
      if (rows.length > 0 && rows[0]!.id) {
        return { issueId: rows[0]!.id, prNumber };
      }
    } catch {
      // fall through to unresolved
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core webhook handler (returns PluginWebhookResponse, called from onWebhook)
// ---------------------------------------------------------------------------

async function handleCiEvent(
  input: PluginWebhookInput,
  config: GithubCiBridgeConfig,
  ctx: PluginContext,
): Promise<PluginWebhookResponse> {
  // 1. Require signature + timestamp headers
  const sigHeader = firstHeader(input.headers[SIGNATURE_HEADER]);
  const tsHeader = firstHeader(input.headers[TIMESTAMP_HEADER]);
  if (!sigHeader || !tsHeader) {
    return reject401("invalid_signature");
  }

  // 2. Timestamp window — reject replays
  const tsSeconds = parseInt(tsHeader, 10);
  if (!Number.isFinite(tsSeconds)) {
    return reject401("malformed");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > TIMESTAMP_WINDOW_SECONDS) {
    return reject401("replay");
  }

  // 3. Must have at least one configured secret
  const { webhookSecret: secrets, repoAllowlist } = config;
  if (secrets.length === 0) {
    return reject401("invalid_signature");
  }

  // 4. HMAC-SHA256 signature verification (any matching secret accepts)
  if (!verifySignature(secrets, sigHeader, input.rawBody)) {
    return reject401("invalid_signature");
  }

  // 5. Parse workflow_run payload
  const payload = parseWorkflowRunPayload(input.parsedBody);
  if (!payload) {
    // Signature valid but body is not a workflow_run event — treat as unresolved audit row
    return unresolved({ reason: "malformed_payload" });
  }

  const repoFullName = payload.repository.full_name;

  // 6. Optional repo allowlist check (post-HMAC so we don't leak repo membership to unsigned callers)
  if (repoAllowlist && repoAllowlist.length > 0) {
    if (!repoAllowlist.includes(repoFullName)) {
      return reject401("invalid_signature");
    }
  }

  // 7. Extract branch (plan §4.2 steps 1–2)
  const firstPr = payload.workflow_run.pull_requests[0];
  const branch = firstPr?.head.ref ?? payload.workflow_run.head_branch;
  const prNumber = firstPr?.number;
  const conclusion = payload.workflow_run.conclusion;
  const runId = payload.workflow_run.id;
  const runAttempt = payload.workflow_run.run_attempt;

  if (!branch) {
    return unresolved({ reason: "no_branch", conclusion, runId, runAttempt });
  }

  // 8. Resolve branch → issue (plan §4.2 steps 3–5)
  const resolved = await resolveIssue(ctx, branch, repoFullName, prNumber ?? undefined);

  if (!resolved) {
    // Plan §4.2 step 5 + §5: return ok:true so core writes an unresolved audit row
    return unresolved({ branch, conclusion, runId, runAttempt, prNumber: prNumber ?? null });
  }

  // 9. Accepted — issue resolved; reactions handled in T5 (LIF-345)
  const idempotencyKey = firstHeader(input.headers[IDEMPOTENCY_HEADER]);
  return accept({
    issueId: resolved.issueId,
    prNumber: resolved.prNumber ?? null,
    branch,
    conclusion,
    runId,
    runAttempt,
    runUrl: payload.workflow_run.html_url ?? null,
    idempotencyKey: idempotencyKey ?? null,
  });
}

// ---------------------------------------------------------------------------
// Plugin state — populated by setup(), refreshed by onConfigChanged()
// ---------------------------------------------------------------------------

let currentCtx: PluginContext | null = null;
let currentConfig: GithubCiBridgeConfig = { webhookSecret: [] };

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    currentCtx = ctx;
    const raw = (await ctx.config.get()) as Record<string, unknown>;
    currentConfig = parseConfig(raw ?? {});
  },

  async onConfigChanged(newConfig: Record<string, unknown>): Promise<void> {
    currentConfig = parseConfig(newConfig ?? {});
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const hasSecrets = currentConfig.webhookSecret.length > 0;
    return {
      status: hasSecrets ? "ok" : "degraded",
      message: hasSecrets
        ? "github-ci-bridge ready"
        : "No webhook secrets configured — all deliveries will be rejected",
      details: {
        secretCount: currentConfig.webhookSecret.length,
        repoAllowlistSize: currentConfig.repoAllowlist?.length ?? 0,
      },
    };
  },

  async onValidateConfig(config: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(config.webhookSecret)) {
      errors.push("webhookSecret must be an array of strings");
    } else if ((config.webhookSecret as unknown[]).length === 0) {
      errors.push("webhookSecret must contain at least one secret");
    } else if (!(config.webhookSecret as unknown[]).every((s) => typeof s === "string" && s.length > 0)) {
      errors.push("All webhookSecret entries must be non-empty strings");
    }

    if (config.repoAllowlist !== undefined) {
      if (!Array.isArray(config.repoAllowlist)) {
        errors.push("repoAllowlist must be an array of strings when provided");
      } else if (!(config.repoAllowlist as unknown[]).every((s) => typeof s === "string")) {
        errors.push("All repoAllowlist entries must be strings");
      }
    }

    if ((config.webhookSecret as string[] | undefined)?.length === 1) {
      warnings.push(
        "Consider adding a second secret now to enable zero-downtime rotation later.",
      );
    }

    return { ok: errors.length === 0, errors, warnings };
  },

  // Cast: remove once LIF-336 merges and SDK changes onWebhook return type
  // to Promise<PluginWebhookResponse | void>.
  async onWebhook(input: PluginWebhookInput): Promise<void> {
    const ctx = currentCtx;
    if (!ctx) {
      return reject401("invalid_signature") as unknown as void;
    }
    if (input.endpointKey !== WEBHOOK_KEYS.ciEvent) {
      return reject401("invalid_signature") as unknown as void;
    }
    return handleCiEvent(input, currentConfig, ctx) as unknown as void;
  },

  async onShutdown(): Promise<void> {
    currentCtx = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
