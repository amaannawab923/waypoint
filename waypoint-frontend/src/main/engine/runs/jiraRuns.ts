import type {
  JiraCommentPage,
  JiraResult,
  JiraWireTicket,
  JiraWireTransition,
} from '../../jira/jiraTypes';
import {
  isTicketRef,
  type LedgerClient,
  type LedgerTicketRef,
} from './ledgerClient';

/**
 * What a run on a Jira issue needs from main's own Jira side — W5b,
 * ROAD-126 (docs/design/w5b-jira-dispatch.md §3). Reads only: the brief
 * is built from what the client already shows in My Jira, and the Fix
 * state change is a transition picked from the issue's live list. Nothing
 * here writes to Jira; a run's report reaches the issue only as a
 * proposal a person approves, through the backend's one write path.
 *
 * Injected so every path is a unit test with fakes; engineIpc.ts hands in
 * jira/jiraClient.ts and the stored credential's site. Absent, or a null
 * site, means Jira is not connected.
 */
export interface JiraRunDeps {
  /** The connected site's hostname (`yourteam.atlassian.net`), or null. */
  site(): string | null;
  getTicket(key: string): Promise<JiraResult<JiraWireTicket>>;
  listComments(key: string): Promise<JiraResult<JiraCommentPage>>;
  listTransitions(key: string): Promise<JiraResult<JiraWireTransition[]>>;
}

export const JIRA_NOT_CONNECTED =
  'Jira is not connected. Connect it in My Jira, then try again.';

/** A run's ticket as a label and a link, whichever system it lives in. */
export interface RunTicketFacts {
  /** `ROAD-116` or `ENG-4`. */
  identifier: string;
  title: string;
  /** A Jira issue's URL; null for a native ticket. */
  url: string | null;
  /** True for a Jira issue: the run's `ticketId` is its `tref-` handle. */
  external: boolean;
  /** The handle's row, for a Jira issue. */
  ref: LedgerTicketRef | null;
}

/**
 * The run's ticket, read from whichever table its id names — the native
 * ticket, or the ref (its cached title; the content is read live where it
 * matters). Null when the id names nothing any more; never throws.
 */
export async function describeRunTicket(
  ledger: Pick<LedgerClient, 'getTicket' | 'getTicketRef'>,
  ticketId: string | null,
): Promise<RunTicketFacts | null> {
  if (!ticketId) return null;
  try {
    if (isTicketRef(ticketId)) {
      const ref = await ledger.getTicketRef(ticketId);
      return ref
        ? {
            identifier: ref.identifier,
            title: ref.title,
            url: ref.url,
            external: true,
            ref,
          }
        : null;
    }
    const ticket = await ledger.getTicket(ticketId);
    return ticket
      ? {
          identifier: ticket.identifier,
          title: ticket.title,
          url: null,
          external: false,
          ref: null,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * The transition a finished Fix proposes on a Jira issue (W5b §2.6): the
 * first whose target status is named for review, else the first whose
 * target category is *in progress* — W5a's `pickReviewState` (a review
 * state, else the last started state) said in Jira's vocabulary, where a
 * status is reached by a named transition and the list depends on where
 * the issue is now. Null when the issue offers neither; the caller files
 * only the comment and says so.
 */
export function pickReviewTransition(
  transitions: JiraWireTransition[],
): JiraWireTransition | null {
  const review = transitions.find((t) => /review/i.test(t.targetStateName));
  if (review) return review;
  return (
    transitions.find((t) => t.targetStateCategory === 'in-progress') ?? null
  );
}

/** A status name that closes an issue without saying it was done. */
export const CLOSING_STATE_NAME =
  /won'?t\s*(do|fix)|cannot\s*reproduce|can'?t\s*reproduce|not\s*a\s*bug|invalid|declined|rejected|cancel|closed|duplicate/i;

/**
 * The transition a session's closing verdict — not a bug, won't fix —
 * proposes (W5c): the first whose target status is named for closing
 * (Won't Do, Cannot Reproduce, Closed…), else the first whose target
 * category is *done* — on a team-managed project that is the only way
 * an issue closes, and the comment beside it carries the verdict. Null
 * when the issue offers neither; the caller files only the comment.
 */
export function pickClosingTransition(
  transitions: JiraWireTransition[],
): JiraWireTransition | null {
  const named = transitions.find((t) =>
    CLOSING_STATE_NAME.test(t.targetStateName),
  );
  if (named) return named;
  return transitions.find((t) => t.targetStateCategory === 'done') ?? null;
}

/** A status name that says the work is done. */
const COMPLETION_STATE_NAME = /done|complete|resolved|shipped|released/i;

/**
 * The transition a `delivered` verdict proposes (customer feedback round
 * 1): the first *done*-category target NOT named for closing-without-doing
 * (Won't Do, Cancelled…), preferring one named Done / Resolved / Shipped.
 * Null when the issue offers no such transition; the caller then falls
 * back to the closing transition with a note saying so.
 */
export function pickCompletionTransition(
  transitions: JiraWireTransition[],
): JiraWireTransition | null {
  const done = transitions.filter(
    (t) =>
      t.targetStateCategory === 'done' &&
      !CLOSING_STATE_NAME.test(t.targetStateName),
  );
  return (
    done.find((t) => COMPLETION_STATE_NAME.test(t.targetStateName)) ??
    done[0] ??
    null
  );
}
