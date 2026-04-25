/**
 * D2/D3 — Discord approval gateway for HermesAgent critical actions.
 *
 * Flow:
 *  1. POST /api/companies/{companyId}/approvals  → creates a pending Paperclip approval
 *  2. POST to DISCORD_WEBHOOK_URL                → embed with review link + 15-min TTL notice
 *  3. Poll GET /api/approvals/{approvalId}       → until approved/rejected or TTL expires
 *  4. Return ApprovalResult to caller
 *
 * The caller (HermesAgent) is responsible for posting a "blocked" comment on the
 * issue when approved=false.
 *
 * Public API surface (no other exports):
 *   requestApproval(actionId, args, requestedBy, cfg?): Promise<ApprovalResult>
 */

export interface ApprovalResult {
  /** true only when a user explicitly approved before the TTL expired */
  approved: boolean;
  /** Paperclip userId of the approver; present only when approved=true */
  approvedBy?: string;
  /** The Paperclip approval ID (acts as the token for audit trail) */
  tokenId: string;
}

export interface ApprovalConfig {
  webhookUrl?: string;
  paperclipApiUrl?: string;
  companyId?: string;
  /** Base URL for deep-links embedded in the Discord message (e.g. https://paperclip.example.com) */
  paperclipPublicUrl?: string;
  /** TTL in ms; defaults to 15 minutes */
  ttlMs?: number;
  /** Poll interval in ms; defaults to 15 seconds */
  pollIntervalMs?: number;
}

interface PaperclipApproval {
  id: string;
  status: "pending" | "revision_requested" | "approved" | "rejected" | "cancelled";
  decidedByUserId: string | null;
}

function buildApprovalRequestPayload(
  actionId: string,
  args: Record<string, string>,
  approvalId: string,
  ttlMinutes: number,
  paperclipPublicUrl?: string,
): object {
  const argsText = Object.entries(args)
    .map(([k, v]) => `\`${k}\`=\`${v}\``)
    .join(", ") || "_none_";

  const reviewUrl = paperclipPublicUrl
    ? `${paperclipPublicUrl.replace(/\/$/, "")}/approvals/${approvalId}`
    : null;

  const description = reviewUrl
    ? `A critical action requires your approval before it executes.\n\n[**Review & Approve / Reject in Paperclip →**](${reviewUrl})`
    : `A critical action requires your approval before it executes.\n\nApproval ID: \`${approvalId}\` — open Paperclip to approve or reject.`;

  const embed: Record<string, unknown> = {
    title: "⚠️ Critical Action — Approval Required",
    description,
    color: 16744272,
    fields: [
      { name: "Action", value: `\`${actionId}\``, inline: true },
      { name: "TTL", value: `${ttlMinutes} min (default: **DENY** on timeout)`, inline: true },
      { name: "Args", value: argsText, inline: false },
    ],
    footer: { text: `Approval ID: ${approvalId}` },
    timestamp: new Date().toISOString(),
  };

  const message: Record<string, unknown> = { embeds: [embed] };

  if (reviewUrl) {
    message["components"] = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Review in Paperclip",
            url: reviewUrl,
          },
        ],
      },
    ];
  }

  return message;
}

async function createPaperclipApproval(
  apiUrl: string,
  companyId: string,
  actionId: string,
  args: Record<string, string>,
  requestedBy: string,
): Promise<string> {
  const res = await fetch(`${apiUrl}/api/companies/${companyId}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "request_board_approval",
      requestedByAgentId: requestedBy,
      payload: { actionId, args },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to create Paperclip approval: HTTP ${res.status}${body ? ` — ${body}` : ""}`,
    );
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

async function pollApproval(
  apiUrl: string,
  approvalId: string,
): Promise<PaperclipApproval> {
  const res = await fetch(`${apiUrl}/api/approvals/${approvalId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to poll approval ${approvalId}: HTTP ${res.status}`);
  }

  return (await res.json()) as PaperclipApproval;
}

async function postDiscordApprovalRequest(
  webhookUrl: string,
  actionId: string,
  args: Record<string, string>,
  approvalId: string,
  ttlMinutes: number,
  paperclipPublicUrl?: string,
): Promise<void> {
  const payload = buildApprovalRequestPayload(
    actionId,
    args,
    approvalId,
    ttlMinutes,
    paperclipPublicUrl,
  );

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 204) {
    throw new Error(
      `Discord webhook returned unexpected status ${res.status} for approval request`,
    );
  }
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

/**
 * Request approval for a critical HermesAgent action via Paperclip + Discord.
 *
 * @param actionId    Registry action id (e.g. "ufw_allow").
 * @param args        Args map for the action.
 * @param requestedBy Paperclip agentId of the requester (HermesAgent's own ID).
 * @param cfg         Optional overrides; defaults to reading process.env.
 *
 * @returns ApprovalResult — caller executes the action only when approved=true.
 */
export async function requestApproval(
  actionId: string,
  args: Record<string, string>,
  requestedBy: string,
  cfg?: ApprovalConfig,
): Promise<ApprovalResult> {
  const webhookUrl = cfg?.webhookUrl ?? process.env["DISCORD_WEBHOOK_URL"];
  const apiUrl =
    cfg?.paperclipApiUrl ??
    process.env["PAPERCLIP_API_URL"] ??
    "http://127.0.0.1:3100";
  const companyId = cfg?.companyId ?? process.env["PAPERCLIP_COMPANY_ID"] ?? "";
  const publicUrl = cfg?.paperclipPublicUrl ?? process.env["PAPERCLIP_PUBLIC_URL"];
  const ttlMs = cfg?.ttlMs ?? DEFAULT_TTL_MS;
  const pollIntervalMs = cfg?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (!companyId) {
    throw new Error(
      "requestApproval: PAPERCLIP_COMPANY_ID is required (set env var or pass cfg.companyId)",
    );
  }

  const approvalId = await createPaperclipApproval(
    apiUrl,
    companyId,
    actionId,
    args,
    requestedBy,
  );

  const ttlMinutes = Math.round(ttlMs / 60_000);

  if (webhookUrl) {
    await postDiscordApprovalRequest(
      webhookUrl,
      actionId,
      args,
      approvalId,
      ttlMinutes,
      publicUrl,
    );
  }

  const deadline = Date.now() + ttlMs;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));

    const approval = await pollApproval(apiUrl, approvalId);

    if (approval.status === "approved") {
      return {
        approved: true,
        approvedBy: approval.decidedByUserId ?? undefined,
        tokenId: approvalId,
      };
    }

    if (approval.status === "rejected" || approval.status === "cancelled") {
      return { approved: false, tokenId: approvalId };
    }
    // status === "pending" | "revision_requested" → keep polling
  }

  // TTL expired — default deny
  return { approved: false, tokenId: approvalId };
}

export {
  buildApprovalRequestPayload as _buildApprovalRequestPayload,
  createPaperclipApproval as _createPaperclipApproval,
};
