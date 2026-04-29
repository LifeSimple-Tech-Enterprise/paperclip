-- down: archive handoffs table (LIF-374 Stage 2 rollback)
-- Per LIF-371 §2 rollback strategy: archive-not-drop to preserve audit trail.

DROP INDEX IF EXISTS handoffs_company_issue_idempotency_uq;

DROP INDEX IF EXISTS handoffs_unmerged_reviews_idx;

DROP INDEX IF EXISTS handoffs_parent_idx;

DROP INDEX IF EXISTS handoffs_to_agent_idx;

DROP INDEX IF EXISTS handoffs_company_issue_idx;

ALTER TABLE handoffs RENAME TO handoffs_archived_lif374;

-- Remove metadata column from issue_comments
ALTER TABLE issue_comments
  DROP COLUMN IF EXISTS metadata;
