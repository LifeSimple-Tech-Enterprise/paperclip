import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROOT, REFERENCE_DOCS_ROOT } from "../paths.js";
import { ROLE_PACK_TEMPLATES } from "../services/role-packs.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("paths.ts (leaf module)", () => {
  it("APP_ROOT resolves to the server package root", () => {
    expect(fs.existsSync(path.join(APP_ROOT, "package.json"))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("@paperclipai/server");
  });

  it("REFERENCE_DOCS_ROOT lives at <APP_ROOT>/docs/reference", () => {
    expect(REFERENCE_DOCS_ROOT).toBe(path.join(APP_ROOT, "docs/reference"));
    expect(fs.existsSync(REFERENCE_DOCS_ROOT)).toBe(true);
  });

  it("paths.ts source has no app-internal imports (leaf invariant)", () => {
    const src = fs.readFileSync(path.join(APP_ROOT, "src/paths.ts"), "utf8");
    const importLines = src.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      // Allow only node: builtin modules.
      expect(line, `paths.ts must be leaf — found non-builtin import: ${line.trim()}`).toMatch(
        /from ["']node:[a-z/]+["']/,
      );
    }
  });
});

describe("reference-docs bundle resolves from REFERENCE_DOCS_ROOT", () => {
  const requiredFiles: Array<[string, string[]]> = [
    ["ceo", ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]],
    ["default", ["AGENTS.md"]],
  ];

  for (const [role, fileNames] of requiredFiles) {
    for (const fileName of fileNames) {
      it(`${role}/${fileName} exists under REFERENCE_DOCS_ROOT`, () => {
        const filePath = path.join(REFERENCE_DOCS_ROOT, role, fileName);
        expect(fs.existsSync(filePath), `missing ${filePath}`).toBe(true);
        expect(fs.statSync(filePath).size).toBeGreaterThan(0);
      });
    }
  }

  it("loadDefaultAgentInstructionsBundle('ceo') returns all four files", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");
    expect(Object.keys(bundle).sort()).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);
    for (const content of Object.values(bundle)) {
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("loadDefaultAgentInstructionsBundle('default') returns AGENTS.md", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
    expect(bundle["AGENTS.md"]).toContain("agent at Paperclip");
  });

  it("resolveDefaultAgentInstructionsBundleRole maps non-ceo roles to default", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("lead")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("marketing")).toBe("default");
  });
});

describe("role-pack templates do not reference internal-only docs", () => {
  // Negative assertion: role packs are agent-facing. They must not point at the
  // operator-only `docs/internal/*` runbooks (e.g. local-board-scope.md). If a
  // future template introduces such a leak, this test fails the build.
  for (const [roleId, template] of Object.entries(ROLE_PACK_TEMPLATES)) {
    it(`${roleId} pack does not link to docs/internal/`, () => {
      expect(template).not.toMatch(/docs\/internal\b/i);
    });
  }
});

describe("compiled-output asserts (only when dist exists)", () => {
  // When the server has been built (`pnpm build`), the build pipeline copies
  // `docs/reference/` into `dist/docs/reference/` and the boot-smoke check
  // verifies it. This test mirrors that contract for the CI matrix, but skips
  // when the workspace has not run a build (developer-test convenience).
  const distRoot = path.join(APP_ROOT, "dist");

  const distExists = fs.existsSync(distRoot);
  const maybeIt = distExists ? it : it.skip;

  maybeIt("dist/docs/reference/ceo/AGENTS.md exists in compiled output", () => {
    expect(fs.existsSync(path.join(distRoot, "docs/reference/ceo/AGENTS.md"))).toBe(true);
  });

  maybeIt("dist/docs/reference/default/AGENTS.md exists in compiled output", () => {
    expect(fs.existsSync(path.join(distRoot, "docs/reference/default/AGENTS.md"))).toBe(true);
  });
});
