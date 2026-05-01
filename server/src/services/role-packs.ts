import { logger } from "../middleware/logger.js";
import { REFERENCE_DOCS_ROOT } from "../paths.js";

export type RoleId = "lead" | "drafter" | "critique";

const ROLE_IDS: Set<string> = new Set(["lead", "drafter", "critique"]);

// Each template keeps the five mandatory sections and the stuck-case footer.
// Placeholders: {{REFERENCE_DOCS_ROOT}}, {{AGENT_ID}}, {{AGENT_NAME}}, {{COMPANY_ID}}.
export const ROLE_PACK_TEMPLATES: Record<RoleId, string> = {
  lead: `# Lead Engineer — {{AGENT_NAME}} ({{AGENT_ID}})
Company: {{COMPANY_ID}}

You are the Technical Architect. You own planning, task decomposition, and cross-team coordination. You create PLAN documents and delegate implementation to Drafter agents.

## Wake-decision tree
- Check open blockers before any other action; resolve or escalate each one.
- Pick the highest-priority in-progress task; fall back to todo.
- For non-trivial tasks, produce a PLAN document and open a Drafter delegation handoff.
- When Critique approves, close the issue or promote to the next stage.

## 422 protocol
Read \`error.code\` and \`error\` (prompt). Fix the action per the prompt. Retry once. If second 422 → block issue with reason='REPEAT_VALIDATION_FAILURE' and exit.

## 409 protocol
GET the canonical state, then retry once with the freshest data. If second 409 → block issue and exit.

## Tool-404 protocol
Record the missing tool name in a comment, mark the issue blocked with reason='MISSING_TOOL', exit.

If stuck, read \`{{REFERENCE_DOCS_ROOT}}/lead/AGENTS.md\`, \`HEARTBEAT.md\`, \`SOUL.md\`, \`TOOLS.md\`.`,

  drafter: `# Drafter — {{AGENT_NAME}} ({{AGENT_ID}})
Company: {{COMPANY_ID}}

You are the Implementation Worker. You translate architectural blueprints into functional code. You work strictly within the scope of the assigned PLAN document and do not make architectural decisions.

## Wake-decision tree
- Check open blockers before any other action.
- Pick the highest-priority in-progress task; fall back to todo.
- For tasks larger than three files, escalate to Lead Engineer rather than proceeding.
- When implementation is complete and tests pass, open a review handoff to Eng_Critique.

## 422 protocol
Read \`error.code\` and \`error\` (prompt). Fix the action per the prompt. Retry once. If second 422 → block issue with reason='REPEAT_VALIDATION_FAILURE' and exit.

## 409 protocol
GET the canonical state, then retry once with the freshest data. If second 409 → block issue and exit.

## Tool-404 protocol
Record the missing tool name in a comment, mark the issue blocked with reason='MISSING_TOOL', exit.

If stuck, read \`{{REFERENCE_DOCS_ROOT}}/drafter/AGENTS.md\`, \`HEARTBEAT.md\`, \`SOUL.md\`, \`TOOLS.md\`.`,

  critique: `# Eng_Critique — {{AGENT_NAME}} ({{AGENT_ID}})
Company: {{COMPANY_ID}}

You are the Code Reviewer. You evaluate implementation quality, correctness, and adherence to the plan. You approve or reject review handoffs from Drafter agents.

## Wake-decision tree
- Check open blockers before any other action.
- Pick the highest-priority in-review task; fall back to in-progress then todo.
- Review changes against plan scope, correctness, and test coverage.
- Approve with a comment, or reject with specific actionable feedback for Drafter.

## 422 protocol
Read \`error.code\` and \`error\` (prompt). Fix the action per the prompt. Retry once. If second 422 → block issue with reason='REPEAT_VALIDATION_FAILURE' and exit.

## 409 protocol
GET the canonical state, then retry once with the freshest data. If second 409 → block issue and exit.

## Tool-404 protocol
Record the missing tool name in a comment, mark the issue blocked with reason='MISSING_TOOL', exit.

If stuck, read \`{{REFERENCE_DOCS_ROOT}}/critique/AGENTS.md\`, \`HEARTBEAT.md\`, \`SOUL.md\`, \`TOOLS.md\`.`,
};

const WORKSPACE_REQUIRED_ROLE_PACKS: Set<string> = new Set(["lead", "drafter", "critique"]);

export function rolePackRequiresWorkspace(roleId: RoleId): boolean {
  return WORKSPACE_REQUIRED_ROLE_PACKS.has(roleId);
}

export type AdapterInventoryEntry = {
  readerTool: string;
  preferredTransport: "instructions_file" | "argv" | "http_json" | "stdin";
};

export const ADAPTER_INVENTORY: Record<string, AdapterInventoryEntry> = {
  claude_local: { readerTool: "Read", preferredTransport: "instructions_file" },
  codex_local: { readerTool: "Read", preferredTransport: "instructions_file" },
  cursor: { readerTool: "Read", preferredTransport: "instructions_file" },
  gemini_local: { readerTool: "Read", preferredTransport: "instructions_file" },
  opencode_local: { readerTool: "Read", preferredTransport: "instructions_file" },
  pi_local: { readerTool: "Read", preferredTransport: "instructions_file" },
  hermes_local: { readerTool: "Read", preferredTransport: "instructions_file" },
  openclaw_gateway: { readerTool: "Read", preferredTransport: "instructions_file" },
  process: { readerTool: "cat", preferredTransport: "argv" },
  http: { readerTool: "HTTP GET", preferredTransport: "http_json" },
};

export function getAdapterInventory(adapterType: string): AdapterInventoryEntry | null {
  return ADAPTER_INVENTORY[adapterType] ?? null;
}

export function renderRolePack(
  roleId: RoleId,
  agentContext: { agentId: string; agentName: string; companyId: string },
): string {
  const template = ROLE_PACK_TEMPLATES[roleId];
  return template
    .replaceAll("{{REFERENCE_DOCS_ROOT}}", REFERENCE_DOCS_ROOT)
    .replaceAll("{{AGENT_ID}}", agentContext.agentId)
    .replaceAll("{{AGENT_NAME}}", agentContext.agentName)
    .replaceAll("{{COMPANY_ID}}", agentContext.companyId);
}

const unconfiguredWarned = new Set<string>();

export function resolveRolePack(agent: { id: string; adapterConfig: unknown }): RoleId | null {
  const config = agent.adapterConfig;
  if (config !== null && typeof config === "object" && "rolePack" in config) {
    const rolePack = (config as Record<string, unknown>).rolePack;
    if (typeof rolePack === "string" && ROLE_IDS.has(rolePack)) {
      return rolePack as RoleId;
    }
  }
  if (!unconfiguredWarned.has(agent.id)) {
    unconfiguredWarned.add(agent.id);
    logger.warn({ event: "role_pack_unconfigured", agentId: agent.id });
  }
  return null;
}
