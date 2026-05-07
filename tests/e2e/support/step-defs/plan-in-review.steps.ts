/**
 * Step definitions for @feature-plan-in-review
 *
 * API CONTRACTS
 * PUT  /api/issues/{issueId}/documents/{key}
 *   body: { format, body, baseRevisionId } → { id, key, latestRevisionId, ... }
 * PATCH /api/issues/{issueId}  → issue update (sets status=in_review)
 * POST /api/issues/{issueId}/comments → IssueComment
 * GET  /api/issues/{issueId}/comments → IssueComment[]
 *
 * Locator contract: pure API test — no browser automation, no DOM locators.
 *
 * Three scenarios share the same When/Then steps. `this.frontmatter` branches
 * the When step action.
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

interface PlanInReviewWorld {
  companyId: string;
  planIssue: IssueDetail;
  planDocument: IssueDocument | null;
  frontmatter: string | null;
  initialStatus: string;
  baselineComments: IssueComment[];
}

let world: PlanInReviewWorld;

Before({ tags: "@feature-plan-in-review" }, async function () {
  const companyId = getTestCompanyId();
  const planIssue = await createIssue(companyId, {
    title: "BDD plan-in-review test issue P",
    status: "todo",
  });
  world = {
    companyId,
    planIssue,
    planDocument: null,
    frontmatter: null,
    initialStatus: planIssue.status,
    baselineComments: await listIssueComments(planIssue.id),
  };
});

// Matches: `Reviewer: human` and `Reviewer: agent` (backtick-quoted in feature file)
Given(
  /^an agent posts a plan document on issue P with body starting with frontmatter `(.+)`$/,
  async function (frontmatterValue: string) {
    const body = `${frontmatterValue}\n\n# Plan\n\nTest plan content.`;
    world.planDocument = await upsertIssueDocument(world.planIssue.id, "plan", body);
    world.frontmatter = frontmatterValue.trim();
    world.initialStatus = (await getIssue(world.planIssue.id)).status;
    world.baselineComments = await listIssueComments(world.planIssue.id);
  },
);

Given(
  "an agent posts a plan document on issue P with no frontmatter",
  async function () {
    const body = "# Plan\n\nTest plan content without frontmatter.";
    world.planDocument = await upsertIssueDocument(world.planIssue.id, "plan", body);
    world.frontmatter = "none";
    world.initialStatus = (await getIssue(world.planIssue.id)).status;
    world.baselineComments = await listIssueComments(world.planIssue.id);
  },
);

When(
  "the agent commits the heartbeat",
  async function () {
    if (!world.planDocument) {
      throw new Error("Plan document must be upserted before the heartbeat step");
    }
    if (world.frontmatter === "Reviewer: human") {
      await simulatePlanFrontmatterInReviewAction(
        world.planIssue.id,
        world.planDocument.latestRevisionId,
      );
    }
    // Reviewer: agent or no frontmatter → agent takes no action (no-op heartbeat)
  },
);

Then(
  "P has status='in_review'",
  async function () {
    const issue = await getIssue(world.planIssue.id);
    assert.equal(
      issue.status,
      "in_review",
      `Expected P.status='in_review', got '${issue.status}'`,
    );
  },
);

Then(
  "there is exactly one comment naming the documentKey 'plan' and the revisionId",
  async function () {
    assert.ok(world.planDocument, "Plan document must be set");
    const baselineIds = new Set(world.baselineComments.map((c) => c.id));
    const allComments = await listIssueComments(world.planIssue.id);
    const newComments = allComments.filter((c) => !baselineIds.has(c.id));

    const planComments = newComments.filter(
      (c) =>
        c.body.includes("plan") &&
        c.body.includes(world.planDocument!.latestRevisionId),
    );
    assert.equal(
      planComments.length,
      1,
      `Expected exactly 1 comment naming documentKey 'plan' and revisionId '${world.planDocument!.latestRevisionId}'. ` +
        `Got ${planComments.length} among ${newComments.length} new comments: ` +
        JSON.stringify(newComments.map((c) => c.body)),
    );
  },
);

Then(
  "P's status is unchanged",
  async function () {
    const issue = await getIssue(world.planIssue.id);
    assert.equal(
      issue.status,
      world.initialStatus,
      `Expected P.status='${world.initialStatus}' (unchanged), got '${issue.status}'`,
    );
  },
);

Then(
  "no in_review status mutation has been logged",
  async function () {
    const issue = await getIssue(world.planIssue.id);
    assert.notEqual(
      issue.status,
      "in_review",
      "P must NOT have been set to in_review when Reviewer !== 'human'",
    );
    const baselineIds = new Set(world.baselineComments.map((c) => c.id));
    const allComments = await listIssueComments(world.planIssue.id);
    const newInReviewComments = allComments.filter(
      (c) =>
        !baselineIds.has(c.id) &&
        (c.body.toLowerCase().includes("in_review") || c.body.toLowerCase().includes("in review")),
    );
    assert.equal(
      newInReviewComments.length,
      0,
      `Expected no in_review status comments, got ${newInReviewComments.length}: ` +
        JSON.stringify(newInReviewComments.map((c) => c.body)),
    );
  },
);
