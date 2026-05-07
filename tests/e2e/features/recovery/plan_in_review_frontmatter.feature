@feature-plan-in-review
Feature: Plan documents with `Reviewer:` frontmatter trigger in_review status
  Scenario: Frontmatter Reviewer=human sets parent to in_review on plan upsert
    Given an agent posts a plan document on issue P with body starting with frontmatter `Reviewer: human`
    When the agent commits the heartbeat
    Then P has status='in_review'
    And there is exactly one comment naming the documentKey 'plan' and the revisionId
  Scenario: Frontmatter Reviewer=agent leaves status unchanged
    Given an agent posts a plan document on issue P with body starting with frontmatter `Reviewer: agent`
    When the agent commits the heartbeat
    Then P's status is unchanged
    And no in_review status mutation has been logged
  Scenario: No frontmatter leaves status unchanged
    Given an agent posts a plan document on issue P with no frontmatter
    When the agent commits the heartbeat
    Then P's status is unchanged
