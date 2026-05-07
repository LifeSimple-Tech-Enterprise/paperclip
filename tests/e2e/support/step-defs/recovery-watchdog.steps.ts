/**
 * Step definitions for @feature-recovery-watchdog
 *
 * API CONTRACTS
 * GET  /api/companies/{companyId}/issues?originId={fingerprint}
 *   → [{id, identifier, title, status, originKind, originId, ...}]
 * POST /api/plugins/{pluginId}/jobs/{jobId}/trigger → { runId, jobId }
 * GET  /api/plugins/{pluginId}/jobs/{jobId}/runs    → [{id, status}]
 * POST /api/test/seed-stale-heartbeat-run
 *   body: { companyId, issueId, ageMinutes } → 201 { id, lastOutputAt, ... }
 *
 * Locator contract: pure API test — no browser automation, no DOM locators.
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

interface WatchdogWorld {
  companyId: string;
  parentIssue: IssueDetail;
  childIssue: IssueDetail;
  recoveryIssue: IssueDetail | null;
  fingerprint: string;
}

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
      status: "todo",
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

When(
  "the cron job 'check-stale-blocked-parents' fires",
  async function () {
    await triggerWatchdogCronJobAndWait();
  },
);

Then(
  "a new issue exists with originKind='stranded_issue_recovery' targeting P",
  async function () {
    const matches = await listIssuesByOriginId(world.companyId, world.fingerprint);
    const active = matches.filter(
      (i) => i.status !== "done" && i.status !== "cancelled",
    );
    assert.ok(
      active.length > 0,
      `Expected at least 1 active recovery issue for fingerprint '${world.fingerprint}', got 0`,
    );
    world.recoveryIssue = active[0];

    const full = await getIssue(world.recoveryIssue.id);
    assert.equal(
      full.originKind,
      "plugin:recovery-watchdog:stranded_issue_recovery",
      `Expected originKind='plugin:recovery-watchdog:stranded_issue_recovery', got '${full.originKind}'`,
    );

    const blockedBy = (full.blockedBy ?? []).map((b) => b.id);
    assert.ok(
      blockedBy.includes(world.parentIssue.id),
      `Expected recovery issue to be blocked by parent P (${world.parentIssue.id}), ` +
        `got blockedBy=${JSON.stringify(blockedBy)}`,
    );
  },
);

Then(
  "the new issue has originFingerprint matching 'stranded_blocker_under_blocked_parent:<P.id>:<C.id>'",
  async function () {
    assert.ok(world.recoveryIssue, "Recovery issue must exist before asserting fingerprint");
    const full = await getIssue(world.recoveryIssue.id);
    assert.equal(
      full.originId,
      world.fingerprint,
      `Expected originId='${world.fingerprint}', got '${full.originId}'`,
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
      `Dedup failed: expected exactly 1 active recovery issue after 2nd tick, got ${active.length}`,
    );
  },
);
