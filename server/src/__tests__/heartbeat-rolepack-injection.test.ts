import { describe, expect, it } from "vitest";
import { resolveRolePack, renderRolePack } from "../services/role-packs.js";
import type { agents } from "@paperclipai/db";

type Agent = typeof agents.$inferSelect;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Test Agent",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    runtimeState: null,
    status: "idle",
    urlKey: "test-agent",
    createdAt: new Date(),
    updatedAt: new Date(),
    instructionsPath: null,
    instructionsPathSource: null,
    instructionsUpdatedAt: null,
    ...overrides,
  } as Agent;
}

describe("resolveRolePack", () => {
  it("returns rolePack from adapterConfig when set", () => {
    const agent = makeAgent({ adapterConfig: { rolePack: "lead" } });
    expect(resolveRolePack(agent)).toBe("lead");
  });

  it("returns null when adapterConfig.rolePack is absent", () => {
    const agent = makeAgent({ adapterConfig: {} });
    expect(resolveRolePack(agent)).toBeNull();
  });

  it("returns null when adapterConfig.rolePack is empty string", () => {
    const agent = makeAgent({ adapterConfig: { rolePack: "" } });
    expect(resolveRolePack(agent)).toBeNull();
  });

  it("returns null when adapterConfig.rolePack is non-string", () => {
    const agent = makeAgent({ adapterConfig: { rolePack: 42 } });
    expect(resolveRolePack(agent)).toBeNull();
  });
});

describe("renderRolePack", () => {
  it("renders lead pack with agent context", () => {
    const result = renderRolePack("lead", {
      agentId: "agent-1",
      agentName: "Lead Agent",
      companyId: "company-1",
    });
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns fallback message for unknown packs", () => {
    const result = renderRolePack("unknown-pack", {
      agentId: "agent-1",
      agentName: "Test",
      companyId: "company-1",
    });
    expect(result).toContain("agent-1");
    expect(result).toContain("unknown-pack");
  });
});

describe("heartbeat runtimeConfig rolepack injection (smoke)", () => {
  it("agent with rolePack=lead resolves to non-null instructionsContents", () => {
    const agent = makeAgent({ adapterConfig: { rolePack: "lead" } });
    const rolePackId = resolveRolePack(agent);
    expect(rolePackId).not.toBeNull();
    const contents = renderRolePack(rolePackId!, {
      agentId: agent.id,
      agentName: agent.name,
      companyId: agent.companyId,
    });
    expect(contents.length).toBeGreaterThan(0);
  });

  it("agent without rolePack yields null (field absent from runtimeConfig)", () => {
    const agent = makeAgent({ adapterConfig: {} });
    const rolePackId = resolveRolePack(agent);
    expect(rolePackId).toBeNull();
  });
});
