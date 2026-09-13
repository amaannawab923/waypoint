/**
 * The one fact about a ticket id that every layer dispatches on, with no
 * dependencies so any layer can: a "tref-" id names a ticket_refs row (a
 * Jira issue's ledger handle — db/schema/integrations.ts), and every native
 * ticket id is minted "wi-" (lib/ids.ts). The prefix alone says which
 * system owns the ticket. providers/jira.ts re-exports both so its callers
 * are unchanged; this file exists so the validation schemas can ask the
 * question without importing a provider (and, through it, the database).
 */
export const JIRA_REF_PREFIX = 'tref-';

/** Whether a bare id names a ticket_refs row rather than a native ticket. */
export function isExternalRef(id: string): boolean {
  return id.startsWith(JIRA_REF_PREFIX);
}
