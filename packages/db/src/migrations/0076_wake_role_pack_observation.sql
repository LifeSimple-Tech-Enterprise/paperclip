-- up: add role_pack_rendered + instruction_tokens to agent_wakeup_requests (LIF-447)
ALTER TABLE agent_wakeup_requests
  ADD COLUMN role_pack_rendered boolean,
  ADD COLUMN instruction_tokens integer;
