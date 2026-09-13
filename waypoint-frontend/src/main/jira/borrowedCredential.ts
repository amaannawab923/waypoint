import {
  encodeJiraCredentialHeader,
  readStoredJiraCredential,
} from './jiraAuth';

/**
 * The stored Jira credential as the backend borrows it, and the site it
 * belongs to — read per call, never held (W5b, ROAD-126).
 *
 * Two readers the ledger client and the run modules are handed at wiring
 * time (engine/engineIpc.ts, copilot/copilotRunner.ts), so neither module
 * imports Electron: `jiraCredentialHeader` is what rides the
 * borrowed-credential header on a run's proposal for a Jira issue and on
 * a key resolution — the same encoder proposalApproval.ts and the MCP
 * config use, so the backend's one parser has one shape to accept —
 * and `jiraSite` is the connected site's hostname, the key the repository
 * mapping and a ref's site check are made against. Null when nothing is
 * connected.
 */
export function jiraCredentialHeader(): string | null {
  return encodeJiraCredentialHeader(readStoredJiraCredential());
}

export function jiraSite(): string | null {
  return readStoredJiraCredential()?.site ?? null;
}
