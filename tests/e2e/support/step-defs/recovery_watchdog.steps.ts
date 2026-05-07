/**
 * Step definitions for @feature-recovery-watchdog
 * Feature: Recovery watchdog surfaces stale blockers under blocked parents
 */

import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import { strict as assert } from "node:assert";
import {
  getTestCompanyId,
  createIssue,
  getIssue,
  listIssuesByOriginId,
  installWatchdogPlugin,
  enableWatchdogPlugin,
  disableWatchdogPlugin,
  seedStaleHeartbeatRun,
  triggerWatchdogCronJobAndWait,
  type IssueDetail,
} from "../test-utils.js";

// ── World state for this feature ──────────────────────────────────────────────

interface WatchdogWorld {
  companyId: string;
  parentIssue: IssueDetail;
  childIssue: IssueDetail;
  recoveryIssue: IssueDetail | null;
  fingerprint: string;
}

// Cucumber does not support typed World in .ts without custom world class;
// store state in a plain object scoped to the scenario via Before/After.
let world: WatchdogWorld;

Before({ tags: "@feature-recovery-watchdog" }, async function () {
  world = {
    companyId: getTestCompanyId(),
    parentIssue: null as unknown as IssueDetail,
    childIssue: null as unknown as IssueDetail,
    recoveryIssue: null,
    fingerprint: "",
  };
});

After({ tags: "@feature-recovery-watchdog" }, async function () {
  await disableWatchdogPlugin().catch(() => undefined);
});

// ── Step definitions ──────────────────────────────────────────────────────────

Given(
  "the recovery-watchdog-plugin is installed and its cron job is running",
  async function () {
    await installWatchdogPlugin();
    await enableWatchdogPlugin();
  },
);

Given(
  "a parent issue P is in status 'blocked' blocked by child C",
  async function () {
    world.childIssue = await createIssue(world.companyId, {
      title: "BDD child blocker C",
      status: "in_progress",
    });

    world.parentIssue = await createIssue(world.companyId, {
      title: "BDD blocked parent P",
      status: "blocked",
      blockedByIssueIds: [world.childIssue.id],
    });

    world.fingerprint = `stranded_blocker_under_blocked_parent:${world.parentIssue.id}:${world.childIssue.id}`;
  },
);

Given(
  "C has a heartbeatRun with status='running' and lastOutputAt=2 hours ago",
  async function () {
    await seedStaleHeartbeatRun(world.companyId, world.childIssue.id, 120);
  },
);

When("the cron job 'check-stale-blocked-parents' fires", async function () {
  await triggerWatchdogCronJobAndWait();
});

Then(
  "a new issue exists with originKind='stranded_issue_recovery' targeting P",
  async function () {
    const matches = await listIssuesByOriginId(world.companyId, world.fingerprint);
    const active = matches.filter(
      (i) => i.status !== "done" && i.status !== "cancelled",
    );
    assert.equal(
      active.length,
      1,
      `Expected exactly 1 active recovery issue for fingerprint '${world.fingerprint}', got ${active.length}`,
    );

    world.recoveryIssue = active[0];

    const full = (await getIssue(world.recoveryIssue.id)) as IssueDetail & {
      originKind?: string;
      blockedByIssueIds?: string[];
    };

    assert.equal(
      full.originKind,
      "stranded_issue_recovery",
      `Expected originKind='stranded_issue_recovery', got '${full.originKind}'`,
    );

    const blockedBy = full.blockedByIssueIds ?? [];
    assert.ok(
      blockedBy.includes(world.parentIssue.id),
      `Expected recovery issue to target (be blocked by) parent P (${world.parentIssue.id}), ` +
        `got blockedByIssueIds=${JSON.stringify(blockedBy)}`,
    );
  },
);

Then(
  "the new issue has originFingerprint matching 'stranded_blocker_under_blocked_parent:<P.id>:<C.id>'",
  async function () {
    assert.ok(
      world.recoveryIssue,
      "Recovery issue must exist before asserting originFingerprint",
    );

    const full = (await getIssue(world.recoveryIssue.id)) as IssueDetail & {
      originId?: string;
    };

    const expectedFingerprint = world.fingerprint;
    assert.equal(
      full.originId,
      expectedFingerprint,
      `Expected originId (fingerprint) to be '${expectedFingerprint}', got '${full.originId}'`,
    );
  },
);

Then(
  "a second cron-job tick does NOT create a duplicate recovery issue",
  async function () {
    await triggerWatchdogCronJobAndWait();

    const matches = await listIssuesByOriginId(world.companyId, world.fingerprint);
    const active = matches.filter(
      (i) => i.status !== "done" && i.status !== "cancelled",
    );
    assert.equal(
      active.length,
      1,
      `Dedup failed: expected 1 active recovery issue after 2nd tick, got ${active.length}`,
    );
  },
);
