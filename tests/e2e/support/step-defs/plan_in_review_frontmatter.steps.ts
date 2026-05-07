/**
 * Step definitions for @feature-plan-in-review
 * Feature: Plan documents with `Reviewer:` frontmatter trigger in_review status
 *
 * Simulation approach: steps act AS the agent by directly calling the same API
 * endpoints (upsert plan document, PATCH status, POST comment) that the agent
 * would call. Tests the API contract rather than LLM decision-making.
 */

import { Given, When, Then, Before } from "@cucumber/cucumber";
import { strict as assert } from "node:assert";
import {
  getTestCompanyId,
  createIssue,
  getIssue,
  listIssueComments,
  upsertIssueDocument,
  simulatePlanFrontmatterInReviewAction,
  type IssueDetail,
  type IssueDocument,
  type IssueComment,
} from "../test-utils.js";

// ── World state for this feature ──────────────────────────────────────────────

interface PlanInReviewWorld {
  companyId: string;
  issue: IssueDetail;
  statusBeforeHeartbeat: string;
  planDocument: IssueDocument | null;
  commentsBeforeHeartbeat: IssueComment[];
}

let world: PlanInReviewWorld;

Before({ tags: "@feature-plan-in-review" }, async function () {
  const companyId = getTestCompanyId();
  const issue = await createIssue(companyId, {
    title: "BDD plan-in-review test issue",
    status: "in_progress",
  });
  world = {
    companyId,
    issue,
    statusBeforeHeartbeat: issue.status,
    planDocument: null,
    commentsBeforeHeartbeat: await listIssueComments(issue.id),
  };
});

// ── Step definitions ──────────────────────────────────────────────────────────

Given(
  /^an agent posts a plan document on issue P with body starting with frontmatter `Reviewer: human`$/,
  async function () {
    const body = "Reviewer: human\n\n# Plan\n\nThis plan requires human review.";
    world.planDocument = await upsertIssueDocument(world.issue.id, "plan", body);
    world.statusBeforeHeartbeat = (await getIssue(world.issue.id)).status;
    world.commentsBeforeHeartbeat = await listIssueComments(world.issue.id);
  },
);

Given(
  /^an agent posts a plan document on issue P with body starting with frontmatter `Reviewer: agent`$/,
  async function () {
    const body = "Reviewer: agent\n\n# Plan\n\nThis plan requires agent review only.";
    world.planDocument = await upsertIssueDocument(world.issue.id, "plan", body);
    world.statusBeforeHeartbeat = (await getIssue(world.issue.id)).status;
    world.commentsBeforeHeartbeat = await listIssueComments(world.issue.id);
  },
);

Given(
  /^an agent posts a plan document on issue P with no frontmatter$/,
  async function () {
    const body = "# Plan\n\nThis plan has no frontmatter at all.";
    world.planDocument = await upsertIssueDocument(world.issue.id, "plan", body);
    world.statusBeforeHeartbeat = (await getIssue(world.issue.id)).status;
    world.commentsBeforeHeartbeat = await listIssueComments(world.issue.id);
  },
);

When(
  /^the agent commits the heartbeat$/,
  async function () {
    // The agent inspects the plan document's frontmatter, then acts accordingly.
    // For Reviewer=human: set status=in_review and post a comment naming documentKey+revisionId.
    // For Reviewer=agent or no frontmatter: no status change, no comment.
    const doc = world.planDocument;
    if (!doc) throw new Error("Plan document must be upserted before committing the heartbeat");

    const body = doc.body ?? "";
    const reviewerMatch = body.match(/^Reviewer:\s*(\S+)/);
    const reviewer = reviewerMatch ? reviewerMatch[1].toLowerCase() : null;

    if (reviewer === "human") {
      await simulatePlanFrontmatterInReviewAction(world.issue.id, doc.latestRevisionId);
    }
    // For reviewer=agent or no frontmatter: agent does nothing (no-op heartbeat).
  },
);

Then(
  /^P has status='in_review'$/,
  async function () {
    const issue = await getIssue(world.issue.id);
    assert.equal(
      issue.status,
      "in_review",
      `Expected P status='in_review', got '${issue.status}'`,
    );
  },
);

Then(
  /^there is exactly one comment naming the documentKey 'plan' and the revisionId$/,
  async function () {
    const allComments = await listIssueComments(world.issue.id);
    const before = new Set(world.commentsBeforeHeartbeat.map((c) => c.id));
    const newComments = allComments.filter((c) => !before.has(c.id));

    const planComments = newComments.filter(
      (c) =>
        c.body.includes("documentKey=plan") &&
        c.body.includes(world.planDocument!.latestRevisionId),
    );

    assert.equal(
      planComments.length,
      1,
      `Expected exactly 1 comment naming documentKey='plan' and revisionId='${world.planDocument!.latestRevisionId}'. ` +
        `Got ${planComments.length} among ${newComments.length} new comments: ` +
        JSON.stringify(newComments.map((c) => c.body)),
    );
  },
);

Then(
  /^P's status is unchanged$/,
  async function () {
    const issue = await getIssue(world.issue.id);
    assert.equal(
      issue.status,
      world.statusBeforeHeartbeat,
      `Expected P status='${world.statusBeforeHeartbeat}' (unchanged), got '${issue.status}'`,
    );
  },
);

Then(
  /^no in_review status mutation has been logged$/,
  async function () {
    // Verify no status=in_review was set by checking current status
    // and ensuring no comments hint at an in_review transition.
    const issue = await getIssue(world.issue.id);
    assert.notEqual(
      issue.status,
      "in_review",
      "P must NOT have been set to in_review when Reviewer != human",
    );

    const allComments = await listIssueComments(world.issue.id);
    const before = new Set(world.commentsBeforeHeartbeat.map((c) => c.id));
    const newComments = allComments.filter((c) => !before.has(c.id));
    const inReviewComments = newComments.filter(
      (c) => c.body.toLowerCase().includes("in_review") || c.body.toLowerCase().includes("in review"),
    );
    assert.equal(
      inReviewComments.length,
      0,
      `Expected no in_review status comments, got ${inReviewComments.length}: ` +
        JSON.stringify(inReviewComments.map((c) => c.body)),
    );
  },
);
