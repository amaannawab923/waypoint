import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ticketsService from '../services/tickets.service.js';
import * as activityService from '../services/activity.service.js';
import * as statesService from '../services/states.service.js';
import * as membersService from '../services/members.service.js';
import { resolveActorNames } from '../lib/actorNames.js';
import type { JiraCredential } from '../lib/jira/client.js';
import { nativeProvider, normalizeNativeTickets } from '../providers/native.js';
import { getJiraProvider, isExternalRef, type JiraProvider } from '../providers/jira.js';
import {
  ProviderUnavailableError,
  type NormalizedComment,
  type NormalizedTicket,
} from '../providers/types.js';

export const PRIORITY = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

// ISO date (YYYY-MM-DD) — enforced at the zod layer so a malformed value
// fails clean validation here instead of reaching Postgres raw (via
// lte(tickets.dueDate, ...) in tickets.service.ts) and leaking a raw DB
// error string back into the chat. The regex alone only checks the SHAPE,
// not that the date is real — "2026-13-99" or "2026-02-31" match it fine —
// so a .refine() below actually parses the string and confirms it
// round-trips: this repo pins zod@^3.24.1 (see package.json), which has no
// z.iso.date() (that's a zod v4 API), so real validation has to be done by
// hand instead of relying on a built-in. `new Date(value + 'T00:00:00Z')`
// against a calendar-invalid date either produces an Invalid Date (rejected
// via the NaN check) or, for JS Date's own overflow semantics, a DIFFERENT
// valid date (e.g. Feb 31 rolling into March) — re-serializing and
// comparing back to the original string catches that case too. Manually
// verified against 2026-13-99, 2026-02-31, 2026-04-31 (April has 30 days),
// 2023-02-29 (not a leap year) — all correctly rejected — and 2026-08-31,
// 2026-12-31, 2024-02-29 (a real leap day) — all correctly accepted.
//
// The calendar-validity check alone still accepts any year from 0000-9999,
// including years Postgres's `date` type itself rejects (e.g. "0000-01-01"
// throws a Postgres range error) — that reaches the withErrorSafetyNet net
// in this file and comes back as an opaque "internal error" instead of a
// clean validation message, even though it's really a validation-catchable
// bad input. MIN_YEAR/MAX_YEAR below is a generous, not exact, range for a
// real due-date use case — it just needs to keep genuinely out-of-range
// years from reaching Postgres at all.
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
export const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    return year >= MIN_YEAR && year <= MAX_YEAR;
  }, `year must be between ${MIN_YEAR} and ${MAX_YEAR}`)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date (YYYY-MM-DD)');

// Every list-style tool (list_tickets, search_tickets, list_comments,
// list_activity) is capped here — an unscoped call can otherwise walk every
// ticket / every comment in the app (there's no workspaceId concept, see
// currentUser.ts) and blow the model's context. The cap is applied at the
// service-layer query itself (see the `limit` passed to ticketsService/
// commentsService/activityService below), not sliced off after fetching
// everything — a post-fetch slice would still pay the cost (and the
// context-window risk of ever materializing) the limit exists to avoid.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const LIMIT_SCHEMA = z
  .number()
  .int()
  .positive()
  .max(MAX_LIST_LIMIT)
  .optional()
  .describe(`Max rows to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). If the result is truncated, narrow the query (e.g. add a filter) rather than raising this.`);

function resolveLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

// Fetches one row past the effective limit (via the `limit` arg passed to
// the service call above each use of this) so a genuinely full page can be
// told apart from a truncated one without a separate count query — if more
// than `effectiveLimit` rows came back, there was more to find.
function page<T>(rows: T[], effectiveLimit: number): { items: T[]; truncated: boolean } {
  const truncated = rows.length > effectiveLimit;
  return { items: truncated ? rows.slice(0, effectiveLimit) : rows, truncated };
}

export const PROVIDER = z.enum(['native', 'jira']);

// Exported for proposalTools.ts: "Jira is not connected" has to read the
// same whether the model was trying to read a Jira issue or to propose a
// change to one, and two wordings of one configuration fact is how a model
// learns to treat them as two different situations.
export const JIRA_NOT_CONNECTED =
  'Jira is not connected for this workspace, so there are no Jira tickets to read. ' +
  'Waypoint tickets are still available — omit the provider argument, or pass provider="native".';

// Model-actionable failure, distinct from both notFoundResult (a real miss)
// and withErrorSafetyNet's generic scrub (a genuine internal error). Same
// shape and same reasoning as proposalTools.ts's validationErrorResult: the
// message has to be specific enough for the model to correct itself on the
// next call, because the model is the only thing that will read it.
function validationErrorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// "Could not find out" is not "found nothing", and the model needs the
// difference: a timeout is worth retrying and a miss is not. Collapsing them
// teaches it to give up on transient failures and to retry permanent ones.
function unavailableResult(error: ProviderUnavailableError) {
  return validationErrorResult(`Jira could not be reached: ${error.message}`);
}

// Every handler that can reach Jira takes it as its FIRST parameter, the same
// shape proposalTools.ts uses for the conversation id and for the same
// reason: it is per-request context, resolved once in registerTicketTools
// from the credential this request borrowed, and threaded explicitly rather
// than looked up from module scope. There is nowhere to look it up FROM — no
// Jira credential is stored in this process (see lib/jira/credentialHeader.ts)
// — so the parameter is not a style choice, it is the only honest signature.
//
// Null means Jira is not connected for this request — never "Jira had
// nothing". Every handler below treats it as "there is no second place to
// look", which is a claim about configuration rather than about tickets.
//
// The concrete class rather than TicketProvider: list_states needs
// listTransitions, which is deliberately not on the read interface (a
// Waypoint ticket has states, not transitions — see getJiraProvider's own
// note). Every read handler here still only touches TicketProvider members.
type Jira = JiraProvider | null;

type Outcome<T> = { status: 'ok'; value: T } | { status: 'failed'; error: ProviderUnavailableError };

// "We did not ask", shaped as a success carrying nothing — which is what it
// is: with Jira disconnected there is genuinely no Jira ticket to find, and
// nothing failed.
const NOT_ASKED: Outcome<null> = { status: 'ok', value: null };

// Catches ONLY ProviderUnavailableError. Anything else is a bug rather than
// an integration being unreachable, and is left to withErrorSafetyNet — which
// logs it server-side and scrubs it out of the model's context. Swallowing
// everything here would turn a real defect into a plausible-looking
// "Jira could not be reached".
async function settled<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { status: 'ok', value: await run() };
  } catch (error) {
    if (error instanceof ProviderUnavailableError) return { status: 'failed', error };
    throw error;
  }
}

// Tickets returned from list/search are projected down to this summary
// shape — an unscoped list_tickets call walks every ticket in the
// app (there's no workspaceId concept, see currentUser.ts), and returning
// full `description` HTML for every row would bloat the model's context for
// no benefit at list time. get_ticket(_by_identifier) return the full
// enriched record, since a single-item lookup is exactly where the detail
// is wanted. dueDate is included here (unlike description) specifically
// because "what's overdue" needs it at list time, not just on drill-down.
//
// assigneeIds are resolved to assigneeNames in one batched pair of queries
// across the whole result set (resolveActorNames), not per-item — a raw id
// like "mem-4" is meaningless to a user reading Copilot's answer. Both the
// id and the resolved name are kept: the id is what a follow-up tool call
// (e.g. a future assignee filter) would need, the name is what's fit to
// show. A name that fails to resolve falls back to the raw id rather than
// dropping the assignee or throwing.
//
// projectId and a resolved stateName/stateGroup are included for the same
// reason: list_states requires a projectId to call, and a summary that
// carried stateId but neither a name nor the projectId needed to resolve
// one left the model with no reliable way to ever name a ticket's state
// from a cold start — it could see "st-a3f9k2m" and nothing else. Found in
// independent review before merge: real (non-seed) state/project ids are
// opaque nanoids, unlike this app's human-readable dev-seed ids, so this
// was invisible in manual QA against the seeded data. stateGroup (e.g.
// "completed"/"cancelled" vs. "started"/"unstarted") is included alongside
// the name so a caller combining dueBefore with a completed-state result
// can tell a shipped ticket apart from a genuinely open one, without a
// second round trip.
//
// The batched name resolution described above now lives in the provider
// layer (providers/native.ts), because it is part of turning a provider's
// rows into a common shape rather than part of serializing them.
// This function is what remains: the projection itself, applied to an
// already-normalized ticket.
//
// The native branch below emits EXACTLY the eleven fields, with the same
// names and in the same order, that this function emitted before providers
// existed — that identity is asserted in providers/native.test.ts. A Jira
// result adds two fields on top of it: `provider`, so the model is never left
// inferring a ticket's origin from which fields happen to be present, and
// `url`, which is the one genuinely useful thing an external ticket has that
// a native one does not.
//
// Native results deliberately do NOT carry `provider: 'native'`, which is the
// one place this file accepts an asymmetry it would otherwise avoid. Adding
// it is a strictly better result shape and should happen the next time these
// tool results change for another reason; doing it here would have meant an
// output change to the path this whole refactor promises is unchanged, to buy
// a cosmetic improvement in the same commit that has to prove it changed
// nothing.
function toSummary(item: NormalizedTicket) {
  const summary = {
    id: item.ref,
    identifier: item.identifier,
    title: item.title,
    projectId: item.projectId,
    stateId: item.stateId,
    stateName: item.stateName,
    stateGroup: item.stateGroup,
    priority: item.priority,
    dueDate: item.dueDate,
    assigneeIds: item.assigneeIds,
    assigneeNames: item.assigneeNames,
  };
  if (item.provider === 'native') return summary;
  return { provider: item.provider, ...summary, url: item.url };
}

function toSummaries(items: NormalizedTicket[]) {
  return items.map(toSummary);
}

// The single-item detail projection. `detail` is the provider's own full
// record (see NormalizedTicket.detail) — for a native ticket it is the entire
// enriched row, exactly what get_ticket has always returned, which is why
// this is a passthrough rather than a reconstruction.
function toDetail(item: NormalizedTicket) {
  return truncateDescription(item.detail ?? {});
}

// The comment projection. Native comments keep `bodyHtml` — the key
// list_comments has always used, and still accurate, since a native comment
// really is HTML. A Jira comment's body is ADF flattened to plain text, so
// calling it bodyHtml would be a lie the model could act on (by, say, trying
// to strip tags that aren't there); it gets `body` plus an explicit
// `bodyFormat` instead.
function toCommentJson(comment: NormalizedComment) {
  if (comment.bodyFormat === 'html') {
    return {
      id: comment.id,
      ticketId: comment.ticketId,
      authorId: comment.authorId,
      bodyHtml: comment.body,
      createdAt: comment.createdAt,
      authorName: comment.authorName,
    };
  }
  return {
    id: comment.id,
    ticketId: comment.ticketId,
    authorId: comment.authorId,
    body: comment.body,
    bodyFormat: comment.bodyFormat,
    createdAt: comment.createdAt,
    authorName: comment.authorName,
  };
}

// The list/search summary path (toSummaries above) already drops
// `description` entirely — it's not needed at list time and would bloat
// context for every row. The single-item detail path (get_ticket(_by_
// identifier)) legitimately wants the full description, but had no size
// guard at all: one pathologically long ticket could still blow out the
// model's context on a single lookup. A plain length cap with a marker is
// enough here — this is JSON text handed to the model, not markup rendered
// anywhere, so there's no HTML-aware truncation to get right.
const DESCRIPTION_MAX_LENGTH = 20_000;
function truncateDescription<T extends { description?: string | null }>(item: T): T {
  const { description } = item;
  if (typeof description !== 'string' || description.length <= DESCRIPTION_MAX_LENGTH) return item;
  return { ...item, description: `${description.slice(0, DESCRIPTION_MAX_LENGTH)}… (truncated)` };
}

// Ticket titles/descriptions/comments are user-authored, semi-trusted
// content that flows straight into the model's context once a tool result
// below is serialized — a ticket could contain text crafted to look like an
// instruction to the model (prompt injection), or a link designed to
// exfiltrate data the model has seen once the renderer makes it clickable
// (see markdown.ts's SAFE_URL scheme allowlist and lack of image-syntax
// support, both of which already narrow this). This is a known, accepted
// risk given those existing mitigations and the read-only, no-tool-side-
// effects posture of this V1 tool set (see copilotRunner.ts's own comments
// on why write tools don't exist yet) — not something this file attempts to
// further sanitize against, since there's no reliable way to distinguish
// "ticket content that happens to look like an instruction" from prose
// without breaking legitimate ticket content.
//
// jsonResult/notFoundResult/withErrorSafetyNet/PRIORITY/ISO_DATE are
// exported (rather than duplicated) so proposalTools.ts keeps exactly the
// same result/error conventions as this file — one definition per concern.
export function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function notFoundResult(what: string) {
  return { content: [{ type: 'text' as const, text: `${what} not found` }], isError: true };
}

export const INTERNAL_ERROR_MESSAGE = 'An internal error occurred while processing this request.';

// Safety net around every registered tool handler below (see
// registerTicketTools), not specific to dueBefore/ISO_DATE — any
// service-layer throw (a DB constraint, a timeout, a bug in a future
// change) would otherwise reach the MCP SDK's own error serialization with
// its raw `error.message`, exactly the class of leak ISO_DATE's own
// validation exists to close for one particular case (see errorHandler.ts's
// pgErrorCode()/isServerFaultSqlState() for the REST-side equivalent of
// this concern — raw driver text reaching an untrusted surface). The error
// is still logged server-side via console.error (matching errorHandler.ts's
// own convention for genuinely-unexpected failures) — only what reaches the
// model's context is scrubbed to a generic message.
export function withErrorSafetyNet<Args extends Record<string, unknown>>(
  toolName: string,
  handler: (args: Args) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
) {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      // An unreachable external provider is not an internal error, and
      // scrubbing it to one throws away the only part the model can act on:
      // whether retrying is worth anything. This is the catch-all for the
      // single-provider paths (an explicit provider="jira", or a tref id);
      // the resolution algorithm handles its own failure via settled(),
      // because there it must not abort the native lookup running alongside.
      if (error instanceof ProviderUnavailableError) {
        console.error(`MCP tool "${toolName}" could not reach a provider:`, error);
        return unavailableResult(error);
      }
      console.error(`MCP tool "${toolName}" failed:`, error);
      return { content: [{ type: 'text' as const, text: INTERNAL_ERROR_MESSAGE }], isError: true };
    }
  };
}

export async function listTicketsHandler({
  projectId,
  assigneeId,
  stateId,
  priority,
  dueBefore,
  limit,
}: {
  projectId?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: z.infer<typeof PRIORITY>;
  dueBefore?: string;
  limit?: number;
}) {
  const effectiveLimit = resolveLimit(limit);
  const filters = { assigneeId, stateId, priority, dueBefore, limit: effectiveLimit + 1 };
  const items = projectId
    ? await ticketsService.listTickets(projectId, filters)
    : await ticketsService.listAllTickets(filters);
  const { items: pageItems, truncated } = page(items, effectiveLimit);
  // Native-only, deliberately — see normalizeNativeTickets on why a
  // filter-based list has no meaningful cross-provider form.
  return jsonResult({ items: toSummaries(await normalizeNativeTickets(pageItems)), truncated });
}

// Drafts are excluded from listTickets/listAllTickets/searchTickets
// at the service layer (isDraft filter), but getTicket(_ByIdentifier)
// have no such filter — they're the REST detail-view fetch, which is
// reached only via a draft's own owner navigating to it directly. Sequential
// identifiers (WI-42, WI-43, ...) are guessable, so without this check a
// draft (including its full description) would otherwise be retrievable
// through this tool despite being invisible to every list/search tool —
// treated as a real miss here, same as get_ticket on an id that doesn't
// exist at all, rather than changing the underlying service functions'
// REST-facing behavior (which other, non-MCP callers may depend on
// including drafts).
// Dispatches on the id's own prefix. A "tref-" id can only have come from a
// ticket_refs row (lib/ids.ts mints internal ticket ids as "wi-"), so no
// lookup is needed to know which provider owns it, and no provider argument
// has to be threaded through every call that already carries an id.
export async function getTicketHandler(jira: Jira, { id }: { id: string }) {
  if (isExternalRef(id)) {
    if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
    const item = await jira.getByRef(id);
    return item ? jsonResult(toDetail(item)) : notFoundResult('ticket');
  }
  const item = await nativeProvider.getByRef(id);
  if (!item) return notFoundResult('ticket');
  return jsonResult(toDetail(item));
}

/**
 * Identifier resolution.
 *
 * A human-typed identifier is the ONE place where a ticket's provider is
 * genuinely ambiguous. Native identifiers are minted as
 * `${project.identifier}-${sequence}` (tickets.service.ts) — the same
 * PROJECT-NUMBER shape as a Jira issue key — so "ENG-4" can perfectly well
 * name two different tickets in two different systems. Everywhere else the
 * ambiguity is already gone: once any read tool has returned a ticket, its
 * `id` is a prefixed internal handle ("wi-…" or "tref-…") and every
 * downstream call dispatches on that instead of re-resolving a string.
 *
 * The ordering below is the part that matters, and it is deliberately not the
 * obvious one:
 *
 *   BOTH lookups always run. A native hit does NOT short-circuit the Jira
 *   check. Checking native first and returning early is the natural way to
 *   write this and it is wrong — it resolves an ambiguous identifier to
 *   whichever provider happened to be checked first, and nobody ever finds
 *   out there was another ticket by that name. They are issued concurrently
 *   so the property is structural rather than a fact about statement order
 *   that a later edit could quietly undo.
 *
 * The Jira side is a live point-lookup for that exact key — not a scan, and
 * not a cache read (see JiraProvider.getByIdentifier for why the ref cache
 * cannot answer it). A cache miss therefore never means "must be native",
 * which is the specific gap this shape exists to close.
 *
 * When both match, this refuses to guess. Picking one and hoping is the worst
 * option available: right half the time, silently wrong the rest, and
 * "confidently read the wrong ticket" is a failure nobody can detect from the
 * answer.
 */
export async function getTicketByIdentifierHandler(
  jira: Jira,
  {
    identifier,
    provider,
  }: {
    identifier: string;
    provider?: z.infer<typeof PROVIDER>;
  },
) {
  // An explicit provider is an instruction, not a hint: look only there. It
  // is also how a caller answers the ambiguity error below.
  if (provider === 'native') {
    const item = await nativeProvider.getByIdentifier(identifier);
    return item ? jsonResult(toDetail(item)) : notFoundResult('ticket');
  }
  if (provider === 'jira') {
    if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
    const item = await jira.getByIdentifier(identifier);
    return item ? jsonResult(toDetail(item)) : notFoundResult('ticket');
  }

  // Both, concurrently — see the ordering note above.
  const [nativeHit, jiraOutcome] = await Promise.all([
    nativeProvider.getByIdentifier(identifier),
    jira ? settled(() => jira.getByIdentifier(identifier)) : Promise.resolve(NOT_ASKED),
  ]);

  if (jiraOutcome.status === 'failed') {
    // Jira failed to answer, so what it would have said is unknown.
    //
    // With a native hit, return it: an optional integration having a bad
    // minute must not break a path that worked before Jira was ever
    // connected. The residual risk is real and accepted — if that identifier
    // also named a Jira issue, this silently resolves to native, which is
    // exactly what happened before this feature existed.
    //
    // Without one, refuse. "Not found" would be a positive claim resting on a
    // lookup that did not happen, and the model would act on it.
    if (nativeHit) return jsonResult(toDetail(nativeHit));
    return unavailableResult(jiraOutcome.error);
  }

  const jiraHit = jiraOutcome.value;
  if (nativeHit && jiraHit) {
    return validationErrorResult(
      `"${identifier}" is ambiguous: it names a Waypoint ticket ("${nativeHit.title}") and a Jira issue ("${jiraHit.title}"). ` +
        'Call get_ticket_by_identifier again with provider="native" or provider="jira" to say which you mean, ' +
        `or use get_ticket with id="${nativeHit.ref}" or id="${jiraHit.ref}".`,
    );
  }
  if (nativeHit) return jsonResult(toDetail(nativeHit));
  if (jiraHit) return jsonResult(toDetail(jiraHit));
  return notFoundResult('ticket');
}

export async function searchTicketsHandler(
  jira: Jira,
  {
    query,
    projectId,
    limit,
    provider,
  }: {
    query: string;
    projectId?: string;
    limit?: number;
    provider?: z.infer<typeof PROVIDER>;
  },
) {
  const effectiveLimit = resolveLimit(limit);
  // limit + 1 PER SOURCE, so truncation is detected per provider rather than
  // masked by the merge — a full page of native hits would otherwise hide
  // that Jira had more to give.
  const fetchLimit = effectiveLimit + 1;

  if (provider === 'jira') {
    if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
    const found = page(await jira.search(query, { projectId, limit: fetchLimit }), effectiveLimit);
    return jsonResult({ items: toSummaries(found.items), truncated: found.truncated });
  }

  const native = page(
    await nativeProvider.search(query, { projectId, limit: fetchLimit }),
    effectiveLimit,
  );
  if (provider === 'native') {
    return jsonResult({ items: toSummaries(native.items), truncated: native.truncated });
  }

  if (!jira) return jsonResult({ items: toSummaries(native.items), truncated: native.truncated });

  // projectId means a native project id on one side and a Jira project key on
  // the other. Passing it to both is still right: it is the caller's scope,
  // and a provider that does not recognise it contributes nothing rather than
  // contributing wrong rows.
  const jiraOutcome = await settled(() => jira.search(query, { projectId, limit: fetchLimit }));
  if (jiraOutcome.status === 'failed') {
    // Degrade to native results rather than failing the search outright: half
    // an answer is useful, and the alternative is a Jira outage breaking
    // search over this app's own tickets.
    console.error('MCP tool "search_tickets" could not search Jira:', jiraOutcome.error);
    return jsonResult({
      items: toSummaries(native.items),
      truncated: native.truncated,
      // Named explicitly so the model can say "I could not check Jira"
      // instead of implying Jira had no matches.
      jiraUnavailable: true,
    });
  }

  const external = page(jiraOutcome.value, effectiveLimit);
  return jsonResult({
    items: [...toSummaries(native.items), ...toSummaries(external.items)],
    truncated: native.truncated || external.truncated,
  });
}

// Same draft-hiding requirement as getTicketHandler/getTicketByIdentifierHandler
// above, reached a different way: a draft is invisible to every list/search
// tool, but its comments and activity history (including the unconditional
// "created the ticket" entry every item gets — see tickets.service.ts's
// createTicket) were still fully retrievable via the draft's own internal
// id, since neither of these handlers checked isDraft before fetching. One
// extra query per call is the accepted cost of closing that — but it only
// needs to be a cheap existence/isDraft check, not the full enriched fetch
// (getTicket() also joins labels/assignees/links, none of which either
// handler below uses), hence isTicketDraftOrMissing() instead of getTicket().
export async function listCommentsHandler(
  jira: Jira,
  { ticketId, limit }: { ticketId: string; limit?: number },
) {
  const effectiveLimit = resolveLimit(limit);
  // Same prefix dispatch as get_ticket. The draft gate below is native-only
  // by nature — drafts are this app's concept, and a Jira issue reachable by
  // a ref has already been proven visible to the connected account.
  if (isExternalRef(ticketId)) {
    if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
    const external = page(await jira.listComments(ticketId, effectiveLimit + 1), effectiveLimit);
    return jsonResult({ items: external.items.map(toCommentJson), truncated: external.truncated });
  }
  if (await ticketsService.isTicketDraftOrMissing(ticketId)) return notFoundResult('ticket');
  const comments = await nativeProvider.listComments(ticketId, effectiveLimit + 1);
  const { items: pageItems, truncated } = page(comments, effectiveLimit);
  return jsonResult({ items: pageItems.map(toCommentJson), truncated });
}

export async function listActivityHandler({ ticketId, limit }: { ticketId: string; limit?: number }) {
  // Deliberately native-only, and deliberately NOT a "not found": a Jira
  // issue's change history is a real thing that exists and this tool cannot
  // read it, which is a different fact from the ticket not being there.
  // Saying so stops the model concluding a Jira issue has no history.
  if (isExternalRef(ticketId)) {
    return validationErrorResult(
      'Activity history is not available for Jira issues — use list_comments for that ticket instead.',
    );
  }
  if (await ticketsService.isTicketDraftOrMissing(ticketId)) return notFoundResult('ticket');
  const effectiveLimit = resolveLimit(limit);
  const activity = await activityService.listActivity(ticketId, effectiveLimit + 1);
  const { items: pageItems, truncated } = page(activity, effectiveLimit);
  const names = await resolveActorNames(pageItems.map((a) => a.actorId));
  return jsonResult({
    items: pageItems.map((a) => ({ ...a, actorName: names.get(a.actorId) ?? a.actorId })),
    truncated,
  });
}

/**
 * The states a ticket can be moved to — from a project, or from one issue.
 *
 * The two arguments are not two ways of asking the same question, and the
 * asymmetry is Jira's, not this tool's. A Waypoint project has a fixed list
 * of states and every ticket in it can reach any of them, so a projectId is
 * the whole answer. A Jira issue has no such list: what it can reach is a set
 * of TRANSITIONS, decided by its current status, its workflow, and the
 * connected account's permissions — a property of the issue, not the project,
 * and one that changes when anyone moves the issue.
 *
 * So `ticketId` is not a convenience alias for "the project this ticket is
 * in". It is the only question that has an answer on the Jira side, which is
 * why passing a native id to it is refused rather than quietly redirected to
 * the project lookup: a model that got an answer from the wrong question here
 * would go on to propose a state change with an id that can never apply.
 *
 * Both shapes return { id, name, group, ... }, so the model needs no second
 * concept. What differs is what `id` MEANS — a durable state id for native, a
 * transition id that is only valid for this issue right now for Jira — and
 * that is said in the tool description, because it is the model that has to
 * know it.
 */
export async function listStatesHandler(
  jira: Jira,
  { projectId, ticketId }: { projectId?: string; ticketId?: string },
) {
  if (projectId && ticketId) {
    return validationErrorResult(
      'Pass either projectId or ticketId, not both — they ask different questions. ' +
        "Use ticketId for a Jira issue (its own available transitions) and projectId for a Waypoint project's states.",
    );
  }

  if (ticketId) {
    if (!isExternalRef(ticketId)) {
      return validationErrorResult(
        'ticketId is only for Jira issues (an id starting with "tref-"). ' +
          "For a Waypoint ticket, call list_states with that ticket's projectId instead.",
      );
    }
    if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
    const transitions = await jira.listTransitions(ticketId);
    if (!transitions) return notFoundResult('ticket');
    return jsonResult(transitions);
  }

  if (!projectId) {
    return validationErrorResult(
      'Pass a projectId (for a Waypoint project) or a ticketId (for a Jira issue).',
    );
  }
  return jsonResult(await statesService.listStates(projectId));
}

export async function listMembersHandler() {
  const members = await membersService.listMembers();
  // email is deliberately dropped: this tool exists to resolve an assignee
  // id to a display name, or to find a member's id to filter
  // list_tickets by — neither use needs a member's email address, so it
  // isn't put in front of the model.
  return jsonResult(members.map(({ id, displayName, role }) => ({ id, displayName, role })));
}

// The credential is resolved into a provider ONCE per server (which is once
// per request — see mcp/server.ts), rather than per tool call: construction
// does no I/O, so there is nothing to defer, and doing it here means every
// handler below sees the same Jira for the whole request instead of each one
// re-deriving it.
export function registerTicketTools(server: McpServer, jiraCredential: JiraCredential | null): void {
  const jira = getJiraProvider(jiraCredential);

  server.registerTool(
    'list_tickets',
    {
      description:
        'List tickets, optionally scoped to one project and/or filtered by assignee, state, priority, or a due-by date. Returns a summary per item (including dueDate, projectId, and resolved assignee/state names), not full detail. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: {
        projectId: z.string().optional().describe('If given, only list tickets in this project.'),
        assigneeId: z.string().optional().describe('If given, only items with this member/agent id as an assignee.'),
        stateId: z.string().optional().describe('If given, only items in this state — get state ids via list_states.'),
        priority: PRIORITY.optional().describe('If given, only items with this priority.'),
        dueBefore: ISO_DATE.optional().describe(
          "ISO date (YYYY-MM-DD). If given, only items due on or before this date — e.g. pass today's date to find overdue items.",
        ),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet('list_tickets', listTicketsHandler),
  );

  server.registerTool(
    'get_ticket',
    {
      description:
        'Get the full details of one ticket by its internal id, as returned by search_tickets or get_ticket_by_identifier. ' +
        'Works for both Waypoint tickets and Jira issues — the id says which, so nothing else is needed.',
      inputSchema: { id: z.string() },
    },
    withErrorSafetyNet('get_ticket', (args: { id: string }) => getTicketHandler(jira, args)),
  );

  server.registerTool(
    'get_ticket_by_identifier',
    {
      description:
        'Get the full details of one ticket by its human-readable identifier, e.g. "WI-42" or "ENG-4". ' +
        'Waypoint tickets and Jira issues share the same PROJECT-NUMBER identifier format, so an identifier can name one of each; ' +
        'when it does, this returns an error naming both and you should call it again with the provider argument set. ' +
        'Prefer get_ticket with an id from an earlier result when you have one — an id is never ambiguous.',
      inputSchema: {
        identifier: z.string(),
        provider: PROVIDER.optional().describe(
          'Which system to look in. Omit to search both and be told if the identifier is ambiguous; ' +
            'set it to resolve an ambiguity you were just told about.',
        ),
      },
    },
    withErrorSafetyNet(
      'get_ticket_by_identifier',
      (args: { identifier: string; provider?: z.infer<typeof PROVIDER> }) =>
        getTicketByIdentifierHandler(jira, args),
    ),
  );

  server.registerTool(
    'search_tickets',
    {
      description:
        'Search tickets by a title keyword, optionally scoped to one project. Searches both Waypoint tickets and, when Jira is connected, Jira issues; ' +
        'each result carries the id to use for follow-up calls, and Jira results are marked with provider "jira" and a url. ' +
        'Returns a summary per match. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true. ' +
        'A jiraUnavailable flag in the result means Jira could not be searched, NOT that Jira had no matches.',
      inputSchema: {
        // .trim().min(1) — an empty (or whitespace-only, e.g. " ") query
        // otherwise matches every ticket's title (an unscoped
        // `ilike('%<query>%', title)` in tickets.service.ts), effectively
        // turning "search" into "list everything" by accident. `.trim()` is
        // a zod transform, so the value the MCP SDK hands to
        // searchTicketsHandler below (parsed via safeParseAsync before the
        // handler is called) is already the trimmed string — not the raw
        // input — so the trimmed value is what actually reaches the ilike
        // pattern too, not just what min(1) validates against.
        query: z.string().trim().min(1),
        projectId: z
          .string()
          .optional()
          .describe('A Waypoint project id, or a Jira project key when searching Jira.'),
        provider: PROVIDER.optional().describe('Restrict the search to one system. Omit to search both.'),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet(
      'search_tickets',
      (args: {
        query: string;
        projectId?: string;
        provider?: z.infer<typeof PROVIDER>;
        limit?: number;
      }) => searchTicketsHandler(jira, args),
    ),
  );

  server.registerTool(
    'list_comments',
    {
      description:
        "List the comments on one ticket, with each comment's author name resolved. Accepts the id of a Waypoint ticket or a Jira issue. " +
        'Waypoint comments come back as bodyHtml; Jira comments come back as plain-text body with bodyFormat "text". ' +
        'Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: { ticketId: z.string(), limit: LIMIT_SCHEMA },
    },
    withErrorSafetyNet('list_comments', (args: { ticketId: string; limit?: number }) =>
      listCommentsHandler(jira, args),
    ),
  );

  server.registerTool(
    'list_activity',
    {
      description:
        "List the activity history (state/assignee/label/etc. changes) on one ticket, with each entry's actor name resolved. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.",
      inputSchema: { ticketId: z.string(), limit: LIMIT_SCHEMA },
    },
    withErrorSafetyNet('list_activity', listActivityHandler),
  );

  server.registerTool(
    'list_states',
    {
      description:
        "List the workflow states a ticket can be in. Pass projectId for a Waypoint project: the states (e.g. Backlog, In Progress, Done) configured for it, in board order — use this to resolve a ticket's stateId to a real name, or to find a stateId to filter list_tickets by. " +
        'Pass ticketId (a "tref-" id) for a Jira issue instead: Jira has no per-project state list, only the transitions THAT issue can make right now, which depend on its current status and your permissions. ' +
        'Both return {id, name, group}, but a Jira id is a transition id that is only valid for that issue right now — always call this again just before proposing a Jira state change rather than reusing an id from earlier in the conversation.',
      inputSchema: {
        projectId: z.string().optional().describe('A Waypoint project id. Omit when passing ticketId.'),
        ticketId: z
          .string()
          .optional()
          .describe('A Jira issue id ("tref-…"), as returned by search_tickets or get_ticket_by_identifier.'),
      },
    },
    withErrorSafetyNet('list_states', (args: { projectId?: string; ticketId?: string }) =>
      listStatesHandler(jira, args),
    ),
  );

  server.registerTool(
    'list_members',
    {
      description:
        "List the workspace's members (id, display name, role). Use this to resolve an assignee id to a name, or to find a member's id to filter list_tickets by.",
      inputSchema: {},
    },
    withErrorSafetyNet('list_members', listMembersHandler),
  );
}
