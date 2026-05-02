-- LIF-448: add final_issue_status column sampled at wake finalization
ALTER TABLE agent_wakeup_requests ADD COLUMN IF NOT EXISTS final_issue_status text;
