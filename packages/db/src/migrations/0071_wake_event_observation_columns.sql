-- up: additive nullable observation columns on agent_wakeup_requests (LIF-377)
ALTER TABLE agent_wakeup_requests
  ADD COLUMN prior_issue_status text,
  ADD COLUMN post_checkout_issue_status text,
  ADD COLUMN ctx_field_used text,
  ADD COLUMN fired_transitions jsonb,
  ADD COLUMN suppressed_reason text;

CREATE INDEX agent_wakeup_requests_reason_status_idx
  ON agent_wakeup_requests (reason, post_checkout_issue_status);
