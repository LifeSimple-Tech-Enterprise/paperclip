-- LIF-384 Stage 1 follow-up: partial index on declared_transition for fast Acceptance #1 measurement.
-- Partial WHERE clause omits rows where the column is NULL (backfill rows pre-LIF-384).
CREATE INDEX IF NOT EXISTS agent_wakeup_requests_declared_transition_idx
  ON agent_wakeup_requests (declared_transition)
  WHERE declared_transition IS NOT NULL;
