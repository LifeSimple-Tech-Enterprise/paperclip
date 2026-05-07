/**
 * Step definitions for @feature-heartbeat-silent-cap
 *
 * API CONTRACTS
 * GET  /api/companies/{companyId}/agents → [{id, urlKey, role}]
 * POST /api/issues/{issueId}/checkout   → issue checkout
 * PATCH /api/issues/{issueId}           → issue update
 * GET  /api/issues/{issueId}/comments   → IssueComment[]
 * POST /api/issues/{issueId}/comments   → IssueComment
 *
 * Locator contract: pure API test — no browser automation, no DOM locators.
 *
 * Per reviewer sign-off 8c6caae4 §2: the keep-alive is observation-only.
 * P remains in 'blocked' status after the 4th heartbeat — no self-promotion.
 */

import { Given, When, Then, Before } from "@cucumber/cucumber";
import { strict as assert } from "node:assert";
import {
  getTestCompanyId,
  listAgents,
  createIssue,
  getIssue,
  listIssueComments,
  simulateSilentHeartbeat,
  simulateKeepAliveHeartbeat,
  type IssueDetail,
  type IssueComment,
} from "../test-utils.js";

interface SilentCapWorld {
  companyId: string;
  leadEngineerAgentId: string;
  parentIssue: IssueDetail;
  childIssue: IssueDetail;
  baselineComments: IssueComment[];
  keepAliveComment: IssueComment | null;
}

let world: SilentCapWorld;

Before({ tags: "@feature-heartbeat-silent-cap" }, async function () {
  world = {
    companyId: getTestCompanyId(),
    leadEngineerAgentId: "",
    parentIssue: null as unknown as IssueDetail,
    childIssue: null as unknown as IssueDetail,
    baselineComments: [],
    keepAliveComment: null,
  };
});

Given(
  "Lead_Engineer is parent of an issue P in 'blocked' state with blockedByIssueIds=[C]",
  async function () {
    const agents = await listAgents(world.companyId);
    const leadEng = agents.find((a) => a.urlKey === "lead-engineer");
    if (!leadEng) {
      throw new Error(
        `No agent with urlKey='lead-engineer' found. Available: ${agents.map((a) => a.urlKey).join(", ")}`,
      );
    }
    world.leadEngineerAgentId = leadEng.id;

    world.childIssue = await createIssue(world.companyId, {
      title: "BDD child blocker C (silent-cap)",
      status: "in_progress",
      assigneeAgentId: world.leadEngineerAgentId,
    });
    world.parentIssue = await createIssue(world.companyId, {
      title: "BDD blocked parent P (silent-cap)",
      status: "blocked",
      assigneeAgentId: world.leadEngineerAgentId,
      blockedByIssueIds: [world.childIssue.id],
    });
    world.baselineComments = await listIssueComments(world.parentIssue.id);
  },
);

Given(
  "C is in 'in_progress' with a normal lastActivityAt",
  async function () {
    const child = await getIssue(world.childIssue.id);
    assert.equal(
      child.status,
      "in_progress",
      `Expected C.status='in_progress', got '${child.status}'`,
    );
    assert.ok(
      child.lastActivityAt != null,
      "Expected C.lastActivityAt to be set, got null/undefined",
    );
    world.childIssue = child;
  },
);

When(
  "3 consecutive silent-eligible heartbeats fire on P",
  async function () {
    for (let i = 0; i < 3; i++) {
      await simulateSilentHeartbeat(
        world.parentIssue.id,
        world.leadEngineerAgentId,
        [world.childIssue.id],
      );
    }
  },
);

Then(
  "P has no new comments authored by Lead_Engineer for those 3 heartbeats",
  async function () {
    const baselineIds = new Set(world.baselineComments.map((c) => c.id));
    const allComments = await listIssueComments(world.parentIssue.id);
    const newLeadComments = allComments.filter(
      (c) => !baselineIds.has(c.id) && c.authorAgentId === world.leadEngineerAgentId,
    );
    assert.equal(
      newLeadComments.length,
      0,
      `Expected 0 new Lead_Engineer comments after 3 silent heartbeats, ` +
        `got ${newLeadComments.length}: ${JSON.stringify(newLeadComments.map((c) => c.body))}`,
    );
  },
);

When(
  "a 4th silent-eligible heartbeat fires",
  async function () {
    const child = await getIssue(world.childIssue.id);
    const childLastActivityAt = child.lastActivityAt ?? new Date().toISOString();
    world.childIssue = child;

    world.keepAliveComment = await simulateKeepAliveHeartbeat(
      world.parentIssue.id,
      world.parentIssue.status,
      [world.childIssue.id],
      {
        id: child.id,
        status: child.status,
        lastActivityAt: childLastActivityAt,
      },
    );
  },
);

Then(
  "P has exactly one new comment authored by Lead_Engineer",
  async function () {
    const baselineIds = new Set(world.baselineComments.map((c) => c.id));
    const allComments = await listIssueComments(world.parentIssue.id);
    const newLeadComments = allComments.filter(
      (c) => !baselineIds.has(c.id) && c.authorAgentId === world.leadEngineerAgentId,
    );
    assert.equal(
      newLeadComments.length,
      1,
      `Expected exactly 1 new Lead_Engineer comment after 4th keep-alive heartbeat, ` +
        `got ${newLeadComments.length}`,
    );

    // §2 no self-promotion: P must remain blocked
    const parent = await getIssue(world.parentIssue.id);
    assert.equal(
      parent.status,
      "blocked",
      `P must remain 'blocked' after keep-alive (§2 no self-promotion); got '${parent.status}'`,
    );
  },
);

Then(
  "the comment body contains C's id, C's status, and C's lastActivityAt",
  async function () {
    assert.ok(world.keepAliveComment, "Keep-alive comment must be set from previous When step");
    const body = world.keepAliveComment.body;
    assert.ok(
      body.includes(world.childIssue.id),
      `Comment body must contain C's id '${world.childIssue.id}'. Body: ${body}`,
    );
    const child = await getIssue(world.childIssue.id);
    assert.ok(
      body.includes(child.status),
      `Comment body must contain C's status '${child.status}'. Body: ${body}`,
    );
    assert.ok(
      body.includes("lastActivityAt="),
      `Comment body must contain 'lastActivityAt='. Body: ${body}`,
    );
  },
);
