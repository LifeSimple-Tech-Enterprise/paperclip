/**
 * HermesAgent V1 failure notifier — Stage D stub (LIF-248).
 *
 * Stage D will own the real critical-pager flow. For V1 this is a best-effort
 * stub: always logs to `console.error`; if `DISCORD_WEBHOOK_URL` is set, POSTs
 * a minimal JSON payload and ignores non-2xx responses.
 *
 * The real Stage D pager is in `@paperclipai/hermes-agent/discord` (approval.ts).
 * This module is intentionally kept thin — no retries, no queue, no threading.
 */

export interface NotifyContext {
  /** Defaults to `process.env.DISCORD_WEBHOOK_URL`. */
  webhookUrl?: string;
  /** Override the global `fetch` for tests. */
  fetchImpl?: typeof fetch;
}

export async function notifyExecutionFailure(
  args: {
    issueId: string;
    actionId: string;
    exitCode: number;
    stderrTruncated: string;
  },
  ctx?: NotifyContext,
): Promise<void> {
  const { issueId, actionId, exitCode, stderrTruncated } = args;

  // Always log locally.
  console.error(
    `[hermes] execution failure: issueId=${issueId} actionId=${actionId} exitCode=${exitCode}`,
    stderrTruncated.slice(0, 200),
  );

  const webhookUrl = ctx?.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const fetchFn = ctx?.fetchImpl ?? fetch;
  try {
    await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content:
          `**Hermes execution failure**\n` +
          `action_id: \`${actionId}\`\n` +
          `issue: \`${issueId}\`\n` +
          `exit_code: \`${exitCode}\``,
      }),
    });
    // Non-2xx responses are intentionally ignored (best-effort).
  } catch {
    // Network errors are ignored — best-effort only.
  }
}
