-- down: drop columns added by 0076_wake_role_pack_observation (LIF-447)
ALTER TABLE agent_wakeup_requests
  DROP COLUMN IF EXISTS instruction_tokens,
  DROP COLUMN IF EXISTS role_pack_rendered;
