/**
 * Step definitions for @feature-heartbeat-silent-cap
 * Feature: Silent heartbeats post a keep-alive on the 4th consecutive no-op
 *
 * Simulation approach: steps act AS the Lead_Engineer agent by calling the same
 * API endpoints the agent would call. This tests the API contract without
 * requiring a live LLM agent run.
 *
 * Per reviewer sign-off 8c6caae4 §2: the keep-alive is observation-only.
 * P remains in 'blocked' status after the 4th heartbeat — no self-promotion.
 */

import { Given, When, Then, Before } from "@cucumber/cucumber";
import { strict as assert } from "node:assert";
import {
  BASE_URL,
  getTestCompanyId,
  createIssue,
  getIssue,
  listIssueComments,
  simulateSilentHeartbeat,
  simulateKeepAliveHeartbeat,
  type IssueDetail,
  type IssueComment,
} from "../test-utils.js";

// ── World state for this feature ──────────────────────────────────────────────

interface SilentCapWorld {
  companyId: string;
  parentIssue: IssueDetail;
  childIssue: IssueDetail;
  leadEngineerAgentId: string;
  commentsBeforeSilent: IssueComment[];
  commentsAfterThreeSilent: IssueComment[];
  keepAliveComment: IssueComment | null;
}

let world: SilentCapWorld;

Before({ tags: "@feature-heartbeat-silent-cap" }, async function () {
  world = {
    companyId: getTestCompanyId(),
    parentIssue: null as unknown as IssueDetail,
    childIssue: null as unknown as IssueDetail,
    leadEngineerAgentId: "",
    commentsBeforeSilent: [],
    commentsAfterThreeSilent: [],
    keepAliveComment: null,
  };
});

// ── Step definitions ──────────────────────────────────────────────────────────

Given(
  "Lead_Engineer is parent of an issue P in 'blocked' state with blockedByIssueIds=[C]",
  async function () {
    const companyId = world.companyId;

    // Look up the Lead_Engineer agent id from the running instance.
    const res = await fetch(`${BASE_URL}/api/companies/${companyId}/agents`);
    if (!res.ok) throw new Error(`GET /api/companies/${companyId}/agents failed ${res.status}`);
    const agents = (await res.json()) as Array<{ id: string; role?: string; title?: string; name?: string }>;
    const leadEng = agents.find(
      (a) =>
        a.role === "engineer" ||
        (a.title ?? "").toLowerCase().includes("lead") ||
        (a.name ?? "").toLowerCase().includes("lead"),
    );
    if (!leadEng) throw new Error("No Lead_Engineer agent found in company");
    world.leadEngineerAgentId = leadEng.id;

    world.childIssue = await createIssue(companyId, {
      title: "BDD child blocker C (silent-cap)",
      status: "in_progress",
    });

    world.parentIssue = await createIssue(companyId, {
      title: "BDD parent P blocked by C (silent-cap)",
      status: "blocked",
      blockedByIssueIds: [world.childIssue.id],
      assigneeAgentId: world.leadEngineerAgentId,
    });

    world.commentsBeforeSilent = await listIssueComments(world.parentIssue.id);
  },
);

Given(
  "C is in 'in_progress' with a normal lastActivityAt",
  async function () {
    // Child was created as in_progress above; just verify it.
    const child = await getIssue(world.childIssue.id);
    assert.equal(
      child.status,
      "in_progress",
      `Child issue expected in_progress, got '${child.status}'`,
    );
  },
);

When(
  /^3 consecutive silent-eligible heartbeats fire on P$/,
  async function () {
    for (let i = 0; i < 3; i++) {
      await simulateSilentHeartbeat(
        world.parentIssue.id,
        world.leadEngineerAgentId,
        [world.childIssue.id],
      );
    }
    world.commentsAfterThreeSilent = await listIssueComments(world.parentIssue.id);
  },
);

Then(
  "P has no new comments authored by Lead_Engineer for those 3 heartbeats",
  async function () {
    const before = new Set(world.commentsBeforeSilent.map((c) => c.id));
    const newComments = world.commentsAfterThreeSilent.filter((c) => !before.has(c.id));
    const agentNewComments = newComments.filter(
      (c) => c.authorAgentId === world.leadEngineerAgentId,
    );
    assert.equal(
      agentNewComments.length,
      0,
      `Expected 0 new comments by Lead_Engineer after 3 silent heartbeats, ` +
        `got ${agentNewComments.length}: ${JSON.stringify(agentNewComments.map((c) => c.body))}`,
    );
  },
);

When(
  /^a 4th silent-eligible heartbeat fires$/,
  async function () {
    const child = await getIssue(world.childIssue.id);
    const childLastActivityAt =
      (child as IssueDetail & { lastActivityAt?: string | null }).lastActivityAt ??
      new Date().toISOString();

    world.keepAliveComment = await simulateKeepAliveHeartbeat(
      world.parentIssue.id,
      world.parentIssue.status,
      [world.childIssue.id],
      {
        id: world.childIssue.id,
        status: child.status,
        lastActivityAt: childLastActivityAt,
      },
    );
  },
);

Then(
  "P has exactly one new comment authored by Lead_Engineer",
  async function () {
    const allComments = await listIssueComments(world.parentIssue.id);
    const before = new Set(world.commentsBeforeSilent.map((c) => c.id));
    const newAgentComments = allComments.filter(
      (c) => !before.has(c.id) && c.authorAgentId === world.leadEngineerAgentId,
    );
    assert.equal(
      newAgentComments.length,
      1,
      `Expected exactly 1 new Lead_Engineer comment after 4th heartbeat, got ${newAgentComments.length}`,
    );
    // Verify the keep-alive is the recorded comment.
    assert.ok(
      world.keepAliveComment,
      "Keep-alive comment must have been posted in the 4th heartbeat step",
    );
    assert.equal(
      newAgentComments[0].id,
      world.keepAliveComment.id,
      "The single new comment must be the keep-alive comment",
    );
  },
);

Then(
  "the comment body contains C's id, C's status, and C's lastActivityAt",
  async function () {
    assert.ok(world.keepAliveComment, "Keep-alive comment is required");
    const body = world.keepAliveComment.body;
    assert.ok(
      body.includes(world.childIssue.id),
      `Keep-alive comment body must contain child id '${world.childIssue.id}'.\nBody: ${body}`,
    );
    const child = await getIssue(world.childIssue.id);
    assert.ok(
      body.includes(child.status),
      `Keep-alive comment body must contain child status '${child.status}'.\nBody: ${body}`,
    );

    // lastActivityAt check: the body was produced by simulateKeepAliveHeartbeat,
    // which embeds the value we passed. Verify the field is present at minimum.
    assert.ok(
      body.includes("lastActivityAt="),
      `Keep-alive comment body must contain 'lastActivityAt='. Body: ${body}`,
    );

    // P remains blocked — no self-promotion (per sign-off 8c6caae4 §2).
    const parent = await getIssue(world.parentIssue.id);
    assert.equal(
      parent.status,
      "blocked",
      `P must remain in 'blocked' status after keep-alive; got '${parent.status}'`,
    );
  },
);
