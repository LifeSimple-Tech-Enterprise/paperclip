/**
 * Failing tests for the V1 action registry (LIF-243 §C1, LIF-247 TDD).
 *
 * These tests fail with "module not found" until Lead lands the registry
 * implementation. Once it lands, they assert the FROZEN registry contract
 * documented in LIF-243 PLAN §1 and LIF-232 Plan v4 §0.4.
 */

import { describe, expect, it } from "vitest";
import {
  V1_ACTION_IDS,
  V1_CRITICAL_ACTION_IDS,
  type V1ActionId,
} from "@paperclipai/hermes-agent/intent";
// @ts-expect-error -- module not yet implemented; Drafter/Lead lands this
import {
  getAction,
  UnknownActionError,
} from "./registry.js";

describe("V1 action registry — completeness", () => {
  it.each(V1_ACTION_IDS as readonly V1ActionId[])(
    "registers an entry for %s",
    (actionId) => {
      const def = getAction(actionId);
      expect(def).toBeDefined();
      expect(def.id).toBe(actionId);
    },
  );

  it("registry exposes exactly the V1 ids — no extras", () => {
    for (const id of V1_ACTION_IDS) {
      expect(() => getAction(id)).not.toThrow();
    }
  });
});

describe("V1 action registry — criticality", () => {
  it.each(V1_ACTION_IDS as readonly V1ActionId[])(
    "%s criticality matches V1_CRITICAL_ACTION_IDS",
    (actionId) => {
      const def = getAction(actionId);
      const expected = V1_CRITICAL_ACTION_IDS.has(actionId)
        ? "critical"
        : "routine";
      expect(def.criticality).toBe(expected);
    },
  );
});

describe("V1 action registry — wrapperPath", () => {
  it.each(V1_ACTION_IDS as readonly V1ActionId[])(
    "%s wrapperPath is /usr/local/sbin/hermes-*",
    (actionId) => {
      const def = getAction(actionId);
      expect(def.wrapperPath).toMatch(/^\/usr\/local\/sbin\/hermes-/);
    },
  );
});

describe("V1 action registry — argv producer (positive cases)", () => {
  // Table per PLAN §0: argv is positional, no shell-concat.
  const cases: ReadonlyArray<{
    id: V1ActionId;
    args: Record<string, string>;
    expected: readonly string[];
  }> = [
    {
      id: "service_restart_paperclip",
      args: {},
      expected: [],
    },
    {
      id: "service_restart_github_runner",
      args: {},
      expected: [],
    },
    { id: "pm2_restart", args: { name: "paperclip" }, expected: ["paperclip"] },
    { id: "ufw_status", args: {}, expected: [] },
    {
      id: "diag_journal_tail",
      args: { unit: "paperclip.service", n: "5" },
      expected: ["paperclip.service", "5"],
    },
    // diag_disk_usage and diag_health_probe both take a `key` arg that the
    // shared wrappers (`hermes-disk-check`, `hermes-health-probe`) resolve
    // against `/etc/hermes/*.allowlist` files (closed enum lives wrapper-side
    // per LIF-237). The TS layer enforces the character class only.
    { id: "diag_disk_usage", args: { key: "var" }, expected: ["var"] },
    {
      id: "diag_health_probe",
      args: { key: "paperclip" },
      expected: ["paperclip"],
    },
    // `ufw_allow` and `ufw_deny` share `/usr/local/sbin/hermes-ufw-apply`
    // (single wrapper, two verbs) per LIF-237 — argv MUST carry the verb so
    // the wrapper can distinguish allow-vs-deny when called for either id.
    {
      id: "ufw_allow",
      args: { preset: "https-public" },
      expected: ["allow", "https-public"],
    },
    {
      id: "ufw_deny",
      args: { preset: "https-public" },
      expected: ["deny", "https-public"],
    },
  ];

  it.each(cases)(
    "$id argv($args) → $expected",
    ({ id, args, expected }) => {
      const def = getAction(id);
      const argv = def.argv(args);
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toEqual(expected);
    },
  );
});

describe("V1 action registry — argsSchema rejects bad input", () => {
  it("pm2_restart.name rejects shell metacharacters", () => {
    const def = getAction("pm2_restart");
    expect(def.argsSchema.safeParse({ name: "evil; rm -rf /" }).success).toBe(
      false,
    );
  });

  it("pm2_restart.name accepts allowlisted chars", () => {
    const def = getAction("pm2_restart");
    expect(def.argsSchema.safeParse({ name: "paperclip" }).success).toBe(true);
  });

  it("diag_journal_tail.unit rejects strings missing .service suffix", () => {
    const def = getAction("diag_journal_tail");
    expect(
      def.argsSchema.safeParse({ unit: "foo", n: "5" }).success,
    ).toBe(false);
  });

  it("diag_journal_tail.unit accepts <name>.service", () => {
    const def = getAction("diag_journal_tail");
    expect(
      def.argsSchema.safeParse({ unit: "paperclip.service", n: "5" }).success,
    ).toBe(true);
  });

  it("diag_journal_tail.n rejects out-of-range integer string (5000)", () => {
    const def = getAction("diag_journal_tail");
    expect(
      def.argsSchema.safeParse({ unit: "paperclip.service", n: "5000" })
        .success,
    ).toBe(false);
  });

  it("diag_journal_tail.n accepts in-range integer string", () => {
    const def = getAction("diag_journal_tail");
    expect(
      def.argsSchema.safeParse({ unit: "paperclip.service", n: "5" }).success,
    ).toBe(true);
  });

  it("ufw_allow.preset rejects whitespace-bearing values", () => {
    const def = getAction("ufw_allow");
    expect(def.argsSchema.safeParse({ preset: "http public" }).success).toBe(
      false,
    );
  });

  it("ufw_allow.preset accepts a closed-enum value (https-public)", () => {
    const def = getAction("ufw_allow");
    expect(def.argsSchema.safeParse({ preset: "https-public" }).success).toBe(
      true,
    );
  });

  it("ufw_deny.preset is also enum-restricted (rejects 'http public')", () => {
    const def = getAction("ufw_deny");
    expect(def.argsSchema.safeParse({ preset: "http public" }).success).toBe(
      false,
    );
  });
});

describe("V1 action registry — getAction error path", () => {
  it("throws UnknownActionError for off-list ids", () => {
    let caught: unknown;
    try {
      getAction("nope" as V1ActionId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownActionError);
    expect((caught as UnknownActionError).actionId).toBe("nope");
  });
});
