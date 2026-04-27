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

function reject401(reason: "invalid_signature" | "replay" | "malformed"): PluginWebhookResponse {
  return { ok: false, status: 401, reason };
}

// ---------------------------------------------------------------------------
// Core webhook handler (returns PluginWebhookResponse, called from onWebhook)
// ---------------------------------------------------------------------------

async function handleCiEvent(
  input: PluginWebhookInput,
  config: GithubCiBridgeConfig,
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

  // 5. Optional repo allowlist
  if (repoAllowlist && repoAllowlist.length > 0) {
    const parsed = input.parsedBody as Record<string, unknown> | undefined;
    const repoFullName = (parsed?.repository as Record<string, unknown> | undefined)?.full_name;
    if (typeof repoFullName !== "string" || !repoAllowlist.includes(repoFullName)) {
      return reject401("invalid_signature");
    }
  }

  // 6. Valid — placeholder acceptance (issue resolution in T4, reactions in T5)
  const idempotencyKey = firstHeader(input.headers[IDEMPOTENCY_HEADER]);
  return accept(idempotencyKey ? { idempotencyKey } : undefined);
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
    if (input.endpointKey !== WEBHOOK_KEYS.ciEvent) {
      // Unexpected endpoint — return 401 so core writes nothing.
      return reject401("invalid_signature") as unknown as void;
    }
    return handleCiEvent(input, currentConfig) as unknown as void;
  },

  async onShutdown(): Promise<void> {
    currentCtx = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
