import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { renderRolePack, resolveRolePack } from "../services/role-packs.js";

// Smoke tests for the runtimeConfig.instructionsContents injection added in heartbeat.ts.
// The production code is:
//   const rolePackId = resolveRolePack(agent);
//   if (rolePackId !== null) {
//     runtimeConfig = { ...runtimeConfig, instructionsContents: renderRolePack(...) };
//   }

function buildRuntimeConfig(
  base: Record<string, unknown>,
  agent: { id: string; name: string; companyId: string; adapterConfig: unknown },
): Record<string, unknown> & { instructionsContents?: string } {
  let config = { ...base };
  const rolePackId = resolveRolePack(agent);
  if (rolePackId !== null) {
    config = {
      ...config,
      instructionsContents: renderRolePack(rolePackId, {
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
      }),
    };
  }
  return config;
}

describe("heartbeat runtimeConfig.instructionsContents injection", () => {
  const baseConfig = { paperclipRuntimeSkills: [] };

  it("populates instructionsContents for agent with rolePack=lead", () => {
    const agent = {
      id: "agent-abc",
      name: "Lead Engineer",
      companyId: "co-xyz",
      adapterConfig: { rolePack: "lead" },
    };
    const runtimeConfig = buildRuntimeConfig(baseConfig, agent);
    expect(typeof runtimeConfig.instructionsContents).toBe("string");
    expect(runtimeConfig.instructionsContents).toContain("agent-abc");
    expect(runtimeConfig.instructionsContents).toContain("Lead Engineer");
    expect(runtimeConfig.instructionsContents).toContain("co-xyz");
  });

  it("populates instructionsContents for agent with rolePack=drafter", () => {
    const agent = {
      id: "agent-drafter",
      name: "Eng_Drafter",
      companyId: "co-xyz",
      adapterConfig: { rolePack: "drafter" },
    };
    const runtimeConfig = buildRuntimeConfig(baseConfig, agent);
    expect(typeof runtimeConfig.instructionsContents).toBe("string");
    expect(runtimeConfig.instructionsContents).toContain("Drafter");
  });

  it("leaves instructionsContents absent for agent without rolePack", () => {
    const agent = {
      id: "agent-no-pack",
      name: "Generic Agent",
      companyId: "co-xyz",
      adapterConfig: {},
    };
    const runtimeConfig = buildRuntimeConfig(baseConfig, agent);
    expect(runtimeConfig.instructionsContents).toBeUndefined();
  });

  it("leaves instructionsContents absent for agent with invalid rolePack", () => {
    const agent = {
      id: "agent-bad-pack",
      name: "Bad Agent",
      companyId: "co-xyz",
      adapterConfig: { rolePack: "ceo" },
    };
    const runtimeConfig = buildRuntimeConfig(baseConfig, agent);
    expect(runtimeConfig.instructionsContents).toBeUndefined();
  });

  it("preserves all base config fields when injecting instructionsContents", () => {
    const agent = {
      id: "agent-lead",
      name: "Lead",
      companyId: "co-1",
      adapterConfig: { rolePack: "lead" },
    };
    const base = { paperclipRuntimeSkills: [{ key: "skill-a" }], existingField: "preserved" };
    const runtimeConfig = buildRuntimeConfig(base, agent);
    expect(runtimeConfig.existingField).toBe("preserved");
    expect(Array.isArray(runtimeConfig.paperclipRuntimeSkills)).toBe(true);
    expect(typeof runtimeConfig.instructionsContents).toBe("string");
  });
});
