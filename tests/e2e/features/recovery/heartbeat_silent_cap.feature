@feature-heartbeat-silent-cap
Feature: Silent heartbeats post a keep-alive on the 4th consecutive no-op
  Scenario: Three silent heartbeats produce no comments, the fourth posts a keep-alive
    Given Lead_Engineer is parent of an issue P in 'blocked' state with blockedByIssueIds=[C]
    And C is in 'in_progress' with a normal lastActivityAt
    When 3 consecutive silent-eligible heartbeats fire on P
    Then P has no new comments authored by Lead_Engineer for those 3 heartbeats
    When a 4th silent-eligible heartbeat fires
    Then P has exactly one new comment authored by Lead_Engineer
    And the comment body contains C's id, C's status, and C's lastActivityAt
    # Note (per reviewer sign-off 8c6caae4 §2): the keep-alive is observation-only.
    # P remains in 'blocked' status; no self-promotion to in_progress.
