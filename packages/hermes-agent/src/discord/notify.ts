/**
 * D1 — Routine "did X" Discord notifications via webhook.
 *
 * Reads DISCORD_WEBHOOK_URL from the environment. No-ops silently if the var is
 * unset so that the module can be imported in test/staging environments without a
 * live webhook URL.
 */

export interface NotifyConfig {
  webhookUrl?: string;
}

function buildNotifyPayload(
  actionId: string,
  args: Record<string, string>,
  exitCode: number,
  logExcerpt: string,
): object {
  const success = exitCode === 0;
  const argsText = Object.entries(args)
    .map(([k, v]) => `\`${k}\`=\`${v}\``)
    .join(", ") || "_none_";

  const excerptBlock =
    logExcerpt.trim().length > 0
      ? `\`\`\`\n${logExcerpt.slice(0, 1800)}\n\`\`\``
      : "_no output_";

  return {
    embeds: [
      {
        title: `${success ? "✅" : "❌"} HermesAgent executed \`${actionId}\``,
        color: success ? 3066993 : 15158332,
        fields: [
          { name: "Action", value: `\`${actionId}\``, inline: true },
          { name: "Exit code", value: `\`${exitCode}\``, inline: true },
          { name: "Args", value: argsText, inline: false },
          { name: "Log excerpt", value: excerptBlock, inline: false },
        ],
        footer: { text: "HermesAgent audit trail" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Post a routine "action executed" notification to Discord.
 *
 * @param actionId   The registry action id that was run.
 * @param args       The args map passed to the action.
 * @param exitCode   Shell exit code of the wrapper (0 = success).
 * @param logExcerpt Tail of the action log (truncated to 1800 chars in the embed).
 * @param cfg        Optional overrides; defaults to reading process.env.
 */
export async function notifyExecuted(
  actionId: string,
  args: Record<string, string>,
  exitCode: number,
  logExcerpt: string,
  cfg?: NotifyConfig,
): Promise<void> {
  const webhookUrl = cfg?.webhookUrl ?? process.env["DISCORD_WEBHOOK_URL"];
  if (!webhookUrl) {
    return;
  }

  const payload = buildNotifyPayload(actionId, args, exitCode, logExcerpt);

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 204) {
    throw new Error(
      `Discord webhook returned unexpected status ${res.status} for notifyExecuted`,
    );
  }
}

export { buildNotifyPayload as _buildNotifyPayload };
