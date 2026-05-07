// Placeholder — QA_Unit fills in the test bodies.
// Each describe.skip block names the case to implement.
import { describe, it } from "vitest";

describe.skip("reconcileStaleBlockedParents — candidate query", () => {
  it("returns only status=blocked parents whose blocker chain includes a stale running child", () => {
    // QA_Unit: build a fake ctx.db.query that returns a stale run, a fake
    // ctx.issues.list that returns one blocked parent and one non-blocked parent,
    // and a fake ctx.issues.relations.get that links the stale run's issueId as
    // a blocker of the blocked parent.  Assert that only the blocked parent triggers
    // ctx.issues.create, and the non-blocked parent does not.
  });
});

describe.skip("reconcileStaleBlockedParents — threshold check", () => {
  it("child with lastOutputAt exactly at 59:59 is NOT picked; at 60:01 IS picked", () => {
    // QA_Unit: supply two heartbeat_run rows: one whose coalesce(last_output_at, ...)
    // is now - 59min59s and one at now - 60min01s.  Assert that only the 60:01 row
    // appears in the candidate set fed to the blocked-parent loop.
  });
});

describe.skip("reconcileStaleBlockedParents — dedup fingerprint", () => {
  it("second sweep pass over the same (parent, blocker) pair does not create a second recovery issue", () => {
    // QA_Unit: on the first sweep, ctx.issues.list({ originId: fingerprint }) returns [].
    // On the second sweep it returns a non-terminal issue with the same fingerprint.
    // Assert that ctx.issues.create is called exactly once across both sweeps.
  });
});
