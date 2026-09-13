import type { JiraProvider } from '../providers/jira.js';
import type { NormalizedTicket } from '../providers/types.js';
import type { Enriched } from '../services/tickets.service.js';

/**
 * The snapshot fields every proposal card renders regardless of who
 * proposed it — Copilot's propose_* tools (mcp/proposalTools.ts) and, since
 * W5b (ROAD-126), a run's host-side finalize (proposals.service.ts's
 * createRunProposal on a Jira issue). One producer of each shape, so a card
 * for a session's report reads exactly like a card for Copilot's comment:
 * the same external-write banner, the same "as whom", the same
 * notification sentence. Two copies of these is how they would drift.
 */

/**
 * The updated-at stamp, from whichever provider's detail record carries it.
 *
 * Native tickets hand back a Date (the column, spread straight through by
 * providers/native.ts's passthrough detail projection); Jira hands back the
 * ISO string its API returned. Normalizing here keeps the snapshot's
 * itemUpdatedAt byte-identical to what the native path has always written.
 */
export function updatedAtIso(ticket: NormalizedTicket): string | undefined {
  const raw = ticket.detail?.updatedAt;
  if (raw instanceof Date) return raw.toISOString();
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The three fields every proposal card renders regardless of kind.
 *
 * Takes either a normalized ticket (the provider-dispatched path) or a raw
 * native row (the three native-only kinds, which never reach a provider).
 * `'provider' in item` is a safe discriminant: it is required on
 * NormalizedTicket and does not exist on a native ticket row.
 */
export function baseSnapshot(item: NormalizedTicket | Enriched) {
  return {
    identifier: item.identifier,
    title: item.title,
    itemUpdatedAt: 'provider' in item ? updatedAtIso(item) : item.updatedAt.toISOString(),
  };
}

/**
 * What the approval card has to say before anyone clicks Approve on a write
 * that leaves Waypoint: which system, which site, which issue, as whom, and
 * who finds out.
 *
 * Every field is display-only. `provider` in particular decides nothing —
 * executeProposal re-resolves a ticket's real provider from its own id and
 * refuses to run if the two disagree, precisely so that a snapshot written at
 * propose time can never be what routes a write.
 */
export function externalSnapshot(jira: JiraProvider, ticket: NormalizedTicket) {
  return {
    provider: 'jira',
    externalSite: jira.site,
    externalUrl: ticket.url,
    externalActorName: jira.actorName,
    // Deliberately a description of Jira's behavior rather than a computed
    // list of people. Jira decides who is notified from the issue's watchers,
    // its assignee and the site's own notification scheme — resolving that
    // truthfully would be an extra round trip per proposal (and still only a
    // snapshot of it), while getting it subtly wrong would be worse than
    // saying plainly what Jira does. The honest general sentence is the right
    // trade here; a real recipient list is a later decision, not a cheaper
    // one.
    externalNotifiesLabel:
      "the issue's watchers and assignee will be notified, per your Jira notification scheme",
  };
}

/**
 * The snapshot for a state_change on a Jira issue — the issue's live STATUS
 * id as `fromStateId` (what checkJiraStaleness re-reads to tell whether the
 * issue moved underneath the proposal), the transition's own label as
 * `toStateName`, and the external banner. Jira status colors are per-site
 * theme data this process does not fetch; null renders as the card's
 * neutral dot rather than a guess.
 */
export function jiraTransitionSnapshot(
  jira: JiraProvider,
  ticket: NormalizedTicket,
  target: { id: string; name: string },
) {
  return {
    ...baseSnapshot(ticket),
    fromStateId: ticket.stateId,
    fromStateName: ticket.stateName,
    fromStateColor: null,
    toStateName: target.name,
    toStateColor: null,
    ...externalSnapshot(jira, ticket),
  };
}
