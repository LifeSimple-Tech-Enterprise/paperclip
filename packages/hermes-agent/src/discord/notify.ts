/**
 * HermesAgent Stage D, sub-stage D1 (LIF-238).
 *
 * notifyExecuted — post a routine "did X" audit ping to Discord via
 * DISCORD_WEBHOOK_URL. No-op when the env var is unset, so unit / integration
 * environments without secrets never reach the production channel.
 *
 * Surface: single async function `notifyExecuted` plus its input type.
 * No other public exports.
 *
 * Used by the Stage C executor after a routine action wrapper exits, to
 * append a human-visible audit ping alongside the per-issue audit comment.
 * Best-effort: failures are logged but never thrown (the action has already
 * run; webhook flake must not corrupt the executor's exit code).
 */

const WEBHOOK_URL_ENV = "DISCORD_WEBHOOK_URL";
const NOTIFY_TIMEOUT_MS = 5_000;
const LOG_EXCERPT_MAX = 1_500;
const COLOR_SUCCESS = 0x22c55e;
const COLOR_FAILURE = 0xef4444;

export interface NotifyExecutedInput {
  /** V1 action id (e.g. `service_restart_paperclip`). */
  actionId: string;
  /** Action arguments, as resolved by the registry argsSchema. */
  args: Record<string, string>;
  /** Wrapper exit code (0 == success). */
  exitCode: number;
  /** Tail of the wrapper log; truncated to ~1.5 KB before sending. */
  logExcerpt: string;
}

export async function notifyExecuted(input: NotifyExecutedInput): Promise<void> {
  const url = process.env[WEBHOOK_URL_ENV];
  if (!url) return;

  const payload = buildExecutedPayload(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[hermes:notify] Discord webhook returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(
      `[hermes:notify] Webhook POST failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

interface DiscordWebhookPayload {
  username: string;
  embeds: {
    title: string;
    color: number;
    fields: { name: string; value: string; inline?: boolean }[];
    timestamp: string;
  }[];
}

function buildExecutedPayload(input: NotifyExecutedInput): DiscordWebhookPayload {
  const success = input.exitCode === 0;
  const status = success
    ? "✅ success"
    : `❌ failure (exit=${input.exitCode})`;

  const argsList =
    Object.entries(input.args)
      .map(([k, v]) => `**${k}**: \`${v}\``)
      .join("\n") || "_(no args)_";

  const excerpt =
    input.logExcerpt.length > LOG_EXCERPT_MAX
      ? input.logExcerpt.slice(0, LOG_EXCERPT_MAX) + "\n…(truncated)"
      : input.logExcerpt;

  return {
    username: "HermesAgent",
    embeds: [
      {
        title: `Hermes executed: ${input.actionId}`,
        color: success ? COLOR_SUCCESS : COLOR_FAILURE,
        fields: [
          { name: "Status", value: status, inline: true },
          { name: "Action", value: input.actionId, inline: true },
          { name: "Args", value: argsList },
          {
            name: "Log excerpt",
            value: excerpt ? "```" + excerpt + "```" : "_(empty)_",
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
