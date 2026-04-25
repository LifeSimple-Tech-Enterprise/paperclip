/**
 * HermesAgent Stage D, sub-stages D2 + D3 (LIF-238).
 *
 * requestApproval — critical-action approval gateway:
 *   1. POST /api/companies/:companyId/approvals  (type: request_board_approval)
 *      — creates a board-visible approval row linked to the calling issue.
 *   2. POST DISCORD_WEBHOOK_URL with an embed deep-linking to the Paperclip
 *      approval page. Per LIF-232 plan v4 §D2, interactive Approve/Deny
 *      buttons require a Discord application; v1 ships with a deep-link
 *      instead — the human clicks Approve in Paperclip, the server flips
 *      `approval.status` to `approved`/`rejected`, and the requester wakes.
 *      The deep-link approach reuses the existing webhook with no new bot.
 *   3. Poll GET /api/approvals/:id every `HERMES_APPROVAL_POLL_MS` (default
 *      10 s) until the status leaves `pending`/`revision_requested`, or the
 *      `HERMES_APPROVAL_TTL_MS` (default 15 min) elapses. **Default-deny on
 *      timeout.**
 *   4. Return `{ approved, approvedBy?, tokenId }`.
 *
 * Required env:
 *   PAPERCLIP_API_URL         e.g. http://127.0.0.1:9090
 *   PAPERCLIP_API_KEY         agent JWT
 *   PAPERCLIP_COMPANY_ID      uuid
 *   PAPERCLIP_AGENT_ID        uuid (the requesting Hermes agent id)
 *
 * Optional env:
 *   DISCORD_WEBHOOK_URL       skipped if unset (approval still created and
 *                             polled — the Paperclip UI is sufficient).
 *   PAPERCLIP_PUBLIC_URL      base URL of Paperclip UI; deep-link prefix.
 *                             Falls back to PAPERCLIP_API_URL.
 *   HERMES_APPROVAL_TTL_MS    override the 15-min TTL (test hook).
 *   HERMES_APPROVAL_POLL_MS   override the 10-s poll interval (test hook).
 *
 * Surface: `requestApproval` + input/output types. No other public exports.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1_000; // 15 minutes
const DEFAULT_POLL_MS = 10_000; // 10 seconds
const COLOR_PENDING = 0xf59e0b;

export interface RequestApprovalInput {
  /** V1 critical action id (e.g. `ufw_allow`). */
  actionId: string;
  /** Action arguments resolved by the registry argsSchema. */
  args: Record<string, string>;
  /** Identifier of the requester (typically the originating issue's actor). */
  requestedBy: string;
}

export interface ApprovalResult {
  /** True iff the approval entered `approved` state before the TTL expired. */
  approved: boolean;
  /** User id of the human approver, when known. */
  approvedBy?: string;
  /** Paperclip approval id; useful for audit-log correlation. */
  tokenId: string;
}

interface PaperclipApproval {
  id: string;
  status:
    | "pending"
    | "revision_requested"
    | "approved"
    | "rejected"
    | (string & {});
  decidedByUserId?: string | null;
}

export async function requestApproval(
  input: RequestApprovalInput,
): Promise<ApprovalResult> {
  const env = readEnv();
  const ttlMs = parseIntEnv("HERMES_APPROVAL_TTL_MS") ?? DEFAULT_TTL_MS;
  const pollMs = parseIntEnv("HERMES_APPROVAL_POLL_MS") ?? DEFAULT_POLL_MS;

  // 1. Create the Paperclip approval.
  const approval = await createApproval(env, input);
  const tokenId = approval.id;

  // 2. Best-effort Discord notification with a deep-link to Paperclip.
  await notifyDiscordApprovalRequest(env, approval, input);

  // 3. Poll until decided or TTL elapses (default-deny on timeout).
  const deadline = Date.now() + ttlMs;
  // First poll honors the same interval so a fast approval doesn't hot-loop.
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollMs, Math.max(0, remaining)));
    if (Date.now() >= deadline) break;

    const fresh = await pollApproval(env, tokenId);
    if (fresh.status === "approved") {
      return {
        approved: true,
        approvedBy: fresh.decidedByUserId ?? undefined,
        tokenId,
      };
    }
    if (fresh.status === "rejected") {
      return {
        approved: false,
        approvedBy: fresh.decidedByUserId ?? undefined,
        tokenId,
      };
    }
    // pending / revision_requested → keep polling.
  }

  // Default-deny on timeout (per LIF-232 plan v4 §0.6).
  return { approved: false, tokenId };
}

interface Env {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  agentId: string;
  runId: string;
  webhookUrl: string | undefined;
  publicUrl: string;
}

function readEnv(): Env {
  const apiUrl = mustEnv("PAPERCLIP_API_URL");
  const apiKey = mustEnv("PAPERCLIP_API_KEY");
  const companyId = mustEnv("PAPERCLIP_COMPANY_ID");
  const agentId = mustEnv("PAPERCLIP_AGENT_ID");
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    apiKey,
    companyId,
    agentId,
    runId: process.env.PAPERCLIP_RUN_ID ?? "",
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    publicUrl: (process.env.PAPERCLIP_PUBLIC_URL ?? apiUrl).replace(/\/$/, ""),
  };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Stage D requires env var ${name}`);
  }
  return v;
}

function parseIntEnv(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function createApproval(
  env: Env,
  input: RequestApprovalInput,
): Promise<PaperclipApproval> {
  const issueId = process.env.PAPERCLIP_TASK_ID;
  const body: Record<string, unknown> = {
    type: "request_board_approval",
    requestedByAgentId: env.agentId,
    payload: {
      reason: `HermesAgent critical-action approval: ${input.actionId}`,
      hermes: {
        actionId: input.actionId,
        args: input.args,
        requestedBy: input.requestedBy,
      },
    },
  };
  if (issueId) {
    body.issueIds = [issueId];
  }

  const res = await fetch(
    `${env.apiUrl}/api/companies/${env.companyId}/approvals`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": env.runId,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Approval create failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as PaperclipApproval;
}

async function pollApproval(
  env: Env,
  tokenId: string,
): Promise<PaperclipApproval> {
  const res = await fetch(`${env.apiUrl}/api/approvals/${tokenId}`, {
    headers: { Authorization: `Bearer ${env.apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Approval poll failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as PaperclipApproval;
}

async function notifyDiscordApprovalRequest(
  env: Env,
  approval: PaperclipApproval,
  input: RequestApprovalInput,
): Promise<void> {
  if (!env.webhookUrl) return;

  const reviewUrl = `${env.publicUrl}/approvals/${approval.id}`;
  const argsList =
    Object.entries(input.args)
      .map(([k, v]) => `**${k}**: \`${v}\``)
      .join("\n") || "_(no args)_";

  const payload = {
    username: "HermesAgent",
    embeds: [
      {
        title: `Approval needed: ${input.actionId}`,
        description:
          "Critical action requires approval (15-min TTL, default-deny).\n\n" +
          `[Review & decide in Paperclip](${reviewUrl})`,
        color: COLOR_PENDING,
        fields: [
          { name: "Action", value: input.actionId, inline: true },
          { name: "Requested by", value: input.requestedBy, inline: true },
          { name: "Approval id", value: approval.id, inline: false },
          { name: "Args", value: argsList },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(env.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[hermes:approval] Discord notify HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    // Notification is best-effort; the approval row already exists.
    console.error(
      `[hermes:approval] Discord notify failed: ${(err as Error).message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
