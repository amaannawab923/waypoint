import {
  getJiraTransitions,
  setJiraTicketPriority,
  transitionJiraTicket,
} from '@/data/jiraApi';
import { showErrorToast, showInfoToast } from '@/lib/toast';
import type {
  JiraPriorityOption,
  JiraTicket,
  JiraTransition,
} from '@/types/jira';

/**
 * The two one-click writes a ticket row and the drawer both make — a state
 * move and a priority change — with the undo that makes a mis-click cheap
 * (customer feedback round 1, Fix 5: "clicking the pill transitions the
 * real ticket, no confirm, no undo").
 *
 * Undo is a real Jira write, never a client-side revert. For a move it is
 * the workflow's own transition back to the state the ticket was on,
 * looked up AFTER the move (the transitions legal from the new state);
 * a workflow with no way back, or one whose way back needs a field, has
 * no Undo button — never one that silently fails. For a priority it is
 * the previous priority written back, which every issue that accepts a
 * priority accepts. If the ticket was moved by someone else inside the
 * window, the inverse write fails the way any write fails: the error
 * toast, and the ticket as Jira now has it.
 *
 * Both throw what the data layer throws, so the caller's own error
 * handling (the chip's saving state, the error toast) is unchanged.
 */

/** How long the undo toast offers its button. */
export const UNDO_WINDOW_MS = 5000;
const REVERTED_MS = 2000;

/** Hooks a caller hands in so the row/drawer it lives in updates too. */
export interface UndoableWriteHost {
  onTicketUpdated: (updated: JiraTicket) => void;
}

/** The transition from `transitions` that lands back on `stateName`, when
 * it needs nothing but a click. */
export function inverseTransition(
  transitions: JiraTransition[],
  stateName: string,
): JiraTransition | null {
  return (
    transitions.find(
      (t) => t.targetStateName === stateName && t.requiresFields.length === 0,
    ) ?? null
  );
}

export async function moveJiraTicketWithUndo(
  host: UndoableWriteHost,
  ticket: JiraTicket,
  transition: JiraTransition,
  fieldValues: Record<string, string>,
): Promise<JiraTicket> {
  const updated = await transitionJiraTicket(
    ticket.id,
    transition.id,
    fieldValues,
  );
  host.onTicketUpdated(updated);
  const moved = `Moved ${ticket.key} to ${updated.stateName}.`;
  // The way back is only knowable from the new state, so it is read after
  // the move; a failed read means no Undo, not a failed move.
  const back = await getJiraTransitions(ticket.id)
    .then((rows) => inverseTransition(rows, ticket.stateName))
    .catch(() => null);
  if (!back) {
    showInfoToast(moved, { durationMs: UNDO_WINDOW_MS });
    return updated;
  }
  showInfoToast(moved, {
    durationMs: UNDO_WINDOW_MS,
    action: {
      label: 'Undo',
      onClick: async () => {
        try {
          host.onTicketUpdated(
            await transitionJiraTicket(ticket.id, back.id, {}),
          );
          showInfoToast('Reverted.', { durationMs: REVERTED_MS });
        } catch (err) {
          showErrorToast(
            err instanceof Error
              ? err.message
              : `Could not move ${ticket.key} back to ${ticket.stateName}.`,
          );
        }
      },
    },
  });
  return updated;
}

export async function setJiraTicketPriorityWithUndo(
  host: UndoableWriteHost,
  ticket: JiraTicket,
  option: JiraPriorityOption,
): Promise<JiraTicket> {
  const updated = await setJiraTicketPriority(ticket.id, option.id);
  host.onTicketUpdated(updated);
  const changed = `Set ${ticket.key} to ${updated.priorityName}.`;
  const previous = ticket.priorityId;
  if (!previous || previous === option.id) {
    showInfoToast(changed, { durationMs: UNDO_WINDOW_MS });
    return updated;
  }
  showInfoToast(changed, {
    durationMs: UNDO_WINDOW_MS,
    action: {
      label: 'Undo',
      onClick: async () => {
        try {
          host.onTicketUpdated(
            await setJiraTicketPriority(ticket.id, previous),
          );
          showInfoToast('Reverted.', { durationMs: REVERTED_MS });
        } catch (err) {
          showErrorToast(
            err instanceof Error
              ? err.message
              : `Could not set ${ticket.key} back to ${ticket.priorityName}.`,
          );
        }
      },
    },
  });
  return updated;
}
