/**
 * Reference-only: the agent dispatch intents harvested from the deleted
 * Sessions prototype (`pages/sessions/**`, removed in W1.4 — see
 * docs/design/waypoint-revamp-architecture.md §9). These were the five
 * presets the "New Session" dispatch flow offered for what to ask a
 * personal agent to do against a ticket.
 *
 * This is inert reference data only — it is not wired into any UI. The
 * Sessions screen itself, its mock data, and its execution logic were all
 * deleted; only the intent labels are preserved here for later work (see
 * CAPABILITIES['agents.runtime']).
 */
export interface AgentIntent {
  id: 'rca' | 'comment' | 'follow-up' | 'full-coding' | 'custom';
  label: string;
  /** Whether dispatching this intent ever needs a local checkout/working directory. */
  needsDirectory: boolean;
}

export const AGENT_INTENTS: AgentIntent[] = [
  { id: 'rca', label: 'Research & give RCA', needsDirectory: true },
  { id: 'comment', label: 'Comment on the ticket', needsDirectory: false },
  { id: 'follow-up', label: 'Follow up on the ticket', needsDirectory: false },
  { id: 'full-coding', label: 'Start working on this bug', needsDirectory: true },
  { id: 'custom', label: 'Custom instruction', needsDirectory: false },
];
