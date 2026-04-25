#!/usr/bin/env node
/**
 * HermesAgent process-adapter entrypoint — Stage B4 (LIF-240).
 *
 * State machine follows HEARTBEAT.md in
 *   paperclip/agents/hermes-agent/instructions/HEARTBEAT.md
 *
 * Allowed Paperclip endpoints (TOOLS.md §2):
 *   GET  /api/issues/:id/comments/:commentId   (self-comment guard)
 *   POST /api/issues/:id/checkout              (lock)
 *   GET  /api/issues/:id/heartbeat-context     (issue + cursor)
 *   GET  /api/issues/:id/comments?after=:cursor&order=asc&limit=1
 *   POST /api/issues/:id/comments              (audit comment)
 *
 * All mutating requests include X-Paperclip-Run-Id.
 * No PATCH, no subtask creation, no approvals, no status transitions.
 *
 * Exit codes:
 *   0  — any successfully posted comment (accepted or rejected intent)
 *   1  — infrastructure failure (Paperclip API down, Ollama unreachable)
 */

import { parseIntent } from "./intent.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import {
  formatIntentAcceptedComment,
  formatIntentRejectedComment,
  formatExecutionResultComment,
} from "./audit.js";
import { executeIntent } from "@paperclipai/hermes-actions/executor";
import { handleExecutionFailure } from "@paperclipai/hermes-actions/failure-handler";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const API_URL = process.env.PAPERCLIP_API_URL ?? "";
const API_KEY = process.env.PAPERCLIP_API_KEY ?? "";
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID ?? "";
const TASK_ID = process.env.PAPERCLIP_TASK_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID ?? "";
const WAKE_COMMENT_ID = process.env.PAPERCLIP_WAKE_COMMENT_ID;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a Paperclip API endpoint with auth headers. */
async function paperclipGet(path: string): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });
}

/** POST to a Paperclip API endpoint (includes audit run-id header). */
async function paperclipPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": RUN_ID,
    },
    body: JSON.stringify(body),
  });
}

/** Post an audit comment on the wake issue. Throws on API failure. */
async function postComment(body: string): Promise<void> {
  const res = await paperclipPost(`/api/issues/${TASK_ID}/comments`, { body });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Comment POST failed (HTTP ${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 0: PAPERCLIP_TASK_ID is required; no-op heartbeat otherwise.
  if (!TASK_ID) {
    console.error("[hermes] No PAPERCLIP_TASK_ID — no-op heartbeat.");
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Step 1: Self-comment guard (HEARTBEAT.md §1)
  // -------------------------------------------------------------------------
  if (WAKE_COMMENT_ID) {
    const res = await paperclipGet(
      `/api/issues/${TASK_ID}/comments/${WAKE_COMMENT_ID}`,
    );
    if (res.ok) {
      const comment = (await res.json()) as { authorAgentId?: string };
      if (comment.authorAgentId === AGENT_ID) {
        console.error(
          "[hermes] Wake comment authored by self — exiting 0 (loop guard).",
        );
        process.exit(0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Checkout (HEARTBEAT.md §2)
  // -------------------------------------------------------------------------
  const checkoutRes = await paperclipPost(`/api/issues/${TASK_ID}/checkout`, {
    agentId: AGENT_ID,
    expectedStatuses: ["todo", "in_progress", "blocked"],
  });

  if (checkoutRes.status === 409) {
    console.error("[hermes] 409 Conflict on checkout — not retrying.");
    process.exit(0);
  }

  if (!checkoutRes.ok) {
    const text = await checkoutRes.text().catch(() => "(no body)");
    console.error(
      `[hermes] Checkout failed (HTTP ${checkoutRes.status}): ${text}`,
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Step 3: Read inputs (HEARTBEAT.md §3)
  // -------------------------------------------------------------------------
  const ctxRes = await paperclipGet(
    `/api/issues/${TASK_ID}/heartbeat-context`,
  );
  if (!ctxRes.ok) {
    const text = await ctxRes.text().catch(() => "(no body)");
    console.error(
      `[hermes] heartbeat-context failed (HTTP ${ctxRes.status}): ${text}`,
    );
    process.exit(1);
  }

  const ctx = (await ctxRes.json()) as {
    issue?: { title?: string; description?: string };
    commentCursor?: { latestCommentId?: string | null };
  };

  const issueTitle = ctx.issue?.title ?? "(no title)";
  const issueBody = ctx.issue?.description ?? "";

  // Fetch the single comment Hermes is allowed to see per heartbeat.
  let latestComment: { body: string } | null = null;

  if (WAKE_COMMENT_ID) {
    // Self-comment guard already confirmed this is not our own comment.
    const res = await paperclipGet(
      `/api/issues/${TASK_ID}/comments/${WAKE_COMMENT_ID}`,
    );
    if (res.ok) {
      latestComment = (await res.json()) as { body: string };
    }
  } else {
    const cursor = ctx.commentCursor?.latestCommentId;
    if (cursor) {
      const res = await paperclipGet(
        `/api/issues/${TASK_ID}/comments?after=${cursor}&order=asc&limit=1`,
      );
      if (res.ok) {
        const data = (await res.json()) as {
          items?: { body: string }[];
          data?: { body: string }[];
        };
        const items =
          (data as { items?: { body: string }[] }).items ??
          (data as { data?: { body: string }[] }).data ??
          [];
        latestComment = items[0] ?? null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Build model prompt (HEARTBEAT.md §4)
  // -------------------------------------------------------------------------
  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(
    { title: issueTitle, body: issueBody },
    latestComment,
  );

  // -------------------------------------------------------------------------
  // Step 5: Call Ollama (HEARTBEAT.md §5)
  // -------------------------------------------------------------------------
  let ollamaRaw: string;

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 30_000);

    let ollamaRes: Response;
    try {
      ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "hermes-gemma4",
          stream: false,
          format: "json",
          options: { temperature: 0.2, num_predict: 256 },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => "");
      const comment = formatIntentRejectedComment({
        ok: false,
        code: "ollama_unreachable",
        message: `Ollama returned HTTP ${ollamaRes.status}: ${errText.slice(0, 200)}`,
      });
      await postComment(comment);
      process.exit(1);
    }

    const ollamaBody = (await ollamaRes.json()) as {
      message?: { content?: string };
    };
    ollamaRaw = ollamaBody.message?.content ?? "";
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === "AbortError";
    const message = isTimeout
      ? "Ollama request timed out after 30 s."
      : `Ollama unreachable: ${(err as Error).message}`;

    console.error(`[hermes] ${message}`);

    const comment = formatIntentRejectedComment({
      ok: false,
      code: "ollama_unreachable",
      message,
    });
    await postComment(comment);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Step 6: Validate (HEARTBEAT.md §6)
  // -------------------------------------------------------------------------
  const result = parseIntent(ollamaRaw);

  // -------------------------------------------------------------------------
  // Step 7: Post audit comment (accepted or rejected intent).
  // -------------------------------------------------------------------------
  const commentBody = result.ok
    ? formatIntentAcceptedComment(result)
    : formatIntentRejectedComment(result);

  await postComment(commentBody);

  // -------------------------------------------------------------------------
  // Step 8: Dispatch (Stage C wiring — LIF-248).
  // Only execute when the intent was accepted.
  // -------------------------------------------------------------------------
  if (!result.ok) {
    // Intent rejected — audit comment already posted above.
    process.exit(0);
  }

  const exec = await executeIntent(result, {
    issueId: TASK_ID!,
    isApproved: () => false, // Stage D will replace with real approval probe.
  });

  await postComment(
    formatExecutionResultComment({
      actionId: result.intent.action_id,
      result: exec,
    }),
  );

  if (exec.code === "wrapper_nonzero") {
    await handleExecutionFailure(
      { issueId: TASK_ID!, actionId: result.intent.action_id, result: exec },
      {
        paperclipApiUrl: API_URL,
        paperclipApiKey: API_KEY,
        runId: RUN_ID,
      },
    );
  }

  // Exit 0: audit comment successfully posted (any path).
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[hermes] Fatal error:", err);
  process.exit(1);
});
