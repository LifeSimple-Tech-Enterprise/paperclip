-- down: remove declared_transition column from agent_wakeup_requests (LIF-382 Stage 1)
ALTER TABLE agent_wakeup_requests
  DROP COLUMN IF EXISTS declared_transition;
