-- down: remove observation columns from agent_wakeup_requests (LIF-377)
DROP INDEX IF EXISTS agent_wakeup_requests_reason_status_idx;

ALTER TABLE agent_wakeup_requests
  DROP COLUMN IF EXISTS prior_issue_status,
  DROP COLUMN IF EXISTS post_checkout_issue_status,
  DROP COLUMN IF EXISTS ctx_field_used,
  DROP COLUMN IF EXISTS fired_transitions,
  DROP COLUMN IF EXISTS suppressed_reason;
