-- WARNING: UNLOGGED — agent_action_attempts is intentionally an UNLOGGED table.
-- All rows are lost on PostgreSQL crash. This is acceptable because the table
-- only stores recovery hints (repeat-attempt counts) for the LIF-375 Stage 3a
-- infra-error hook; it is not a system of record. Crash recovery resets the
-- tracker, which means agents in 422-loops at crash time get one fresh chance
-- before the hook re-engages. See paperclip/docs/internal/local-board-scope.md.
--
-- up: create UNLOGGED agent_action_attempts table (LIF-375 Stage 3a / LIF-427)

CREATE UNLOGGED TABLE agent_action_attempts (
  company_id uuid NOT NULL REFERENCES companies(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  issue_id uuid NOT NULL REFERENCES issues(id),
  method text NOT NULL,
  path text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  last_status integer NOT NULL,
  last_code text,
  last_message text,
  last_payload_capture text,
  extra jsonb,
  first_at timestamp with time zone NOT NULL DEFAULT now(),
  last_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, agent_id, issue_id, method, path)
);

CREATE INDEX agent_action_attempts_last_at_idx
  ON agent_action_attempts (last_at);

CREATE INDEX agent_action_attempts_issue_idx
  ON agent_action_attempts (issue_id);
