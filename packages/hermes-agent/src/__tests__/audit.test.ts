/**
 * Unit tests for audit comment formatters — LIF-242 Section 2.
 *
 * Snapshot-style assertions on the FROZEN markdown shape produced by
 * formatIntentAcceptedComment and formatIntentRejectedComment. The shape is
 * a contract with the issue-thread renderer; do not relax these assertions.
 */

import { describe, expect, it } from "vitest";
import {
  formatIntentAcceptedComment,
  formatIntentRejectedComment,
  type AuditRejection,
} from "../audit.js";
import type { IntentSuccess } from "../intent.js";

const acceptedRoutine: IntentSuccess = {
  ok: true,
  intent: {
    action_id: "ufw_status",
    args: {},
    confidence: 0.92,
    requires_approval: false,
    rationale: "User requested current firewall state.",
  },
  requiresApproval: false,
};

const acceptedCritical: IntentSuccess = {
  ok: true,
  intent: {
    action_id: "ufw_allow",
    args: { port: "8080", proto: "tcp" },
    confidence: 0.85,
    requires_approval: true,
    rationale: "Open inbound 8080/tcp for staging service.",
  },
  requiresApproval: true,
};

describe("formatIntentAcceptedComment", () => {
  it("emits the frozen header with the markdown em dash", () => {
    const out = formatIntentAcceptedComment(acceptedRoutine);
    expect(out.startsWith("### Hermes intent — accepted\n")).toBe(true);
  });

  it("contains a fenced ```json block with the intent payload", () => {
    const out = formatIntentAcceptedComment(acceptedRoutine);
    expect(out).toContain("```json\n");
    expect(out).toContain("\n```");
    // Payload fields all appear in the rendered JSON
    expect(out).toContain('"action_id": "ufw_status"');
    expect(out).toContain('"confidence": 0.92');
    expect(out).toContain('"requires_approval": false');
    expect(out).toContain('"rationale": "User requested current firewall state."');
  });

  it("classifies routine actions correctly", () => {
    const out = formatIntentAcceptedComment(acceptedRoutine);
    expect(out).toContain(
      "Classification: routine (per V1_CRITICAL_ACTION_IDS).",
    );
  });

  it("classifies critical actions correctly", () => {
    const out = formatIntentCriticalCheck();
    expect(out).toContain(
      "Classification: critical (per V1_CRITICAL_ACTION_IDS).",
    );
  });

  it("renders args object faithfully when populated", () => {
    const out = formatIntentAcceptedComment(acceptedCritical);
    expect(out).toContain('"port": "8080"');
    expect(out).toContain('"proto": "tcp"');
  });

  it("matches the frozen full-shape snapshot for a routine intent", () => {
    const out = formatIntentAcceptedComment(acceptedRoutine);
    const expected =
      `### Hermes intent — accepted\n` +
      `\n` +
      `\`\`\`json\n` +
      `{\n` +
      `  "action_id": "ufw_status",\n` +
      `  "args": {},\n` +
      `  "confidence": 0.92,\n` +
      `  "requires_approval": false,\n` +
      `  "rationale": "User requested current firewall state."\n` +
      `}\n` +
      `\`\`\`\n` +
      `\n` +
      `Classification: routine (per V1_CRITICAL_ACTION_IDS).`;
    expect(out).toBe(expected);
  });

  it("has no trailing whitespace and no double-trailing newline", () => {
    const out = formatIntentAcceptedComment(acceptedRoutine);
    expect(out.endsWith("\n")).toBe(false);
    for (const line of out.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe("formatIntentRejectedComment", () => {
  const cases: Array<{
    label: string;
    rejection: AuditRejection;
    expectedCode: string;
  }> = [
    {
      label: "invalid_json",
      rejection: {
        ok: false,
        code: "invalid_json",
        message: "Model output is not valid JSON: Unexpected token 'x'.",
        raw: "xnot json",
      },
      expectedCode: "invalid_json",
    },
    {
      label: "schema_violation",
      rejection: {
        ok: false,
        code: "schema_violation",
        message: "Model output does not match IntentSchema.",
        raw: '{"action_id":"ufw_status"}',
      },
      expectedCode: "schema_violation",
    },
    {
      label: "action_not_allowed",
      rejection: {
        ok: false,
        code: "action_not_allowed",
        message: 'action_id "rm_rf_root" is not in the V1 allowlist.',
        raw: '{"action_id":"rm_rf_root","args":{},"confidence":0.5,"requires_approval":false,"rationale":"x"}',
      },
      expectedCode: "action_not_allowed",
    },
    {
      label: "ollama_unreachable",
      rejection: {
        ok: false,
        code: "ollama_unreachable",
        message: "Ollama request timed out after 30 s.",
      },
      expectedCode: "ollama_unreachable",
    },
  ];

  it.each(cases)(
    "renders all four rejection codes with the frozen shape: $label",
    ({ rejection, expectedCode }) => {
      const out = formatIntentRejectedComment(rejection);
      expect(out.startsWith("### Hermes intent — rejected\n")).toBe(true);
      expect(out).toContain(`Code: \`${expectedCode}\``);
      expect(out).toContain(`Reason: ${rejection.message}`);
      expect(out).toContain("```json\n");
    },
  );

  it("renders raw model output inside fenced ```json block when present", () => {
    const out = formatIntentRejectedComment({
      ok: false,
      code: "invalid_json",
      message: "bad",
      raw: '{"oops": true}',
    });
    expect(out).toContain('```json\n{"oops": true}\n```');
  });

  it("renders null inside the json block when raw is undefined (ollama_unreachable)", () => {
    const out = formatIntentRejectedComment({
      ok: false,
      code: "ollama_unreachable",
      message: "Ollama TCP refused.",
    });
    expect(out).toContain("```json\nnull\n```");
  });

  it("matches the frozen full-shape snapshot for action_not_allowed", () => {
    const out = formatIntentRejectedComment({
      ok: false,
      code: "action_not_allowed",
      message: 'action_id "evil" is not in the V1 allowlist.',
      raw: '{"action_id":"evil"}',
    });
    const expected =
      `### Hermes intent — rejected\n` +
      `\n` +
      `Code: \`action_not_allowed\`\n` +
      `\n` +
      `\`\`\`json\n{"action_id":"evil"}\n\`\`\`\n` +
      `\n` +
      `Reason: action_id "evil" is not in the V1 allowlist.`;
    expect(out).toBe(expected);
  });

  it("has no trailing whitespace on any line", () => {
    for (const c of cases) {
      const out = formatIntentRejectedComment(c.rejection);
      for (const line of out.split("\n")) {
        expect(line).toBe(line.trimEnd());
      }
    }
  });
});

// Helper kept inline so the it-block above stays declarative.
function formatIntentCriticalCheck(): string {
  return formatIntentAcceptedComment(acceptedCritical);
}

// ---------------------------------------------------------------------------
// LIF-247: formatExecutionResultComment cases. These will fail with "module
// not found" until Drafter extends audit.ts. Each case asserts a single
// ExecutionCode, locking the audit-thread shape across all six outcomes.
// ---------------------------------------------------------------------------

// @ts-expect-error -- formatter not yet implemented in audit.ts
import { formatExecutionResultComment } from "../audit.js";

type AnyExecutionResult = {
  ok: boolean;
  code:
    | "ok"
    | "invalid_args"
    | "awaiting_approval"
    | "unknown_action"
    | "wrapper_nonzero"
    | "spawn_error";
  exitCode: number | null;
  stdoutTruncated: string;
  stderrTruncated: string;
  journalSeq: number | null;
  message?: string;
  zodIssues?: unknown[];
};

describe("formatExecutionResultComment", () => {
  function call(actionId: string, result: AnyExecutionResult): string {
    return formatExecutionResultComment({ actionId, result });
  }

  it("ok: header is `### Hermes execution — ok`", () => {
    const out = call("pm2_restart", {
      ok: true,
      code: "ok",
      exitCode: 0,
      stdoutTruncated: "OK\n",
      stderrTruncated: "",
      journalSeq: 1,
    });
    expect(out.startsWith("### Hermes execution — ok\n")).toBe(true);
    expect(out).toContain("`pm2_restart`");
    expect(out).toContain("`0`");
    expect(out).toContain("`1`");
    // stdout block present, stderr block omitted because empty
    expect(out).toContain("OK");
  });

  it("wrapper_nonzero: header is `### Hermes execution — failed`", () => {
    const out = call("pm2_restart", {
      ok: false,
      code: "wrapper_nonzero",
      exitCode: 7,
      stdoutTruncated: "",
      stderrTruncated: "boom\n",
      journalSeq: 2,
    });
    expect(out.startsWith("### Hermes execution — failed\n")).toBe(true);
    expect(out).toContain("`7`");
    expect(out).toContain("boom");
  });

  it("awaiting_approval: header reflects the code; no journal_seq value", () => {
    const out = call("ufw_allow", {
      ok: false,
      code: "awaiting_approval",
      exitCode: null,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: null,
    });
    expect(out.startsWith("### Hermes execution — awaiting_approval\n")).toBe(
      true,
    );
    expect(out).toContain("`null`");
  });

  it("invalid_args: header reflects the code; renders zod issue bullets", () => {
    const out = call("pm2_restart", {
      ok: false,
      code: "invalid_args",
      exitCode: null,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: null,
      zodIssues: [
        { path: ["name"], message: "regex mismatch", code: "invalid_string" },
      ],
    });
    expect(out.startsWith("### Hermes execution — invalid_args\n")).toBe(true);
    expect(out).toContain("name");
    expect(out).toContain("regex mismatch");
  });

  it("unknown_action: header reflects the code", () => {
    const out = call("nope", {
      ok: false,
      code: "unknown_action",
      exitCode: null,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: null,
    });
    expect(out.startsWith("### Hermes execution — unknown_action\n")).toBe(
      true,
    );
    expect(out).toContain("`nope`");
  });

  it("spawn_error: header reflects the code; surfaces message", () => {
    const out = call("pm2_restart", {
      ok: false,
      code: "spawn_error",
      exitCode: null,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: null,
      message: "ENOENT: sudo not found",
    });
    expect(out.startsWith("### Hermes execution — spawn_error\n")).toBe(true);
    expect(out).toContain("ENOENT: sudo not found");
  });

  it("omits empty fenced stdout/stderr blocks", () => {
    const out = call("ufw_status", {
      ok: true,
      code: "ok",
      exitCode: 0,
      stdoutTruncated: "",
      stderrTruncated: "",
      journalSeq: 1,
    });
    // No fenced block at all when both streams are empty
    expect(out).not.toContain("```\n");
  });

  it("has no trailing whitespace on any line", () => {
    const out = call("pm2_restart", {
      ok: false,
      code: "wrapper_nonzero",
      exitCode: 7,
      stdoutTruncated: "OK\n",
      stderrTruncated: "boom\n",
      journalSeq: 2,
    });
    for (const line of out.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
