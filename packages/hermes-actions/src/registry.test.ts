/**
 * Contract tests for the FROZEN V1 action registry — LIF-243 §C1.
 *
 * Locks the public surface of `registry.ts` so the Drafter's executor and
 * QA's failure/journal integration tests have a stable target. Adding/removing
 * an entry, renaming a wrapper path, or flipping a criticality should fail
 * here with a precise diff before propagating to downstream tests.
 */

import { describe, expect, it } from "vitest";

import {
  V1_ACTION_IDS,
  V1_CRITICAL_ACTION_IDS,
  type V1ActionId,
} from "./intent.js";

import {
  ACTION_REGISTRY,
  UnknownActionError,
  getAction,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe("ACTION_REGISTRY — inventory (FROZEN per Plan v4 §0.4)", () => {
  it("registers exactly the 9 V1 action ids", () => {
    expect(Object.keys(ACTION_REGISTRY).sort()).toEqual(
      [...V1_ACTION_IDS].sort(),
    );
  });

  it.each(V1_ACTION_IDS)(
    "%s — entry id matches its registry key",
    (id) => {
      expect(ACTION_REGISTRY[id].id).toBe(id);
    },
  );

  it.each(V1_ACTION_IDS)(
    "%s — wrapperPath is under /usr/local/sbin/hermes-",
    (id) => {
      expect(ACTION_REGISTRY[id].wrapperPath).toMatch(
        /^\/usr\/local\/sbin\/hermes-[a-z][a-z0-9-]+$/,
      );
    },
  );

  it.each(V1_ACTION_IDS)(
    "%s — criticality matches V1_CRITICAL_ACTION_IDS",
    (id) => {
      const expectCritical = V1_CRITICAL_ACTION_IDS.has(id);
      const actualCritical =
        ACTION_REGISTRY[id].criticality === "critical";
      expect(actualCritical).toBe(expectCritical);
    },
  );
});

// ---------------------------------------------------------------------------
// argv builders — match wrapper-side argv shapes from LIF-237
// ---------------------------------------------------------------------------

describe("ACTION_REGISTRY — argv shapes (must match LIF-237 wrappers)", () => {
  type Case = {
    id: V1ActionId;
    args: Record<string, unknown>;
    wrapperPath: string;
    expectedArgv: string[];
  };

  const cases: Case[] = [
    {
      id: "service_restart_paperclip",
      args: {},
      wrapperPath: "/usr/local/sbin/hermes-restart-paperclip",
      expectedArgv: [],
    },
    {
      id: "service_restart_github_runner",
      args: {},
      wrapperPath: "/usr/local/sbin/hermes-restart-gha-runner",
      expectedArgv: [],
    },
    {
      id: "pm2_restart",
      args: { name: "paperclip" },
      wrapperPath: "/usr/local/sbin/hermes-pm2-restart",
      expectedArgv: ["paperclip"],
    },
    {
      id: "ufw_status",
      args: {},
      wrapperPath: "/usr/local/sbin/hermes-ufw-status",
      expectedArgv: [],
    },
    {
      id: "diag_journal_tail",
      args: { unit: "paperclip.service", n: "5" },
      wrapperPath: "/usr/local/sbin/hermes-log-tail",
      expectedArgv: ["paperclip.service", "5"],
    },
    {
      id: "diag_disk_usage",
      args: { key: "paperclip-instances" },
      wrapperPath: "/usr/local/sbin/hermes-disk-check",
      expectedArgv: ["paperclip-instances"],
    },
    {
      id: "diag_health_probe",
      args: { key: "paperclip-local" },
      wrapperPath: "/usr/local/sbin/hermes-health-probe",
      expectedArgv: ["paperclip-local"],
    },
    {
      id: "ufw_allow",
      args: { preset: "https-public" },
      wrapperPath: "/usr/local/sbin/hermes-ufw-apply",
      expectedArgv: ["allow", "https-public"],
    },
    {
      id: "ufw_deny",
      args: { preset: "https-public" },
      wrapperPath: "/usr/local/sbin/hermes-ufw-apply",
      expectedArgv: ["deny", "https-public"],
    },
  ];

  it.each(cases)(
    "$id → spawn args [$wrapperPath, ...$expectedArgv]",
    ({ id, args, wrapperPath, expectedArgv }) => {
      const def = ACTION_REGISTRY[id];
      expect(def.wrapperPath).toBe(wrapperPath);
      const parsed = def.argsSchema.safeParse(args);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      // The argv builder receives the schema's PARSED output (e.g. n -> number),
      // not the raw record. Asserting on parsed.data exercises that contract.
      expect(def.argv((parsed as { data: unknown }).data)).toEqual(
        expectedArgv,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// argsSchema — defense-in-depth character class enforcement
// ---------------------------------------------------------------------------

describe("ACTION_REGISTRY — argsSchema rejects unsafe inputs", () => {
  const accepted: Array<[V1ActionId, Record<string, unknown>]> = [
    ["pm2_restart", { name: "paperclip" }],
    ["pm2_restart", { name: "github-runner.worker_1" }],
    ["diag_journal_tail", { unit: "paperclip.service", n: "1" }],
    ["diag_journal_tail", { unit: "paperclip.service", n: "1000" }],
    ["diag_disk_usage", { key: "paperclip-instances" }],
    ["diag_health_probe", { key: "paperclip-local" }],
    ["ufw_allow", { preset: "https-public" }],
    ["ufw_deny", { preset: "ssh_admin" }],
    ["ufw_status", {}],
    ["service_restart_paperclip", {}],
    ["service_restart_github_runner", {}],
  ];

  it.each(accepted)("%s accepts %j", (id, args) => {
    const r = ACTION_REGISTRY[id].argsSchema.safeParse(args);
    expect(r.success, JSON.stringify(r)).toBe(true);
  });

  const rejected: Array<[V1ActionId, Record<string, unknown>, string]> = [
    // Shell metacharacters — wrapper would also reject, TS is the first line.
    ["pm2_restart", { name: "evil; rm -rf /" }, "shell metachars"],
    ["pm2_restart", { name: "foo bar" }, "whitespace"],
    ["pm2_restart", { name: "foo|bar" }, "pipe metachar"],
    ["pm2_restart", { name: "" }, "empty string"],
    ["pm2_restart", {}, "missing required field"],
    // Path traversal in keys / units / presets.
    ["diag_disk_usage", { key: "../etc" }, "path traversal"],
    ["diag_health_probe", { key: "../etc/passwd" }, "path traversal"],
    // unit must end in a systemd suffix.
    ["diag_journal_tail", { unit: "paperclip", n: "5" }, "no .service suffix"],
    ["diag_journal_tail", { unit: "evil; rm -rf /", n: "5" }, "shell metachars in unit"],
    // n out of range / non-integer.
    ["diag_journal_tail", { unit: "paperclip.service", n: "5000" }, "n above 1000"],
    ["diag_journal_tail", { unit: "paperclip.service", n: "0" }, "n below 1"],
    ["diag_journal_tail", { unit: "paperclip.service", n: "abc" }, "n non-integer"],
    ["diag_journal_tail", { unit: "paperclip.service", n: "-5" }, "n negative"],
    // ufw preset character class.
    ["ufw_allow", { preset: "http public" }, "preset whitespace"],
    ["ufw_allow", { preset: "" }, "empty preset"],
    ["ufw_deny", { preset: "evil; sh" }, "preset metachars"],
    // Strict schemas reject extra keys.
    ["ufw_status", { extra: "field" }, "no-args extra field"],
    ["pm2_restart", { name: "ok", extra: "field" }, "extra field on pm2_restart"],
  ];

  it.each(rejected)("%s rejects %j (%s)", (id, args, _why) => {
    const r = ACTION_REGISTRY[id].argsSchema.safeParse(args);
    expect(r.success, `expected reject but got ${JSON.stringify(r)}`).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAction lookup
// ---------------------------------------------------------------------------

describe("getAction()", () => {
  it.each(V1_ACTION_IDS)(
    "returns the entry for known id %s",
    (id) => {
      expect(getAction(id).id).toBe(id);
    },
  );

  it("throws UnknownActionError for off-list ids", () => {
    expect(() => getAction("nope_not_real")).toThrow(UnknownActionError);
  });

  it("UnknownActionError exposes the offending action id", () => {
    try {
      getAction("rm_rf_slash");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownActionError);
      expect((e as UnknownActionError).actionId).toBe("rm_rf_slash");
      expect((e as UnknownActionError).name).toBe("UnknownActionError");
    }
  });
});
