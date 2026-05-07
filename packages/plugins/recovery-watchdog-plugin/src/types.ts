/** A row returned by the stale-run candidate query against heartbeat_runs. */
export interface StaleRunRow {
  id: string;
  companyId: string;
  agentId: string;
  /** Extracted from context_snapshot->>'issueId'; null when the run has no associated issue. */
  issueId: string | null;
  status: string;
  contextSnapshot: Record<string, unknown> | null;
  error: string | null;
  errorCode: string | null;
}
