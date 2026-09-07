import * as ticketsService from '../services/tickets.service.js';
import * as commentsService from '../services/comments.service.js';
import * as statesService from '../services/states.service.js';
import { resolveActorNames } from '../lib/actorNames.js';
import type {
  NormalizedComment,
  NormalizedTicket,
  SearchOptions,
  TicketProvider,
} from './types.js';

/**
 * This app's own tickets, behind the provider interface.
 *
 * A pure refactor with no behavior change, and that is a requirement rather
 * than an aspiration — the native path is the one every existing user is
 * already on, and it must be provably identical after a change whose whole
 * purpose is to add a SECOND path beside it. providers/native.test.ts pins
 * that: same service functions, same arguments, same emitted JSON.
 *
 * Two details carry that guarantee and are easy to break by accident:
 *
 *  - Name resolution is BATCHED ACROSS THE WHOLE RESULT SET, exactly as
 *    toSummaries did it — one resolveActorNames and one resolveStateNames per
 *    call, not per row. Normalizing item-by-item would be the obvious way to
 *    write this and would turn one query pair into 2N of them on a 50-row
 *    search, which is a behavior change even though every value returned
 *    would match.
 *
 *  - `limit` is passed through untouched. The tool layer asks for limit + 1 to
 *    detect truncation (see page()), so a provider that clamped or
 *    reinterpreted it would silently break truncation detection rather than
 *    fail visibly.
 *
 * ticketsService and commentsService are called exactly as mcp/ticketTools.ts
 * called them before, and neither service was modified for this.
 */

/** The state-name/-group pair, resolved for a batch of stateIds at once. */
async function resolveStates(stateIds: string[]) {
  return statesService.resolveStateNames(stateIds);
}

function toNormalized(
  item: ticketsService.Enriched,
  assigneeNames: Map<string, string>,
  stateNames: Awaited<ReturnType<typeof resolveStates>>,
): NormalizedTicket {
  return {
    provider: 'native',
    ref: item.id,
    identifier: item.identifier,
    title: item.title,
    projectId: item.projectId,
    stateId: item.stateId,
    // Falls back to the raw id rather than dropping the field or throwing —
    // the pre-existing behavior, and the right one: an unresolvable state is
    // still a state the model can pass back to a filter.
    stateName: stateNames.get(item.stateId)?.name ?? item.stateId,
    stateGroup: stateNames.get(item.stateId)?.group,
    priority: item.priority,
    dueDate: item.dueDate,
    assigneeIds: item.assigneeIds,
    assigneeNames: item.assigneeIds.map((id) => assigneeNames.get(id) ?? id),
    // Native tickets have no addressable web URL from this process: the
    // desktop app owns its own routing and this server does not know what
    // origin it is being viewed under. Null is the honest answer, not a
    // guessed localhost link.
    url: null,
  };
}

/**
 * The single-item detail projection.
 *
 * Spreads the enriched record first so every column keeps its original key
 * AND its original position — the whole row is what get_ticket has always
 * returned, and reconstructing it field-by-field from NormalizedTicket would
 * both drop columns (sprintId, estimatePoints, links, ...) and reorder the
 * rest. `detail` exists precisely so this can stay a passthrough.
 */
function toDetail(
  item: ticketsService.Enriched,
  assigneeNames: Map<string, string>,
  stateNames: Awaited<ReturnType<typeof resolveStates>>,
): Record<string, unknown> {
  return {
    ...item,
    assigneeNames: item.assigneeIds.map((id) => assigneeNames.get(id) ?? id),
    stateName: stateNames.get(item.stateId)?.name ?? item.stateId,
    stateGroup: stateNames.get(item.stateId)?.group,
  };
}

async function normalizeOne(item: ticketsService.Enriched): Promise<NormalizedTicket> {
  const [assigneeNames, stateNames] = await Promise.all([
    resolveActorNames(item.assigneeIds),
    resolveStates([item.stateId]),
  ]);
  return {
    ...toNormalized(item, assigneeNames, stateNames),
    detail: toDetail(item, assigneeNames, stateNames),
  };
}

/**
 * Exported because list_tickets is not part of TicketProvider and never will
 * be: it is a filter-based query over assignee/state/priority/due date, and
 * those filters mean this app's own ids. Fanning it out to a provider whose
 * ids come from somewhere else would produce an empty result that looks like
 * an answer. It still needs the same normalization, hence the shared helper
 * rather than a second copy of the projection.
 */
export async function normalizeNativeTickets(
  items: ticketsService.Enriched[],
): Promise<NormalizedTicket[]> {
  return normalizeMany(items);
}

async function normalizeMany(items: ticketsService.Enriched[]): Promise<NormalizedTicket[]> {
  const [assigneeNames, stateNames] = await Promise.all([
    resolveActorNames(items.flatMap((item) => item.assigneeIds)),
    resolveStates(items.map((item) => item.stateId)),
  ]);
  // No `detail` — see NormalizedTicket.detail on why the list path must not
  // populate it.
  return items.map((item) => toNormalized(item, assigneeNames, stateNames));
}

/**
 * Drafts read as misses on every path.
 *
 * Unchanged from the handlers this replaces, and worth restating because it
 * is a privacy rule rather than a filter: identifiers are sequential and
 * guessable, so a draft that is invisible to list/search but retrievable by
 * id or identifier is retrievable by anyone who can count. The check lives
 * here rather than in ticketsService because the REST routes legitimately
 * fetch drafts for their own owner.
 */
function visible(item: ticketsService.Enriched | undefined | null) {
  return item && !item.isDraft ? item : null;
}

export const nativeProvider: TicketProvider = {
  kind: 'native',

  async getByRef(ref) {
    const item = visible(await ticketsService.getTicket(ref));
    return item ? normalizeOne(item) : null;
  },

  async getByIdentifier(identifier) {
    const item = visible(await ticketsService.getTicketByIdentifier(identifier));
    return item ? normalizeOne(item) : null;
  },

  async search(query, { projectId, limit }: SearchOptions) {
    return normalizeMany(await ticketsService.searchTickets(query, projectId, limit));
  },

  async listComments(ref, limit): Promise<NormalizedComment[]> {
    // The existence/draft gate stays a cheap check rather than a full
    // getTicket: neither this nor the activity path uses the joined
    // labels/assignees/links that getTicket also fetches. Pre-existing
    // behavior, preserved deliberately.
    if (await ticketsService.isTicketDraftOrMissing(ref)) return [];
    const rows = await commentsService.listComments(ref, limit);
    const names = await resolveActorNames(rows.map((row) => row.authorId));
    return rows.map((row) => ({
      id: row.id,
      ticketId: row.ticketId,
      authorId: row.authorId,
      authorName: names.get(row.authorId) ?? row.authorId,
      body: row.bodyHtml,
      bodyFormat: 'html',
      // The column is a Date and used to be serialized by JSON.stringify,
      // which calls toJSON() — i.e. toISOString(). Doing it explicitly here
      // produces the identical string while making the type honest.
      createdAt: row.createdAt.toISOString(),
    }));
  },
};

/**
 * Whether a ticket exists but is hidden, as distinct from not existing.
 *
 * Exposed separately because list_comments and list_activity have to tell
 * "no comments" apart from "no such ticket" — an empty array is a legitimate
 * answer for the first and a lie for the second.
 */
export async function isMissingOrHidden(ref: string): Promise<boolean> {
  return ticketsService.isTicketDraftOrMissing(ref);
}
