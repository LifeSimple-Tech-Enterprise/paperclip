import type { agents } from "@paperclipai/db";

type Agent = typeof agents.$inferSelect;

interface RolePackContext {
  agentId: string;
  agentName: string;
  companyId: string;
}

const ROLE_PACK_TEMPLATES: Record<string, (ctx: RolePackContext) => string> = {
  lead: (ctx) =>
    `You are the Lead Engineer (${ctx.agentName}) for company ${ctx.companyId}. ` +
    `Agent ID: ${ctx.agentId}. ` +
    `You architect solutions, delegate implementation to Drafter agents, and review work via Critique agents.`,
};

export function resolveRolePack(agent: Agent): string | null {
  const adapterConfig = agent.adapterConfig ?? {};
  const rolePack = adapterConfig.rolePack;
  if (typeof rolePack === "string" && rolePack.trim().length > 0) {
    return rolePack.trim();
  }
  return null;
}

export function renderRolePack(rolePackId: string, ctx: RolePackContext): string {
  const template = ROLE_PACK_TEMPLATES[rolePackId];
  if (!template) {
    return `You are agent ${ctx.agentId} (${ctx.agentName}). Role pack "${rolePackId}" is not defined.`;
  }
  return template(ctx);
}
