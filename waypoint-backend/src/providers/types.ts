/**
 * The seam between Copilot's read tools and wherever a ticket actually lives.
 *
 * Before this existed, mcp/ticketTools.ts called ticketsService directly and
 * "a ticket" meant "a row in this app's tickets table". A Jira issue is a
 * ticket by every definition a user or a model would use, so the tools now
 * talk to a provider and the provider decides what that means.
 *
 * The design constraint that shaped everything below: a tool result must look
 * structurally the same whichever provider produced it. A model that has to
 * learn two result shapes will use the wrong one, and the failure is silent —
 * it reads a field that is absent, concludes something false, and says it
 * confidently.
 */

export type TicketProviderKind = 'native' | 'jira';

/**
 * One ticket, in cross-provider terms.
 *
 * The fields here are the ones that mean the same thing everywhere, chosen to
 * cover exactly what the existing list/search projection already returned for
 * native tickets (see toSummaries in mcp/ticketTools.ts) — so that the summary
 * a tool emits can be built from these alone, and the native path's output is
 * unchanged by the existence of this type.
 */
export interface NormalizedTicket {
  provider: TicketProviderKind;
  /**
   * The handle a follow-up tool call passes back — get_ticket(id),
   * list_comments(ticketId). Native: the internal ticket id ("wi-a3f9k2m").
   * Jira: the local ticket_refs id ("tref-a3f9k2m"), NOT the issue key.
   *
   * Both are minted by lib/ids.ts with distinct prefixes, and that is what
   * makes provider dispatch on a bare id possible without a lookup: the tools
   * can tell which provider a ref belongs to by reading it. It is also why a
   * Jira ref is the tref id rather than "ENG-4" — an issue key is a human
   * identifier, ambiguous with a native one by construction (both are
   * PROJECT-NUMBER, see tickets.service.ts's identifier minting), and using it
   * as a ref would re-introduce at every call site the ambiguity that
   * get_ticket_by_identifier exists to resolve once.
   */
  ref: string;
  identifier: string;
  title: string;
  /** Native: the project id. Jira: the project key. Both are what the
   *  provider's own other calls would accept to scope by. */
  projectId: string;
  stateId: string;
  stateName: string;
  /**
   * The native state_group vocabulary ('backlog' | 'unstarted' | 'started' |
   * 'completed' | 'cancelled', see db/schema/projects.ts). Jira statuses map
   * onto it through their status category, which is the one part of Jira's
   * per-site-configurable workflow that IS a fixed vocabulary — so "is this
   * done?" is answerable across providers without the caller knowing one
   * site's status names.
   *
   * Undefined, not null, when unresolvable: it matches what the native path
   * already emitted for an unknown state (a Map miss yields undefined, which
   * JSON.stringify drops), and changing that to null would change the shape
   * of an existing result.
   */
  stateGroup: string | undefined;
  priority: string;
  /** ISO date (YYYY-MM-DD) or null. */
  dueDate: string | null;
  assigneeIds: string[];
  /** Positionally paired with assigneeIds; falls back to the raw id. */
  assigneeNames: string[];
  /** A link a human can open. Null for native tickets, which have no
   *  addressable web URL from this process's point of view. */
  url: string | null;
  /**
   * The full, provider-shaped record for the single-item detail path.
   *
   * Deliberately opaque and deliberately optional. Opaque, because "full
   * detail" is the part that genuinely differs — a native ticket carries
   * sprint/workstream/estimate/labels/links, a Jira issue carries issue type
   * and reporter, and flattening both into one exhaustive interface would
   * invent fields that are null for everyone. Optional, because the list and
   * search paths must NOT populate it: dropping description and the rest at
   * list time is a deliberate context-budget decision that predates this seam
   * (see toSummaries), and a provider that filled this in on a 50-row search
   * would quietly undo it.
   */
  detail?: Record<string, unknown>;
}

export interface NormalizedComment {
  id: string;
  /** The ref the caller passed in, echoed back — so a comment is traceable to
   *  the ticket handle the model already holds, not to a provider-internal id
   *  it has never seen. */
  ticketId: string;
  authorId: string;
  authorName: string;
  /** Native: the stored comment HTML. Jira: ADF flattened to plain text. */
  body: string;
  /** Which of those `body` is, so nothing downstream has to guess whether it
   *  is looking at markup. */
  bodyFormat: 'html' | 'text';
  /** ISO 8601. */
  createdAt: string;
}

export interface SearchOptions {
  /** Native: a project id. Jira: a project key. */
  projectId?: string;
  /**
   * Passed straight through to the underlying query. Callers hand this the
   * already-incremented "limit + 1" the tool layer uses to detect truncation
   * (see page() in mcp/ticketTools.ts), so the provider must not silently
   * clamp or reinterpret it.
   */
  limit: number;
}

/**
 * A source of tickets.
 *
 * `null` from a lookup means one specific thing — the provider ASKED and the
 * ticket is definitively not there. It never means "the lookup failed". That
 * distinction is load-bearing rather than pedantic: get_ticket_by_identifier
 * concludes an identifier must be native-only from a Jira null, so a provider
 * that returned null for a timeout would make it assert a falsehood the
 * moment Jira had a bad minute. Providers that cannot answer throw
 * ProviderUnavailableError instead.
 */
export interface TicketProvider {
  kind: TicketProviderKind;
  getByRef(ref: string, options?: { limit?: number }): Promise<NormalizedTicket | null>;
  getByIdentifier(identifier: string): Promise<NormalizedTicket | null>;
  search(query: string, options: SearchOptions): Promise<NormalizedTicket[]>;
  listComments(ref: string, limit: number): Promise<NormalizedComment[]>;
}

/**
 * "I could not find out", as distinct from "there is nothing there".
 *
 * Carries a message written for the model rather than for a log: it reaches
 * the model as a tool error, and the useful version of that error tells it
 * whether to retry, rephrase, or give up. Everything a provider knows about
 * which of those applies is known at the point of failure and nowhere else.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
