import { describe, expect, it, vi, beforeEach } from "vitest";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";
import { resolveReferenceDocsRoot } from "../paths.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import { logger } from "../middleware/logger.js";
import {
  ADAPTER_INVENTORY,
  ROLE_PACK_TEMPLATES,
  getAdapterInventory,
  renderRolePack,
  resolveRolePack,
  type RoleId,
} from "../services/role-packs.js";

const ROLE_IDS: RoleId[] = ["lead", "drafter", "critique"];

// 13 forbidden terms — harness-handled statuses must not appear in pack text.
const FORBIDDEN_TERMS = [
  "400",
  "401",
  "403",
  "5xx",
  "500",
  "502",
  "503",
  "504",
  "timeout",
  "410",
  "internal",
  "WAKE_TERMINATED",
  "REPEAT_FAILURE_BLOCKED",
];

describe("role-pack templates", () => {
  for (const roleId of ROLE_IDS) {
    describe(`${roleId} pack`, () => {
      const pack = ROLE_PACK_TEMPLATES[roleId];

      it("fits within the 1000-token budget", () => {
        const estimatedTokens = Buffer.byteLength(pack, "utf8") / 4;
        expect(estimatedTokens).toBeLessThanOrEqual(1000);
      });

      it("contains the role-identity section", () => {
        expect(pack).toMatch(/you are/i);
      });

      it("contains the wake-decision tree section", () => {
        expect(pack).toMatch(/wake-decision tree/i);
      });

      it("contains the 422 protocol section", () => {
        expect(pack).toMatch(/422 protocol/i);
      });

      it("contains the 409 protocol section", () => {
        expect(pack).toMatch(/409 protocol/i);
      });

      it("contains the tool-404 protocol section", () => {
        expect(pack).toMatch(/tool-404 protocol/i);
      });

      it("contains the stuck-case footer with correct role path placeholder", () => {
        expect(pack).toContain(`{{REFERENCE_DOCS_ROOT}}/${roleId}/AGENTS.md`);
      });

      it.each(FORBIDDEN_TERMS)("does not contain forbidden term '%s'", (term) => {
        const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        expect(pack).not.toMatch(regex);
      });
    });
  }
});

describe("renderRolePack", () => {
  const ctx = { agentId: "agent-123", agentName: "TestAgent", companyId: "company-456" };

  it("substitutes all four placeholders", () => {
    for (const roleId of ROLE_IDS) {
      const rendered = renderRolePack(roleId, ctx);
      expect(rendered).toContain(ctx.agentId);
      expect(rendered).toContain(ctx.agentName);
      expect(rendered).toContain(ctx.companyId);
      expect(rendered).not.toContain("{{REFERENCE_DOCS_ROOT}}");
      expect(rendered).not.toContain("{{AGENT_ID}}");
      expect(rendered).not.toContain("{{AGENT_NAME}}");
      expect(rendered).not.toContain("{{COMPANY_ID}}");
    }
  });

  it("stuck-case path uses resolveReferenceDocsRoot() (leaf paths.ts), not a hard-coded string", () => {
    const rendered = renderRolePack("lead", ctx);
    const expectedRoot = resolveReferenceDocsRoot();
    expect(rendered).toContain(`${expectedRoot}/lead/AGENTS.md`);
  });

  it("resolveReferenceDocsRoot ends with server/docs/reference", () => {
    const root = resolveReferenceDocsRoot();
    expect(root.replace(/\\/g, "/")).toMatch(/server\/docs\/reference$/);
  });
});

describe("ADAPTER_INVENTORY", () => {
  it("covers every key in BUILTIN_ADAPTER_TYPES exactly — no orphans, no extras", () => {
    const inventoryKeys = new Set(Object.keys(ADAPTER_INVENTORY));
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      expect(inventoryKeys.has(adapterType), `ADAPTER_INVENTORY missing '${adapterType}'`).toBe(true);
    }
    for (const key of inventoryKeys) {
      expect(BUILTIN_ADAPTER_TYPES.has(key), `ADAPTER_INVENTORY has extra key '${key}'`).toBe(true);
    }
  });

  it("all entries have a non-empty readerTool and a valid preferredTransport", () => {
    const validTransports = new Set(["instructions_file", "argv", "http_json", "stdin"]);
    for (const [key, entry] of Object.entries(ADAPTER_INVENTORY)) {
      expect(entry.readerTool, `${key}.readerTool`).toBeTruthy();
      expect(validTransports.has(entry.preferredTransport), `${key}.preferredTransport`).toBe(true);
    }
  });
});

describe("getAdapterInventory", () => {
  it("returns entry for known adapter types", () => {
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      const entry = getAdapterInventory(adapterType);
      expect(entry).not.toBeNull();
    }
  });

  it("returns null for unknown adapter type", () => {
    expect(getAdapterInventory("nonexistent_adapter")).toBeNull();
  });
});

describe("resolveRolePack", () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it("returns the roleId for a valid adapterConfig.rolePack", () => {
    for (const roleId of ROLE_IDS) {
      const result = resolveRolePack({ id: `agent-${roleId}`, adapterConfig: { rolePack: roleId } });
      expect(result).toBe(roleId);
    }
  });

  it("returns null and emits warn for missing adapterConfig.rolePack", () => {
    const result = resolveRolePack({ id: "agent-no-pack", adapterConfig: {} });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith({
      event: "role_pack_unconfigured",
      agentId: "agent-no-pack",
    });
  });

  it("returns null and emits warn for invalid rolePack value", () => {
    const result = resolveRolePack({ id: "agent-bad-pack", adapterConfig: { rolePack: "ceo" } });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith({
      event: "role_pack_unconfigured",
      agentId: "agent-bad-pack",
    });
  });

  it("emits warn only once per agent id (warn-once dedup)", () => {
    const agentId = "agent-warn-once-" + Math.random().toString(36).slice(2);
    resolveRolePack({ id: agentId, adapterConfig: {} });
    resolveRolePack({ id: agentId, adapterConfig: {} });
    resolveRolePack({ id: agentId, adapterConfig: {} });
    const calls = vi.mocked(logger.warn).mock.calls.filter(
      (c) => c[0]?.agentId === agentId,
    );
    expect(calls).toHaveLength(1);
  });

  it("returns null for null adapterConfig", () => {
    const result = resolveRolePack({ id: "agent-null-config", adapterConfig: null });
    expect(result).toBeNull();
  });
});
