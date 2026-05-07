@feature-recovery-watchdog
Feature: Recovery watchdog surfaces stale blockers under blocked parents
  Scenario: A blocked parent whose child has been silent for >1h gets a Recover stalled issue task
    Given the recovery-watchdog-plugin is installed and its cron job is running
    And a parent issue P is in status 'blocked' blocked by child C
    And C has a heartbeatRun with status='running' and lastOutputAt=2 hours ago
    When the cron job 'check-stale-blocked-parents' fires
    Then a new issue exists with originKind='stranded_issue_recovery' targeting P
    And the new issue has originFingerprint matching 'stranded_blocker_under_blocked_parent:<P.id>:<C.id>'
    And a second cron-job tick does NOT create a duplicate recovery issue
