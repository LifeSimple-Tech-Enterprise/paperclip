import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { renderRolePack, resolveRolePack } from "../services/role-packs.js";

// LIF-447: approxTokenCount helper — mirrors the production const in heartbeat.ts.
const approxTokenCount = (s: string | null | undefined): number | null =>
  s == null ? null : Math.ceil(s.length / 4);

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

// LIF-447: snapshot the wake.event claim-line payload shape for rolePackRendered + instructionTokens.
describe("wake.event claim-line shape — rolePackRendered + instructionTokens (LIF-447)", () => {
  function buildClaimPayload(agent: { id: string; name: string; companyId: string; adapterConfig: unknown }) {
    const rolePackId = resolveRolePack(agent);
    const renderedRolePack = rolePackId !== null
      ? renderRolePack(rolePackId, { agentId: agent.id, agentName: agent.name, companyId: agent.companyId })
      : null;
    const rolePackRendered = rolePackId !== null;
    const instructionTokens = approxTokenCount(renderedRolePack);
    return {
      evt: "wake.event",
      phase: "claim",
      rolePackRendered,
      instructionTokens,
    };
  }

  it("claim payload includes rolePackRendered=true and instructionTokens>0 for agent with rolePack", () => {
    const agent = { id: "a1", name: "Lead Engineer", companyId: "co-1", adapterConfig: { rolePack: "lead" } };
    const payload = buildClaimPayload(agent);
    expect(payload.rolePackRendered).toBe(true);
    expect(typeof payload.instructionTokens).toBe("number");
    expect(payload.instructionTokens).toBeGreaterThan(0);
  });

  it("claim payload includes rolePackRendered=false and instructionTokens=null for agent without rolePack", () => {
    const agent = { id: "a2", name: "Generic", companyId: "co-1", adapterConfig: {} };
    const payload = buildClaimPayload(agent);
    expect(payload.rolePackRendered).toBe(false);
    expect(payload.instructionTokens).toBeNull();
  });

  it("instructionTokens is approximately ceil(content.length/4)", () => {
    const agent = { id: "a3", name: "Drafter", companyId: "co-1", adapterConfig: { rolePack: "drafter" } };
    const rendered = renderRolePack(resolveRolePack(agent)!, { agentId: agent.id, agentName: agent.name, companyId: agent.companyId });
    const expected = Math.ceil(rendered.length / 4);
    const payload = buildClaimPayload(agent);
    expect(payload.instructionTokens).toBe(expected);
  });

  it("claim payload snapshot for lead agent", () => {
    const agent = { id: "snap-lead", name: "Lead", companyId: "co-snap", adapterConfig: { rolePack: "lead" } };
    const payload = buildClaimPayload(agent);
    expect(payload).toMatchObject({
      evt: "wake.event",
      phase: "claim",
      rolePackRendered: true,
    });
    expect(payload.instructionTokens).toBeTypeOf("number");
  });
});
