-- up: create handoffs table and issue_comments.metadata column (LIF-374 Stage 2)
-- Introduces the Handoff entity that supersedes the legacy [Drafter] title-prefix protocol.

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  issue_id uuid NOT NULL REFERENCES issues(id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  from_agent_id uuid REFERENCES agents(id),
  to_agent_id uuid REFERENCES agents(id),
  scope_globs jsonb,
  contract text,
  branch text,
  base_branch text,
  verified_sha text,
  decision text,
  decision_reason text,
  parent_handoff_id uuid REFERENCES handoffs(id),
  source_comment_id uuid REFERENCES issue_comments(id) ON DELETE SET NULL,
  source_run_id uuid REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  idempotency_key text,
  payload jsonb,
  decided_at timestamp with time zone,
  merged_at timestamp with time zone,
  merged_sha text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX handoffs_company_issue_idx ON handoffs (company_id, issue_id);

CREATE INDEX handoffs_to_agent_idx ON handoffs (to_agent_id);

CREATE INDEX handoffs_parent_idx ON handoffs (parent_handoff_id);

CREATE INDEX handoffs_unmerged_reviews_idx
  ON handoffs (issue_id, kind, status)
  WHERE merged_at IS NULL;

CREATE UNIQUE INDEX handoffs_company_issue_idempotency_uq
  ON handoffs (company_id, issue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Add metadata column to issue_comments for courtesy comment classification
ALTER TABLE issue_comments
  ADD COLUMN metadata jsonb;
