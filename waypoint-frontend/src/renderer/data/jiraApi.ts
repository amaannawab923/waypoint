// The one integration point between "My Jira" UI code and its data — same
// contract as data/api.ts (see that file's own header comment for the tone
// this mirrors). Every export here is an async function; UI code never
// reaches past them.
//
// This file used to be backed by in-memory fixtures. It is now backed by a
// real Jira Cloud site, reached over IPC through window.electron.jira (see
// main/jira/). Every function below performs, or reads the result of, a real
// authenticated REST call against whichever site the user connected.
//
// Why IPC and not fetch() from here: the credential is an Atlassian API
// token — a bearer credential for the user's entire Jira account. It is held,
// encrypted, in the main process and never enters the renderer (see
// main/jira/jiraAuth.ts). That also means this file cannot "just call Jira";
// it can only ask main to, which is the point.
//
// The seam is what made the swap containable: the function signatures below
// are the same ones every Jira component already imports, so replacing
// fixtures with a real site touched this file and nothing about how
// JiraTicketRow or JiraTicketDrawer ask for data.

import { JiraApiError } from '@/types/jira';
import type {
  JiraComment,
  JiraConnectionStatus,
  JiraDuplicateNudge,
  JiraProposal,
  JiraTicket,
  JiraTransition,
} from '@/types/jira';
import type { Priority } from '@/types/entities';
// A type-only reach into the main process, the same crossing preload.d.ts
// already makes for the bridge as a whole: these describe the shapes coming
// back over IPC, and restating them here would just be a second copy to keep
// in sync. Nothing at runtime is imported from src/main.
import type {
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
} from '../../main/jira/jiraTypes';

// -----------------------------------------------------------------------
// The bridge
// -----------------------------------------------------------------------

/**
 * Structurally identical to main/jira/jiraTypes.ts's JiraResult, restated
 * here rather than imported: the renderer does not import from src/main
 * (only preload.d.ts crosses that line, and only for the bridge's own type),
 * and `reason` widened to `string` is all this side needs — nothing here
 * switches on the exact union, it just carries the kind through.
 */
type IpcResult<T> =
  { ok: true; value: T } | { ok: false; reason: string; message: string };

function bridge() {
  const api = window.electron?.jira;
  if (!api) {
    // Only reachable outside a real Electron window (a bare browser, a test
    // that forgot to stub). Saying so beats "cannot read property of
    // undefined" three frames deeper.
    throw new Error('The Jira connection is unavailable in this window.');
  }
  return api;
}

/**
 * Main answers with a discriminated union; this layer's callers (and the
 * components above them) are all written around try/catch and
 * showErrorToast, exactly like data/api.ts's HTTP layer. Converting once here
 * keeps that one convention rather than introducing a second error style
 * halfway up the tree — and Jira's own message is preserved verbatim, since
 * "Resolution is required" is far more useful than "the move failed".
 *
 * `reason` rides along on the thrown error (see `JiraApiError` in
 * types/jira.ts) rather than being dropped. It used to be discarded here,
 * which is how a dead token and a slow network arrived at the UI
 * indistinguishable from each other — and, because the read paths ignored
 * the failure entirely, indistinguishable from an empty queue.
 */
function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new JiraApiError(result.message, result.reason);
}

// -----------------------------------------------------------------------
// Wire → UI mapping
// -----------------------------------------------------------------------

// Jira groups every status on every workflow into exactly three categories
// (`statusCategory.key`). Status *names* are per-workflow and unbounded, so
// the category is the only thing that can be colored consistently across
// sites. The cost is real and worth naming: "In Progress" and "In Review" are
// both `indeterminate` in Jira's eyes and therefore share a color here, where
// the fixture data gave them two. Inventing a distinction Jira doesn't make
// would mean guessing from status names, which is exactly the guesswork the
// category exists to avoid.
const STATE_COLOR: Record<string, string> = {
  todo: 'var(--text-muted)',
  'in-progress': 'var(--warning)',
  done: 'var(--success)',
};

function stateColor(category: string): string {
  return STATE_COLOR[category] ?? 'var(--text-muted)';
}

function toTransition(wire: JiraWireTransition): JiraTransition {
  return {
    id: wire.id,
    targetStateName: wire.targetStateName,
    targetStateColor: stateColor(wire.targetStateCategory),
    requiresFields: wire.requiresFields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.options ? { options: field.options } : {}),
      ...(field.hint ? { hint: field.hint } : {}),
    })),
  };
}

function toTicket(wire: JiraWireTicket): JiraTicket {
  return {
    id: wire.id,
    key: wire.key,
    projectKey: wire.projectKey,
    title: wire.title,
    role: wire.role,
    stateName: wire.stateName,
    stateColor: stateColor(wire.stateCategory),
    priority: wire.priority as Priority,
    priorityId: wire.priorityId,
    priorityName: wire.priorityName,
    assigneeName: wire.assigneeName,
    reporterName: wire.reporterName,
    description: wire.description,
    epicName: wire.epicName,
    storyPoints: wire.storyPoints,
    sprintName: wire.sprintName,
    attachments: wire.attachments,
    // Both of these describe drift between what this app last read and what
    // Jira holds now — a tombstone is "this was reassigned away from you", a
    // conflict is "someone else moved it while you were looking". Detecting
    // either needs a persisted previous read to compare against, which this
    // phase has no store for, so nothing fabricates one: no ticket is ever
    // marked tombstoned or conflicted, and the strips that render them simply
    // never appear. The components stay, ready for the phase that adds the
    // comparison.
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
  };
}

function toComment(wire: JiraWireComment): JiraComment {
  return {
    id: wire.id,
    ticketId: wire.ticketId,
    authorName: wire.authorName,
    body: wire.body,
    createdAt: wire.createdAt,
    // Jira has no concept of "this comment came from Waypoint" — there's no
    // property on a comment to carry it and this app doesn't keep its own
    // record of what it posted. A comment read back from Jira is therefore
    // just a comment, whoever typed it.
    postedByWaypoint: false,
    disclosureText: null,
  };
}

// -----------------------------------------------------------------------
// Session cache
// -----------------------------------------------------------------------

// Not a general client cache (data/api.ts has no such thing and this isn't
// the place to introduce one) — three specific pieces of state that would
// otherwise force redundant network calls:
//
//  - `lastTickets` backs getJiraConnectionStatus()'s issue/project counts, so
//    the Connection tab and the wizard's confirm step can show real numbers
//    without every status read re-running the JQL search.
//  - `transitionsByTicketId` holds whatever the bulk search returned, so
//    opening a transition menu is usually free.
//  - `lastSyncAt` is genuinely "when the list was last read", which is what
//    the page's "synced Ns ago" indicator claims to show. It starts `null`
//    and is only ever written by `rememberTickets`, which runs after a
//    search has actually come back — so a failed read never advances it and
//    a session with no successful read has no sync time at all. It used to
//    be seeded with `new Date()` at module load, which meant an app that had
//    never reached Jira still rendered a pulsing "synced 0s ago".
let lastTickets: JiraTicket[] = [];
let transitionsByTicketId = new Map<string, JiraTransition[]>();
let lastSyncAt: string | null = null;

function rememberTickets(wire: JiraWireTicket[]): JiraTicket[] {
  const tickets = wire.map(toTicket);
  // Only tickets whose transitions actually came back are remembered. An
  // empty transitions array from the bulk search is ambiguous — it means
  // either "this issue has no legal moves" or "the bulk expand didn't
  // populate them" — and caching the ambiguity would show a user an empty
  // transition menu on a ticket they can plainly move. Storing nothing
  // instead makes getJiraTransitions() fall through to the per-issue
  // endpoint, which is unambiguous.
  transitionsByTicketId = new Map(
    wire
      .filter((item) => item.transitions.length > 0)
      .map((item) => [item.id, item.transitions.map(toTransition)]),
  );
  lastTickets = tickets;
  lastSyncAt = new Date().toISOString();
  return tickets;
}

function clearCache(): void {
  lastTickets = [];
  transitionsByTicketId = new Map();
}

// -----------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------

/**
 * A purely local read — main answers from the encrypted credential file
 * without touching the network, because the sidebar and the My Jira page both
 * ask on every mount. The counts come from the last actual ticket read
 * (zero until one happens), which is why connectJira() and refreshJiraSync()
 * both list before returning a status.
 */
export async function getJiraConnectionStatus(): Promise<JiraConnectionStatus> {
  const snapshot = await bridge().status();
  return {
    connected: snapshot.connected,
    accountName: snapshot.identity?.displayName ?? '',
    accountEmail: snapshot.identity?.email ?? '',
    site: snapshot.identity?.site ?? '',
    lastSyncAt,
    issueCount: lastTickets.length,
    projectCount: new Set(lastTickets.map((t) => t.projectKey)).size,
  };
}

export async function listMyJiraTickets(): Promise<JiraTicket[]> {
  const wire = unwrap(await bridge().listTickets());
  return rememberTickets(wire);
}

/**
 * The transition menu's data, with the fallback that makes it trustworthy.
 *
 * The bulk search asks for transitions inline, and when that works this
 * returns without a round trip. But an empty result there cannot be believed
 * — see rememberTickets — so anything not positively known is asked for
 * per-issue instead. The alternative (trusting the bulk expand) would fail
 * silently and in exactly the worst way: a ticket that renders "No
 * transitions available from here" when the user's Jira plainly offers three.
 */
export async function getJiraTransitions(
  ticketId: string,
): Promise<JiraTransition[]> {
  const cached = transitionsByTicketId.get(ticketId);
  if (cached && cached.length > 0) return cached;
  const wire = unwrap(await bridge().listTransitions(ticketId));
  const transitions = wire.map(toTransition);
  if (transitions.length > 0) transitionsByTicketId.set(ticketId, transitions);
  return transitions;
}

export async function listJiraComments(
  ticketId: string,
): Promise<JiraComment[]> {
  const wire = unwrap(await bridge().listComments(ticketId));
  return wire.map(toComment);
}

// The Copilot rail's proposal and its "Also queued" duplicate nudge. Both
// return nothing, always.
//
// Until this file talked to a real site, these returned a hand-written
// ENG-421 proposal from the design mockup. Against a live Jira that fixture
// is a fabrication: it names an issue the user does not have, and its Approve
// button would report a state move and a posted comment that never reached
// Jira at all. Generating one for real needs a Copilot→Jira pipeline that
// does not exist yet, so nothing is returned rather than something invented —
// MyJiraPage renders no rail at all when both are empty. JiraProposalCard and
// the nudge markup are left in place for the phase that builds the pipeline.
export async function getMyJiraProposal(): Promise<JiraProposal | undefined> {
  return undefined;
}

export async function getJiraDuplicateNudge(): Promise<
  JiraDuplicateNudge | undefined
> {
  return undefined;
}

// -----------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------

/**
 * Validates the credentials against the user's real site and, only if Jira
 * accepts them, stores them encrypted in the main process.
 *
 * The immediate follow-up list() is not incidental: it makes the wizard's
 * confirm step show this account's actual issue and project counts rather
 * than zeros, and it proves the connection can do the one thing it exists to
 * do before the wizard claims success.
 */
export async function connectJira(credentials: {
  site: string;
  email: string;
  apiToken: string;
}): Promise<JiraConnectionStatus> {
  unwrap(await bridge().connect(credentials));
  await listMyJiraTickets();
  return getJiraConnectionStatus();
}

export async function disconnectJira(): Promise<void> {
  await bridge().disconnect();
  clearCache();
}

/** Connection tab's "Refresh now" — a genuine re-read of the JQL search. */
export async function refreshJiraSync(): Promise<JiraConnectionStatus> {
  await listMyJiraTickets();
  return getJiraConnectionStatus();
}

/**
 * Moves a real issue. Main re-reads the transition's live field metadata
 * before writing (so a select's chosen label resolves to whatever id this
 * site uses for it) and re-reads the issue afterwards, so what comes back is
 * the state Jira actually landed on rather than the one the UI predicted.
 */
export async function transitionJiraTicket(
  ticketId: string,
  transitionId: string,
  fieldValues: Record<string, string>,
): Promise<JiraTicket> {
  const wire = unwrap(
    await bridge().transition({ ticketId, transitionId, fieldValues }),
  );
  const ticket = toTicket(wire);
  lastTickets = lastTickets.map((t) => (t.id === ticket.id ? ticket : t));
  // The move changes which transitions are legal from here, so the cached set
  // for this ticket is now wrong — drop it and let the next menu open ask.
  transitionsByTicketId.delete(ticketId);
  return ticket;
}

/**
 * Posts a plain-text comment as the connected user.
 *
 * Plain text is the whole contract: an "@Name" typed into the body stays
 * literal characters and notifies nobody, which is why the composer no longer
 * offers a mention picker (see types/jira.ts).
 */
export async function postJiraComment(
  ticketId: string,
  body: string,
): Promise<JiraComment> {
  return toComment(unwrap(await bridge().postComment({ ticketId, body })));
}

// Approve/reject for the Copilot rail's proposal. Unreachable in this phase —
// nothing ever produces a proposal for the card to render (see
// getMyJiraProposal above) — and deliberately left throwing rather than
// re-implemented against fixtures: a Jira write attributed to an approval
// this app cannot actually perform is the one outcome worth being loud about
// if the pipeline is ever wired up before these are.
export async function approveJiraProposal(id: string): Promise<JiraProposal> {
  throw new Error(
    `Approving a Copilot proposal against Jira isn't built yet (${id}).`,
  );
}

export async function rejectJiraProposal(id: string): Promise<JiraProposal> {
  throw new Error(
    `Rejecting a Copilot proposal against Jira isn't built yet (${id}).`,
  );
}

// dismissJiraTombstone / resolveJiraConflict — MyJiraPage still wires both to
// their rows, but no ticket is ever marked tombstoned or conflicted (see
// toTicket), so neither strip renders and neither is reachable. Kept as the
// callbacks those components' props require, doing the only honest thing
// available: dropping the row locally, and re-reading the issue from Jira.
export async function dismissJiraTombstone(ticketId: string): Promise<void> {
  lastTickets = lastTickets.filter((t) => t.id !== ticketId);
}

export async function resolveJiraConflict(
  ticketId: string,
): Promise<JiraTicket> {
  const tickets = await listMyJiraTickets();
  const found = tickets.find((t) => t.id === ticketId);
  if (!found) throw new Error('That issue is no longer in your queue.');
  return found;
}

// The id is still taken — it is the shape MyJiraPage's rail calls with, and
// narrowing it would be churn for a function that exists only to satisfy that
// contract until the proposal pipeline is built.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function dismissJiraDuplicateNudge(id: string): Promise<void> {
  // No nudge is ever produced, so there is nothing to dismiss.
}
