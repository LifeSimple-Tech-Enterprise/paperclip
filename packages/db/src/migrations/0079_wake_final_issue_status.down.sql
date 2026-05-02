-- LIF-448: revert final_issue_status column
ALTER TABLE agent_wakeup_requests DROP COLUMN IF EXISTS final_issue_status;
