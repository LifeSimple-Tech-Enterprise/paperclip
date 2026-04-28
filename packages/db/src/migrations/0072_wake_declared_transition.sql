-- up: add declared_transition column to agent_wakeup_requests (LIF-382 Stage 1)
-- Records the FSM transition key emitted by evaluateCheckout/evaluateWake at checkout time.
ALTER TABLE agent_wakeup_requests
  ADD COLUMN declared_transition text;
