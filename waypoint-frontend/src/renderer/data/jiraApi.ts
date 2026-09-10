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
  JiraAttachment,
  JiraSubtask,
  JiraIssueLink,
  JiraComment,
  JiraConflictInfo,
  JiraConnectionStatus,
  JiraPriorityOption,
  JiraTicket,
  JiraTransition,
  JiraUserOption,
} from '@/types/jira';
import type { Priority } from '@/types/entities';
// A type-only reach into the main process, the same crossing preload.d.ts
// already makes for the bridge as a whole: these describe the shapes coming
// back over IPC, and restating them here would just be a second copy to keep
// in sync. Nothing at runtime is imported from src/main.
import type {
  JiraAdfAnyMark,
  JiraAdfBlockNode,
  JiraAdfInlineNode,
  JiraCommentBody,
  JiraPriorityOption as JiraWirePriorityOption,
  JiraTruncation,
  JiraWireAttachment,
  JiraWireSubtask,
  JiraWireIssueLink,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
  JiraWireUser,
} from '../../main/jira/jiraTypes';
// `JiraCommentPermissions` lives in jiraClient.ts rather than jiraTypes.ts
// alongside the rest of the wire shapes above (it's the mapped answer from
// `/rest/api/3/mypermissions`, not a piece of the issue/comment payload) —
// same file preload.ts's own ElectronHandler type already reaches into for
// this exact type. Renamed on import for the same reason every other wire
// import above keeps main's shapes from leaking past this file: `toComment`
// -> `JiraComment`, and here `JiraWireCommentPermissions` -> the renderer's
// own `JiraCommentPermissions` below.
import type { JiraCommentPermissions as JiraWireCommentPermissions } from '../../main/jira/jiraClient';

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

/** Nothing to translate — a priority option is an id and the site's own
 * label on both sides of the wire, with no presentation to derive (unlike a
 * transition, whose target state category becomes a CSS variable here). The
 * mapping exists anyway so the renderer's own type is what leaves this
 * module, keeping main's shapes from leaking past this file. */
function toPriorityOption(wire: JiraWirePriorityOption): JiraPriorityOption {
  return { id: wire.id, name: wire.name };
}

/**
 * Same story as toPriorityOption — nothing to translate, but main's shapes stop
 * at this file.
 *
 * Written out field by field rather than passed through wholesale, which is the
 * point: the wire shape deliberately carries no URL for the file (see
 * `JiraWireAttachment`), and an explicit mapping is what keeps that true if the
 * wire shape ever grows one. A download is addressed by `id` and performed
 * entirely in main.
 */
/** ROAD-41 contract: wire subtask -> renderer subtask. */
function toSubtask(wire: JiraWireSubtask): JiraSubtask {
  return {
    id: wire.id,
    key: wire.key,
    title: wire.title,
    stateName: wire.stateName,
    stateColor: stateColor(wire.stateCategory),
  };
}

/** ROAD-41 contract: wire issue link -> renderer issue link. */
function toIssueLink(wire: JiraWireIssueLink): JiraIssueLink {
  return {
    id: wire.id,
    relation: wire.relation,
    key: wire.key,
    title: wire.title,
    stateName: wire.stateName,
    stateColor: stateColor(wire.stateCategory),
  };
}

function toAttachment(wire: JiraWireAttachment): JiraAttachment {
  return {
    id: wire.id,
    fileName: wire.fileName,
    sizeLabel: wire.sizeLabel,
    sizeBytes: wire.sizeBytes,
    mimeType: wire.mimeType,
    uploaderName: wire.uploaderName,
  };
}

/** Same story as toPriorityOption — nothing to translate, but main's shapes
 * stop at this file. */
function toUserOption(wire: JiraWireUser): JiraUserOption {
  return {
    accountId: wire.accountId,
    displayName: wire.displayName,
    avatarUrl: wire.avatarUrl,
  };
}

/** Same story as toPriorityOption — nothing to translate, but main's shapes
 * stop at this file. */
function toCommentPermissions(
  wire: JiraWireCommentPermissions,
): JiraCommentPermissions {
  return {
    deleteAll: wire.deleteAll,
    deleteOwn: wire.deleteOwn,
    editAll: wire.editAll,
    editOwn: wire.editOwn,
  };
}

/**
 * Whether `wire` looks like it drifted since `previous` — the same ticket,
 * last mapped from an earlier real read, or `undefined` when this is the
 * first time this module has ever seen the id (nothing to compare against,
 * so nothing to flag: a ticket new to the queue is not "changed under you").
 *
 * The signal is Jira's own `updated` timestamp, and only that. It is the one
 * field that moves whenever ANY field on the issue does, so it is the
 * cheapest true thing to compare — the alternative, diffing every field this
 * app reads (title, description, priority, assignee, ...), would both cost
 * more and still miss a field this app doesn't happen to read.
 *
 * `updatedAt` is nullable on both sides (Jira can omit `updated`, and a
 * fabricated stand-in was deliberately removed — see JiraTicket.updatedAt's
 * own comment). Either side being null means "unknown", and unknown must
 * resolve to "no conflict" rather than either extreme: it is not proof
 * nothing changed, but it is even less a case for accusing the ticket of
 * drift it cannot be shown to have. A conflict strip that fires on missing
 * data is exactly the kind of false positive that gets a safety feature
 * turned off — see this file's own note by the isTombstoned/hasConflict
 * fields below on the same principle applied to tombstoning.
 */
function detectConflict(
  wire: JiraWireTicket,
  previous: JiraTicket | undefined,
): JiraConflictInfo | null {
  if (!previous) return null;
  if (previous.updatedAt === null || wire.updatedAt === null) return null;
  if (previous.updatedAt === wire.updatedAt) return null;
  return {
    // Jira's issue payload carries no "who last touched this" — that lives
    // in the changelog, a separate endpoint this client does not read (see
    // JiraWireTicket.updatedAt: only the timestamp crosses the wire). Naming
    // a person here would mean guessing, which is exactly what got `updated`
    // itself de-fabricated elsewhere in this file. "Someone" says plainly
    // that the identity is unknown rather than inventing one that reads as
    // authoritative.
    changedBy: 'Someone',
    changedAt: wire.updatedAt,
  };
}

/**
 * `previous` is the same ticket as last mapped from a real read, when the
 * caller has one to offer — see detectConflict just above for what it's
 * used for and why a missing one is never treated as a conflict.
 *
 * Every write in this file below (transitionJiraTicket, setJiraTicketPriority,
 * setJiraTicketAssignee, uploadJiraAttachment) calls this with ONE argument,
 * deliberately: the wire ticket a write just got back is this module's own
 * new "last known truth", not a rival value to compare against the stale
 * pre-write cache. Passing it through detectConflict there would compare
 * this module's own action against itself — the ticket's `updated` moved
 * because Waypoint just moved it — and flag the user's own transition,
 * priority change, reassignment or attachment upload as someone else's
 * conflicting edit. That is the false positive that would make the whole
 * feature intolerable (see the header note above isTombstoned/hasConflict).
 * Only rememberTickets, which backs a genuine queue re-read and never a
 * write's own response, passes a `previous` and gets a real comparison.
 */
function toTicket(wire: JiraWireTicket, previous?: JiraTicket): JiraTicket {
  const conflict = detectConflict(wire, previous);
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
    assigneeAccountId: wire.assigneeAccountId,
    reporterName: wire.reporterName,
    description: wire.description,
    epicName: wire.epicName,
    storyPoints: wire.storyPoints,
    sprintName: wire.sprintName,
    updatedAt: wire.updatedAt,
    // ROAD-41 contract - see jiraMap.ts's matching note.
    labels: wire.labels,
    dueDate: wire.dueDate,
    subtasks: wire.subtasks.map(toSubtask),
    links: wire.links.map(toIssueLink),
    descriptionAdf: wire.descriptionAdf,
    attachments: wire.attachments.map(toAttachment),
    // Both of these describe drift between what this app last read and what
    // Jira holds now. `conflict` is genuinely detected — see detectConflict
    // above — from `previous`, the same ticket as last mapped from a real
    // queue read (rememberTickets is the only caller that supplies one).
    //
    // `isTombstoned` stays false, unconditionally, and that is a deliberate
    // decision rather than an unfinished one. A tombstone claims something
    // specific — "this was reassigned away from you" — and the only signal
    // available for it is a ticket's id disappearing from one queue read to
    // the next. That absence is genuinely ambiguous: the "my work" JQL drops
    // an issue on reassignment, but also on resolution (the query matches
    // assignee/reporter/watcher AND resolution — see setJiraTicketPriority's
    // own note), and a page-cap-truncated read (see JiraTruncation) can make
    // an untouched issue vanish for a reason that has nothing to do with the
    // issue at all. Nothing this module reads distinguishes those cases, and
    // guessing "reassigned" for what might be "resolved" or "just fell past
    // the crawl cap" is worse than the strip never appearing — a false "this
    // was taken from you" erodes trust the same way a false conflict would.
    // If a later phase adds a way to tell those apart (an id lookup after a
    // ticket goes missing, say), this is where it would plug in.
    isTombstoned: false,
    tombstone: null,
    hasConflict: conflict !== null,
    conflict,
  };
}

function toComment(wire: JiraWireComment): JiraComment {
  return {
    id: wire.id,
    ticketId: wire.ticketId,
    authorName: wire.authorName,
    authorAccountId: wire.authorAccountId,
    updatedAt: wire.updatedAt,
    updateAuthorName: wire.updateAuthorName,
    body: wire.body,
    createdAt: wire.createdAt,
    // Straight off the wire, deliberately never off what a write asked for —
    // see JiraComment.parentId's own comment. `postJiraComment` below builds
    // this from the SAME toComment(unwrap(...)) path every read uses, so a
    // reply's own return value already tells the truth about whether Jira
    // actually nested it, with no separate code path that could disagree.
    // `?? null`, not a bare pass-through: main's own mapComment never sends
    // `undefined` (it already coerces a missing key to null — see
    // JiraWireComment.parentId), but this field feeds directly into
    // groupCommentsIntoThreads' `!current.parentId` check, where `undefined`
    // and `null` behave identically anyway — this just keeps the type this
    // module promises (`string | null`) true rather than trusting the wire.
    parentId: wire.parentId ?? null,
    // Jira has no concept of "this comment came from Waypoint" — there's no
    // property on a comment to carry it and this app doesn't keep its own
    // record of what it posted. A comment read back from Jira is therefore
    // just a comment, whoever typed it.
    postedByWaypoint: false,
    disclosureText: null,
    // Straight off the wire, same as descriptionAdf on toTicket above — see
    // JiraComment.bodyAdf's own comment for what reads this.
    bodyAdf: wire.bodyAdf,
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
//  - `lastReadTruncated` travels with `lastTickets` because the counts built
//    from that array are only as complete as the read that filled it. It is
//    set by the same function that sets the array, so the two cannot drift.
let lastReadTruncated: JiraTruncation = false;
//  - `listInFlight` dedupes genuinely CONCURRENT callers of
//    listMyJiraTickets() into the one real network call already running —
//    found in review: MyJiraPage's own foreground read and
//    ensureJiraSynced's background one (below) could both land within the
//    same tick on a fresh mount (Sidebar + MyJiraPage together), each
//    calling listMyJiraTickets() directly, invisible to each other. This is
//    intentionally NOT the same thing as "skip a read because one already
//    happened this session" — that's lastSyncAt's job, checked separately
//    below — so a later, genuinely distinct call (a real "Refresh now"
//    click after the first read has already settled) still fires its own
//    fresh request rather than being silently deduped away.
let listInFlight: Promise<JiraQueueRead> | null = null;

function rememberTickets(
  wire: JiraWireTicket[],
  truncated: JiraTruncation,
): JiraTicket[] {
  // The baseline detectConflict compares against: whatever this module had
  // cached for each id BEFORE this read overwrites it below. Read this off
  // the OLD `lastTickets`, not the new `wire` array — captured up front,
  // since `lastTickets` is reassigned at the end of this function and a
  // lookup built after that point would just compare the new read against
  // itself.
  const previousById = new Map(lastTickets.map((t) => [t.id, t]));
  const tickets = wire.map((item) => toTicket(item, previousById.get(item.id)));
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
  lastReadTruncated = truncated;
  lastSyncAt = new Date().toISOString();
  return tickets;
}

function clearCache(): void {
  lastTickets = [];
  lastReadTruncated = false;
  // Cleared with the rest of it. The header above states that a session with
  // no successful read has no sync time at all; leaving this behind made
  // that false the moment anyone disconnected, and the Connection tab went
  // on reporting a real past sync for an account it was no longer connected
  // to — a "synced 3m ago" over zero issues and no credential.
  lastSyncAt = null;
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
 * both list before returning a status — and why every OTHER mount point that
 * shows these counts (the sidebar, JiraConnectionCard on All Projects)
 * should route through ensureJiraSynced() below rather than calling this
 * function alone: on its own, this one can legitimately return real
 * `connected: true` next to zero counts for an arbitrarily long time,
 * because nothing about calling it makes a real read happen.
 */
export async function getJiraConnectionStatus(): Promise<JiraConnectionStatus> {
  const snapshot = await bridge().status();
  return {
    connected: snapshot.connected,
    accountName: snapshot.identity?.displayName ?? '',
    accountEmail: snapshot.identity?.email ?? '',
    accountId: snapshot.identity?.accountId ?? '',
    site: snapshot.identity?.site ?? '',
    lastSyncAt,
    issueCount: lastTickets.length,
    projectCount: new Set(lastTickets.map((t) => t.projectKey)).size,
    // Coerced, and correctly so: the counts are floors whenever the read was
    // incomplete, whichever way it was incomplete. This one genuinely is a
    // yes/no question, unlike the banner copy, which has to name a cause.
    countsTruncated: Boolean(lastReadTruncated),
  };
}

/**
 * One read of the "my work" query: the tickets, and whether the page cap cut
 * them short.
 *
 * Returned as a pair rather than a bare array so no caller can render a count
 * without also having the fact that makes the count possibly a floor. The
 * obvious alternative — keep `listMyJiraTickets(): Promise<JiraTicket[]>` and
 * add a second `listMyJiraQueue()` beside it — was rejected precisely because
 * the lossy one would stay the convenient one: every new caller would reach
 * for the array, and the "we only got the first 500" fact would go missing
 * again one call site at a time. There is one function, and its type makes
 * the caveat impossible to not receive.
 */

export interface JiraQueueRead {
  tickets: JiraTicket[];
  /** Falsy when this is the whole queue; otherwise WHY it is not — see
   *  JiraTruncation, whose two cases need different words on screen. */
  truncated: JiraTruncation;
}

export async function listMyJiraTickets(): Promise<JiraQueueRead> {
  // See listInFlight's own comment above: sharing this promise across every
  // genuinely concurrent caller (MyJiraPage's own foreground read,
  // ensureJiraSynced's background one below, and each other) is what keeps
  // two surfaces mounting in the same tick from firing two real searches —
  // this is the ONE place that dedup can live where it covers every caller,
  // direct or via ensureJiraSynced, without either of them needing to know
  // about the other.
  if (listInFlight) return listInFlight;
  listInFlight = (async () => {
    const { tickets, truncated } = unwrap(await bridge().listTickets());
    return { tickets: rememberTickets(tickets, truncated), truncated };
  })();
  try {
    return await listInFlight;
  } finally {
    listInFlight = null;
  }
}

/**
 * Guarantees at least one real ticket read has happened this session before
 * resolving with a status whose counts can be trusted — a no-op the moment
 * `lastSyncAt` is already set (whichever caller gets there first, including
 * MyJiraPage's own "My work" read, satisfies every other caller too).
 * Concurrent callers (this function or listMyJiraTickets() called directly)
 * are deduplicated inside listMyJiraTickets() itself via listInFlight, not
 * here — found in review: an earlier version of this function had its own,
 * separate single-flight guard, which covered concurrent calls to
 * ensureJiraSynced but NOT a concurrent direct call to listMyJiraTickets()
 * (exactly what MyJiraPage's own foreground read is), so the two most
 * common real-world concurrent callers could still both fire a real search.
 *
 * Found in review: a connected account with real tickets showed "0 issues" /
 * "not synced yet" on the All Projects page's Jira tile indefinitely,
 * because that tile calls useLoadedJiraConnection — which only ever called
 * the cheap, count-blind getJiraConnectionStatus() above — and nothing about
 * landing on All Projects first (rather than My Jira) ever triggered a real
 * read. MyJiraPage's own fetchedRead effect already re-pushes a fresh
 * status once ITS OWN read lands, which is why this was harder to notice
 * from My Jira itself; the tile has no read of its own to piggyback on.
 *
 * Does not attempt a read at all when nothing is connected — bridge().status()
 * already answers that for free, and a connect-less account has nothing a
 * search would find. A failed read resolves with the pre-read (still
 * accurate) connected/site/etc. status rather than rejecting — this is a
 * best-effort background sync, not the user-facing "My work" read that
 * already has its own error UI (JiraLoadError in MyJiraPage.tsx) — but the
 * failure is not silently discarded: it's logged, so a real connectivity
 * problem is at least discoverable instead of looking identical to "just
 * hasn't synced yet" with no trace anywhere.
 */
export async function ensureJiraSynced(): Promise<JiraConnectionStatus> {
  if (lastSyncAt) return getJiraConnectionStatus();
  const status = await getJiraConnectionStatus();
  if (!status.connected) return status;
  try {
    await listMyJiraTickets();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[jira] background sync failed', err);
    return status;
  }
  return getJiraConnectionStatus();
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

/**
 * The priorities the connected site offers on this particular issue.
 *
 * Deliberately not cached the way transitions are. The transitions cache
 * exists because the bulk ticket search already returns them, so reusing that
 * saves a round trip that has genuinely already happened; nothing about a
 * priority scheme arrives that way, so a cache here would buy one saved
 * request in exchange for holding a list that a project's admin can change
 * underneath it. Main re-checks the chosen id against live metadata before
 * writing regardless (see setJiraTicketPriority), but the honest thing for a
 * menu is to show what is true when it opens.
 */
export async function getJiraPriorityOptions(
  ticketId: string,
): Promise<JiraPriorityOption[]> {
  const wire = unwrap(await bridge().listPriorityOptions(ticketId));
  return wire.map(toPriorityOption);
}

/**
 * The people the connected site will let this issue be assigned to, matching
 * what the user has typed.
 *
 * Takes the ticket's KEY, not its id — the one channel in this whole feature
 * that does, because Jira's assignable-user search is specified in terms of
 * `issueKey`. Callers hold a `JiraTicket` and pass `ticket.key`.
 *
 * Uncached, like the priority options and for a stronger version of the same
 * reason: the result depends on a query the user is still typing, and on a
 * project permission an admin can change. A blank query is a real call that
 * returns the first page of assignable users, which is what the picker opens
 * with.
 */
export async function searchJiraAssignableUsers(
  ticketKey: string,
  query: string,
): Promise<JiraUserOption[]> {
  const wire = unwrap(
    await bridge().searchAssignableUsers({ ticketKey, query }),
  );
  return wire.map(toUserOption);
}

/**
 * A comment read, carrying the fact that it may not be the whole thread.
 *
 * Same shape and the same reasoning as JiraQueueRead: returning the bare
 * array would make the lossy call the convenient one, and "we only got the
 * newest hundred" would go missing one call site at a time. There is one
 * function, and its type makes the caveat impossible to not receive.
 */
export interface JiraCommentRead {
  comments: JiraComment[];
  /** Every comment on the issue per Jira, which `comments` may be a tail
   *  of. Equal to `comments.length` when the thread is short. */
  total: number;
}

export async function listJiraComments(
  ticketId: string,
): Promise<JiraCommentRead> {
  const { comments, total } = unwrap(await bridge().listComments(ticketId));
  return { comments: comments.map(toComment), total };
}

/**
 * The project-level answer to "may I delete/edit my own comments" and "may I
 * delete/edit anyone's" on this issue — see jiraClient.ts's own
 * `getMyPermissions` for why this is project-level rather than a field on
 * the comment itself: Jira's comment payload carries no per-comment
 * permission hint, live-confirmed against the real API. Deciding whether one
 * particular comment's Delete button should render is this app's own job:
 * this answer, plus whether that comment's `authorAccountId` equals the
 * connected account's own (`JiraConnectionStatus.accountId`).
 *
 * `deleteAll` and `deleteOwn` are not mutually exclusive — the connected
 * account can hold both at once, which is the common shape for an admin
 * testing this feature against their own account. It is NOT the common
 * shape a real non-admin sees, so a caller gating "may I delete my own
 * comment" must check `deleteOwn` on its own rather than inferring it from
 * "not deleteAll".
 */
export interface JiraCommentPermissions {
  deleteAll: boolean;
  deleteOwn: boolean;
  editAll: boolean;
  editOwn: boolean;
}

/**
 * Uncached, like getJiraPriorityOptions and for the same reason: a
 * project's comment permission scheme is something an admin can change
 * underneath a long-lived session, and the honest thing for a destructive
 * action's own gate is to check what is true right when it might be used,
 * not what was true when the drawer first opened.
 */
export async function getJiraCommentPermissions(
  issueKey: string,
): Promise<JiraCommentPermissions> {
  const wire = unwrap(await bridge().getCommentPermissions(issueKey));
  return toCommentPermissions(wire);
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
 * Changes a real issue's priority.
 *
 * Main re-reads the issue's live edit metadata immediately before writing and
 * refuses a value the issue no longer accepts, then re-reads the whole issue
 * afterwards — the same shape as transitionJiraTicket, for the same reason:
 * what comes back is the state Jira landed on, not the one the UI predicted.
 *
 * The cached list is patched with `.map()`, never filtered. A priority change
 * cannot move a ticket out of the "my work" JQL (that query matches on
 * assignee/reporter/watcher and resolution, none of which this touches), so
 * there is no case where dropping the row would be right — and patching in
 * place is what keeps the row where the user's eye already is.
 */
export async function setJiraTicketPriority(
  ticketId: string,
  priorityId: string,
): Promise<JiraTicket> {
  const wire = unwrap(await bridge().setPriority({ ticketId, priorityId }));
  const ticket = toTicket(wire);
  lastTickets = lastTickets.map((t) => (t.id === ticket.id ? ticket : t));
  return ticket;
}

/**
 * Reassigns a real issue, or unassigns it when `accountId` is `null`.
 *
 * `null` is a value, not a missing argument, and it stays one the whole way
 * down: the picker's Unassign row sends it, the IPC handler checks for the
 * literal `null` before any string coercion (see jiraIpc.ts, where
 * `readString` would otherwise fold it into `''` and make it indistinguishable
 * from a field that was never sent), and Jira's assignee endpoint takes
 * `{ accountId: null }` as its own documented payload for "nobody".
 *
 * The cached list is patched with `.map()`, never filtered — and here that is
 * a decision rather than symmetry with the writes above it.
 *
 * Reassigning a ticket away from yourself genuinely can drop it out of the
 * "my work" JQL: that query matches on assignee OR reporter OR watcher, and if
 * you were only ever its assignee, you are no longer any of the three. The
 * temptation is to remove the row on that basis. The row must stay. A ticket
 * vanishing from under the cursor the instant a menu closes reads as data loss
 * even when it is technically correct, and the user has no way to confirm the
 * write they just made landed the way they meant.
 *
 * `.map()` is the whole mechanism for that, and no special case is needed to
 * get it: the ticket is patched in place with what Jira returned — new
 * assignee name, and a `role` that now honestly reads "not yours" (see
 * `roleOf` in main/jira/jiraMap.ts) — and it simply is not excluded from
 * anything until the next `listMyJiraTickets()` re-runs the query and does not
 * find it. Which is exactly "stays visible until the next refresh", falling
 * out of doing the ordinary thing. Nothing in this path may filter or remove.
 */
export async function setJiraTicketAssignee(
  ticketId: string,
  accountId: string | null,
): Promise<JiraTicket> {
  const wire = unwrap(await bridge().setAssignee({ ticketId, accountId }));
  const ticket = toTicket(wire);
  lastTickets = lastTickets.map((t) => (t.id === ticket.id ? ticket : t));
  return ticket;
}

/**
 * Saves one of an issue's attachments to disk.
 *
 * Not really a write to Jira at all — nothing about the issue changes — but it
 * lives among the writes because it is an action the user takes rather than
 * data this module reads, and because it is the one function here whose result
 * is a file on their machine.
 *
 * Note the signature: there is no `path` parameter, and none comes back. This
 * side cannot name a destination. It asks main to download an attachment and
 * let the user choose where it goes, and main owns the whole fetch → native
 * save dialog → write → reveal-in-Finder sequence inside a single handler.
 * That is the point of the design rather than an inconvenience of it: nothing
 * the renderer says can decide where bytes land, so there is nothing to
 * validate and nothing to get wrong. `fileName` is only the dialog's default
 * suggestion, and main sanitizes it before use — a Jira filename is chosen by
 * whoever uploaded it.
 *
 * A cancel comes back as `{ canceled: true }`, never as a thrown error. The
 * user closing a save dialog is a normal outcome and must not fire the error
 * toast every other failure here produces.
 */
export async function downloadJiraAttachment(
  ticketId: string,
  attachmentId: string,
  fileName: string,
): Promise<{ canceled: boolean }> {
  const result = unwrap(
    await bridge().downloadAttachment({ ticketId, attachmentId, fileName }),
  );
  return { canceled: result.canceled };
}

/**
 * Attaches a file to a real issue.
 *
 * Takes an issue id and nothing else — no filename, no path, no `File`. Main
 * opens a native file picker, reads what the user chose and uploads it, all
 * inside one handler. This side cannot name what gets read off the machine,
 * which is the security property the whole attachment design is built for and
 * the reason this signature looks so thin.
 *
 * A cancel is `{ canceled: true }` with no ticket, never a thrown error:
 * closing a file picker is a normal outcome and must not fire the error toast.
 *
 * On success the whole re-read ticket comes back and the cached list is
 * patched with `.map()`, matching every other write in this file. A
 * `.filter()` would be wrong here in the most obvious way — attaching a file
 * cannot remove an issue from anyone's queue — but the reason the map is worth
 * naming is what it carries: the ticket Jira returned, with the new attachment
 * on it and with Jira's own filename for it (a site can rename on collision),
 * rather than one this module assembled by assuming the upload did what it
 * asked for.
 */
export async function uploadJiraAttachment(
  ticketId: string,
): Promise<{ canceled: boolean; ticket: JiraTicket | null }> {
  const result = unwrap(await bridge().uploadAttachment({ ticketId }));
  if (result.canceled || !result.ticket) {
    return { canceled: true, ticket: null };
  }
  const ticket = toTicket(result.ticket);
  lastTickets = lastTickets.map((t) => (t.id === ticket.id ? ticket : t));
  return { canceled: false, ticket };
}

export interface JiraMentionSpan {
  /** Inclusive start offset into the composer's plain-text draft, in the
   * same UTF-16 code units a `<textarea>`'s `selectionStart` uses. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  accountId: string;
  /** The mention's own display name, used only to re-validate that the text
   * still reads "@" + this name at [start, end) before the span is trusted
   * — see `buildCommentAdf`. */
  displayName: string;
}

/**
 * Turns the composer's plain-text draft plus its tracked mention spans into
 * the ADF document Jira's comment-create endpoint needs.
 *
 * A `<textarea>` only ever holds flat text (see JiraCommentComposer.tsx's own
 * header comment on why this app uses one rather than a contentEditable
 * surface), so the composer tracks a mention as a span — start, end,
 * accountId, displayName — alongside the plain string rather than storing
 * anything richer. This is where that tracked span becomes a real `mention`
 * ADF node, which is what makes Jira actually notify that person, rather
 * than "@Display Name" typed as literal characters that notify nobody.
 *
 * A span the user has edited into since it was inserted — deleted a letter
 * inside "@Sam Lee", say — is dropped rather than posted as a broken mention:
 * the text at [start, end) is re-checked against "@" + displayName here, at
 * the one point that matters, right before it becomes a network request.
 * Whatever text is actually there today goes out as plain text instead.
 *
 * One `paragraph` node per line: ADF has no bare newline, so a `\n` the user
 * typed has to become a paragraph break to survive at all — the same
 * structure `adfToPlainText` (main/jira/jiraMap.ts) already reconstructs a
 * `\n` from on the read side.
 */
// -----------------------------------------------------------------------
// Comment body: a lightweight-markdown subset -> ADF
// -----------------------------------------------------------------------
//
// The composer's toolbar (JiraCommentComposer.tsx) wraps a selection in
// markdown-style delimiters -- **bold**, _em_, ~~strike~~, `code`,
// [text](url) -- and prefixes a line for block structure -- #/##/### for
// headings, "- "/"* " for a bullet item, "1. " for an ordered item, "> "
// for a quote, and a ``` fence for a code block. Everything below turns
// that plain-text-plus-syntax draft into the ADF Jira's comment-create
// endpoint needs, in the same spirit as `JiraMentionSpan` above: the
// textarea only ever holds flat text, so structure is recovered from it at
// the one point that matters, right before the comment is sent.
//
// This is not a Markdown implementation. It supports exactly the subset the
// toolbar can produce, not nesting (bold-and-italic-together isn't detected
// as one span), not escaping a literal delimiter character, and not a mark
// pair split across two lines (every inline pattern below excludes `\n`,
// since block structure -- including which lines merge into one list -- is
// resolved one line at a time before any inline parsing runs).

interface InlineRun {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  kind: 'strong' | 'em' | 'strike' | 'code' | 'link';
  href?: string;
  priority: number;
}

const INLINE_PATTERNS: {
  kind: InlineRun['kind'];
  re: RegExp;
  priority: number;
}[] = [
  { kind: 'code', re: /`([^`\n]+)`/g, priority: 0 },
  { kind: 'link', re: /\[([^\]\n]+)\]\(([^)\n]+)\)/g, priority: 1 },
  { kind: 'strong', re: /\*\*([^\n]+?)\*\*/g, priority: 2 },
  { kind: 'strike', re: /~~([^\n]+?)~~/g, priority: 3 },
  { kind: 'em', re: /_([^\n]+?)_/g, priority: 4 },
];

const INLINE_DELIM_LENGTH: Record<InlineRun['kind'], number> = {
  code: 1,
  strong: 2,
  strike: 2,
  em: 1,
  link: 0, // links are positioned from the match itself, not a symmetric delimiter
};

/**
 * Every non-overlapping formatted span within [from, to) of `text`, in
 * priority order when two candidates start at the same position -- a code
 * span wins a tie over em/strong/strike, so `` `_not_italic_` `` stays one
 * code span rather than also half-matching as italic underneath it.
 */
/**
 * True when `run`'s span cuts a mention rather than cleanly containing it.
 *
 * A delimiter search knows nothing about mentions, so a display name that
 * itself contains a delimiter character (`jane_doe`, and `_`/`` ` `` are
 * both legal in an Atlassian display name) could pair with any other
 * occurrence of that character elsewhere in the comment and produce a "run"
 * that starts outside the mention and ends inside it. `parseInlineRange`
 * then recursed into the run, stopped at the run's own end, and resumed the
 * outer walk from a point *inside* the mention — emitting the tail of the
 * display name a second time as literal text. `_@Bob_Marley cool_` posted as
 * `@Bob_MarleyMarley cool_`: no exception, no rejection from Jira, just
 * duplicated text nobody typed.
 *
 * Containment is fine and stays supported — `**hi @Sam Lee**` is a bold run
 * around a mention, and the mention still emits unmarked inside it. Only a
 * partial overlap is rejected, because only a partial overlap is ambiguous.
 */
function runCutsMention(run: InlineRun, mentions: JiraMentionSpan[]): boolean {
  return mentions.some((m) => {
    const overlaps = m.start < run.end && run.start < m.end;
    if (!overlaps) return false;
    return !(m.start >= run.contentStart && m.end <= run.contentEnd);
  });
}

function findInlineRuns(
  text: string,
  from: number,
  to: number,
  mentions: JiraMentionSpan[],
): InlineRun[] {
  const slice = text.slice(from, to);
  const candidates = INLINE_PATTERNS.flatMap(({ kind, re, priority }) =>
    Array.from(slice.matchAll(re)).map((m): InlineRun => {
      const start = from + (m.index ?? 0);
      const end = start + m[0].length;
      if (kind === 'link') {
        return {
          start,
          end,
          contentStart: start + 1,
          contentEnd: start + 1 + m[1].length,
          kind,
          href: m[2],
          priority,
        };
      }
      const delim = INLINE_DELIM_LENGTH[kind];
      return {
        start,
        end,
        contentStart: start + delim,
        contentEnd: end - delim,
        kind,
        priority,
      };
    }),
  );
  const sorted = [...candidates]
    .filter((run) => !runCutsMention(run, mentions))
    .sort((a, b) => a.start - b.start || a.priority - b.priority);
  return sorted.reduce<InlineRun[]>((accepted, run) => {
    const last = accepted[accepted.length - 1];
    return last && run.start < last.end ? accepted : [...accepted, run];
  }, []);
}

/**
 * The address a `[text](url)` run should actually carry, or null to post it
 * as plain text.
 *
 * People type bare domains — `[docs](example.com)` — and a bare domain is not
 * a URL: posted as-is Jira treats it as a relative link that goes nowhere.
 * Assuming https for something that plainly looks like a host is what the
 * user meant. Anything else with a scheme this app does not post (javascript:,
 * data:, file:) loses the mark and keeps its text, which is the honest
 * outcome: the words the user typed still appear, and nothing pretends to be
 * a link that this app would not follow.
 */
function postableHref(raw: string | undefined): string | null {
  const href = (raw ?? '').trim();
  if (!href) return null;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  // A scheme this app does not post, rather than a scheme-less address.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  // Scheme-less: only upgrade something host-shaped, so a stray word does not
  // silently become a link to a domain that may not be the user's.
  return /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(href) ? `https://${href}` : null;
}

function textNode(text: string, marks: JiraAdfAnyMark[]): JiraAdfInlineNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
}

/**
 * Recursively walks [from, to) of `text`, emitting plain-text runs, marked
 * runs (from `runs`) and mentions (from `mentions`) in document order.
 * `activeMarks` accumulates as recursion descends into a run's own content
 * -- today's pattern set never produces overlapping runs, so this recurses
 * at most one level in practice, but threading marks through the
 * accumulator is the natural shape regardless.
 *
 * A mention is never given marks, however deep the recursion: Jira's API
 * rejects any mark on a mention node outright (live-confirmed; see
 * `JiraAdfMentionNode`'s own comment in main/jira/jiraTypes.ts). Text on
 * either side of a mention inside a bold run still bolds; the mention
 * itself renders plain.
 */
function parseInlineRange(
  text: string,
  from: number,
  to: number,
  activeMarks: JiraAdfAnyMark[],
  mentions: JiraMentionSpan[],
  runs: InlineRun[],
): JiraAdfInlineNode[] {
  if (from >= to) return [];

  const nextRun = runs.find((r) => r.start >= from && r.start < to);
  const nextMention = mentions.find((m) => m.start >= from && m.start < to);
  const mentionIsNext =
    nextMention && (!nextRun || nextMention.start < nextRun.start);

  if (!nextRun && !nextMention) {
    return [textNode(text.slice(from, to), activeMarks)];
  }

  if (mentionIsNext && nextMention) {
    const before =
      from < nextMention.start
        ? [textNode(text.slice(from, nextMention.start), activeMarks)]
        : [];
    return [
      ...before,
      {
        type: 'mention',
        attrs: {
          id: nextMention.accountId,
          text: `@${nextMention.displayName}`,
        },
      },
      ...parseInlineRange(
        text,
        nextMention.end,
        to,
        activeMarks,
        mentions,
        runs,
      ),
    ];
  }

  const run = nextRun as InlineRun;
  const before =
    from < run.start
      ? [textNode(text.slice(from, run.start), activeMarks)]
      : [];
  const linkHref = run.kind === 'link' ? postableHref(run.href) : null;
  // A link whose address cannot be posted keeps its text and loses only the
  // mark. The alternative — letting it through — fails the whole comment at
  // the main-process validator, so one mistyped address would reject
  // everything the user had written with no way to tell which part was at
  // fault.
  function markForRun(): JiraAdfAnyMark | null {
    if (run.kind !== 'link') return { type: run.kind };
    return linkHref ? { type: 'link', attrs: { href: linkHref } } : null;
  }
  const runMark = markForRun();
  const innerMarks = runMark ? [...activeMarks, runMark] : activeMarks;
  const inner = parseInlineRange(
    text,
    run.contentStart,
    run.contentEnd,
    innerMarks,
    // Code is literal, so a mention inside it stays text. A fenced block
    // already worked this way (blockToAdf emits its raw text untouched);
    // an inline span did not, so `` `@Sam Lee` `` — text a user
    // deliberately marked as code — posted a real, notifying mention. Two
    // spellings of "this is code" disagreeing about whether it can notify
    // someone is the kind of surprise that costs trust in the feature.
    run.kind === 'code' ? [] : mentions,
    runs,
  );
  return [
    ...before,
    ...inner,
    ...parseInlineRange(text, run.end, to, activeMarks, mentions, runs),
  ];
}

function inlineNodesForRange(
  text: string,
  contentStart: number,
  contentEnd: number,
  mentions: JiraMentionSpan[],
): JiraAdfInlineNode[] {
  const runs = findInlineRuns(text, contentStart, contentEnd, mentions);
  return parseInlineRange(text, contentStart, contentEnd, [], mentions, runs);
}

interface ContentLine {
  contentStart: number;
  contentEnd: number;
}

type GroupedBlock =
  | { type: 'paragraph'; line: ContentLine }
  | { type: 'heading'; level: 1 | 2 | 3; line: ContentLine }
  | { type: 'bulletList'; items: ContentLine[] }
  | { type: 'orderedList'; items: ContentLine[] }
  | { type: 'quote'; items: ContentLine[] }
  | { type: 'codeBlock'; text: string };

type LineKind =
  | 'codeFence'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'paragraph';

const LIST_BLOCK_TYPE: Record<
  'bullet' | 'ordered' | 'quote',
  'bulletList' | 'orderedList' | 'quote'
> = {
  bullet: 'bulletList',
  ordered: 'orderedList',
  quote: 'quote',
};

function classifyLine(
  lineText: string,
  lineStart: number,
  lineEnd: number,
): { kind: LineKind; contentStart: number; contentEnd: number } {
  if (/^```/.test(lineText)) {
    return { kind: 'codeFence', contentStart: lineStart, contentEnd: lineEnd };
  }
  const heading = lineText.match(/^(#{1,3})\s+/);
  if (heading) {
    return {
      kind: `heading${heading[1].length}` as LineKind,
      contentStart: lineStart + heading[0].length,
      contentEnd: lineEnd,
    };
  }
  const bullet = lineText.match(/^[-*]\s+/);
  if (bullet) {
    return {
      kind: 'bullet',
      contentStart: lineStart + bullet[0].length,
      contentEnd: lineEnd,
    };
  }
  const ordered = lineText.match(/^\d+\.\s+/);
  if (ordered) {
    return {
      kind: 'ordered',
      contentStart: lineStart + ordered[0].length,
      contentEnd: lineEnd,
    };
  }
  const quote = lineText.match(/^>\s?/);
  if (quote) {
    return {
      kind: 'quote',
      contentStart: lineStart + quote[0].length,
      contentEnd: lineEnd,
    };
  }
  return { kind: 'paragraph', contentStart: lineStart, contentEnd: lineEnd };
}

/**
 * Groups `text`'s lines into blocks: consecutive bullet/ordered/quote lines
 * merge into one list/quote, a ``` line opens a code fence that consumes
 * every following line verbatim (no inline parsing, no mentions) until a
 * closing ```, and anything else is its own heading or paragraph block.
 *
 * A `.reduce` over the classified lines, not a loop with a mutable "current
 * list" variable -- the accumulator's `blocks` array and in-flight `fence`
 * buffer carry exactly that state instead.
 */
interface LineGroupState {
  blocks: GroupedBlock[];
  fence: string[] | null;
}

interface RawLine {
  lineText: string;
  lineStart: number;
  lineEnd: number;
}

/** One step of `groupLinesIntoBlocks`'s fold, named and explicitly typed
 * rather than an inline `.reduce()` callback: TypeScript's overload
 * resolution for a generic `.reduce<U>()` can silently mis-infer the
 * accumulator's type when the callback is this long and every branch
 * returns a different-looking object literal, and a named function with a
 * declared return type sidesteps that ambiguity entirely rather than
 * fighting it with more type annotations inline. */
function reduceLineIntoBlocks(
  acc: LineGroupState,
  raw: RawLine,
): LineGroupState {
  const { lineText, lineStart, lineEnd } = raw;
  if (acc.fence !== null) {
    if (/^```/.test(lineText)) {
      return {
        blocks: [
          ...acc.blocks,
          { type: 'codeBlock', text: acc.fence.join('\n') },
        ],
        fence: null,
      };
    }
    return { blocks: acc.blocks, fence: [...acc.fence, lineText] };
  }

  const cls = classifyLine(lineText, lineStart, lineEnd);
  if (cls.kind === 'codeFence') return { blocks: acc.blocks, fence: [] };

  const last = acc.blocks[acc.blocks.length - 1];
  const line: ContentLine = {
    contentStart: cls.contentStart,
    contentEnd: cls.contentEnd,
  };

  if (cls.kind === 'bullet' || cls.kind === 'ordered' || cls.kind === 'quote') {
    const listType = LIST_BLOCK_TYPE[cls.kind];
    if (last && last.type === listType) {
      const merged = { ...last, items: [...last.items, line] };
      return { blocks: [...acc.blocks.slice(0, -1), merged], fence: null };
    }
    return {
      blocks: [...acc.blocks, { type: listType, items: [line] }],
      fence: null,
    };
  }

  if (
    cls.kind === 'heading1' ||
    cls.kind === 'heading2' ||
    cls.kind === 'heading3'
  ) {
    const level = Number(cls.kind.slice(-1)) as 1 | 2 | 3;
    return {
      blocks: [...acc.blocks, { type: 'heading', level, line }],
      fence: null,
    };
  }

  return {
    blocks: [...acc.blocks, { type: 'paragraph', line }],
    fence: null,
  };
}

function groupLinesIntoBlocks(text: string): GroupedBlock[] {
  let offset = 0;
  const lines: RawLine[] = text.split('\n').map((lineText) => {
    const lineStart = offset;
    const lineEnd = lineStart + lineText.length;
    offset = lineEnd + 1; // +1 skips the '\n' that String.split consumed
    return { lineText, lineStart, lineEnd };
  });

  const initial: LineGroupState = { blocks: [], fence: null };
  const { blocks, fence } = lines.reduce(reduceLineIntoBlocks, initial);

  // An unterminated fence (the user never typed a closing ```) is flushed as
  // a code block rather than silently dropped -- whatever they typed still
  // posts, just without the fence having been "completed".
  return fence !== null
    ? [...blocks, { type: 'codeBlock', text: fence.join('\n') }]
    : blocks;
}

function blockToAdf(
  block: GroupedBlock,
  text: string,
  mentions: JiraMentionSpan[],
): JiraAdfBlockNode {
  if (block.type === 'paragraph') {
    return {
      type: 'paragraph',
      content: inlineNodesForRange(
        text,
        block.line.contentStart,
        block.line.contentEnd,
        mentions,
      ),
    };
  }
  if (block.type === 'heading') {
    return {
      type: 'heading',
      attrs: { level: block.level },
      content: inlineNodesForRange(
        text,
        block.line.contentStart,
        block.line.contentEnd,
        mentions,
      ),
    };
  }
  if (block.type === 'bulletList' || block.type === 'orderedList') {
    return {
      type: block.type,
      content: block.items.map((item) => ({
        type: 'listItem' as const,
        content: [
          {
            type: 'paragraph' as const,
            content: inlineNodesForRange(
              text,
              item.contentStart,
              item.contentEnd,
              mentions,
            ),
          },
        ],
      })),
    };
  }
  if (block.type === 'quote') {
    return {
      type: 'blockquote',
      content: block.items.map((item) => ({
        type: 'paragraph' as const,
        content: inlineNodesForRange(
          text,
          item.contentStart,
          item.contentEnd,
          mentions,
        ),
      })),
    };
  }
  return { type: 'codeBlock', content: [{ type: 'text', text: block.text }] };
}

export function buildCommentAdf(
  text: string,
  mentions: JiraMentionSpan[],
): JiraCommentBody {
  // Two filters, and the second is not redundant. The first checks each span
  // against the text on its own; two spans can both pass it and still
  // overlap each other (a full "@Sam Lee" and a stale prefix "@Sam" both
  // anchored at the same offset, say). `parseInlineRange` takes the first
  // match it finds, so which of them won was decided by the caller's array
  // order — the same draft could post a different mention depending on the
  // order spans happened to be appended in, dropping or truncating the
  // other silently. Sorting first makes "first wins" mean "leftmost wins",
  // and anything still overlapping an accepted span is dropped rather than
  // half-applied.
  const validMentions = mentions
    .filter((m) => text.slice(m.start, m.end) === `@${m.displayName}`)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce<JiraMentionSpan[]>((accepted, m) => {
      const last = accepted[accepted.length - 1];
      return last && m.start < last.end ? accepted : [...accepted, m];
    }, []);

  const content = groupLinesIntoBlocks(text).map((block) =>
    blockToAdf(block, text, validMentions),
  );

  return { type: 'doc', version: 1, content };
}

// -----------------------------------------------------------------------
// Comment body: ADF -> the lightweight-markdown subset (buildCommentAdf's
// inverse, for editing an existing comment)
// -----------------------------------------------------------------------
//
// Editing a real comment means: read its ADF, turn it into text a person can
// edit in the SAME composer that writes comments, then turn that text back
// into ADF and overwrite the original in Jira. That last step has no
// approval gate and no undo, so "turn it back into text" cannot be a best-
// effort flattener the way `main/jira/jiraMap.ts`'s `adfToPlainText` is —
// that function is allowed to lose formatting on the read-only display path
// (a bold run renders as plain text; nobody's data changes). Losing
// formatting HERE means the edit silently rewrites the comment's structure
// the moment it's saved: a table becomes stray paragraphs, a literal
// asterisk the author typed becomes real bold. Both are real, irreversible
// data loss in the founder's own Jira.
//
// So this file does not trust a whitelist of "node types the composer can
// produce" to decide a comment is safe to edit, even though
// `deserializeJiraCommentAdf` below IS built narrowly around exactly what
// `blockToAdf`/`groupLinesIntoBlocks` above can produce (paragraphs,
// headings, bullet/ordered lists, blockquotes, code blocks, mentions, and
// text carrying at most one of strong/em/strike/code/link). A node-type
// whitelist alone cannot catch the case that matters most: plain, unmarked
// prose that happens to contain a literal `*`, `_` or backtick. That text
// deserializes untouched (there is nothing to reject —
// every node is a supported type) and then RE-serializes differently, because
// `buildCommentAdf` has no way to know those characters weren't meant as
// delimiters. The only way to catch that is to actually do the round trip and
// compare the result: `prepareJiraCommentEdit` below is the one function
// anything in this app is allowed to trust for "is this comment safe to edit
// in place" — never `deserializeJiraCommentAdf`'s success alone.

function isAdfRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A mention span with no dependency on the source text's own offsets —
 * `deserializeJiraCommentAdf` builds these directly from the ADF tree it is
 * walking, then shifts them into whole-document offsets once every block's
 * text is known (see the caller). */
interface RelativeMentionSpan {
  start: number;
  end: number;
  accountId: string;
  displayName: string;
}

/**
 * One inline run's markdown-lite spelling, or `null` when `mark` isn't one
 * `buildCommentAdf`'s own `INLINE_PATTERNS`/`markForRun` can ever produce —
 * an unsupported mark type, or a `link` mark with no usable `href`. `null`
 * here is what makes an unsupported mark surface as "not editable" rather
 * than as formatting silently dropped: the caller that receives it bails out
 * of deserializing the whole comment (see `inlineContentToLineText`) instead
 * of emitting `raw` unmarked, which would be exactly the kind of guess this
 * feature exists to refuse to make.
 */
function wrapWithMark(raw: string, mark: unknown): string | null {
  if (!isAdfRecord(mark) || typeof mark.type !== 'string') return null;
  switch (mark.type) {
    case 'strong':
      return `**${raw}**`;
    case 'em':
      return `_${raw}_`;
    case 'strike':
      return `~~${raw}~~`;
    case 'code':
      return `\`${raw}\``;
    case 'link': {
      const attrs = mark.attrs;
      const href = isAdfRecord(attrs) ? attrs.href : undefined;
      return typeof href === 'string' && href ? `[${raw}](${href})` : null;
    }
    default:
      return null;
  }
}

/** `marks`, read the same lenient way `main/jira/jiraIpc.ts`'s own
 * `readOptionalMarks` reads it on the write boundary: absent and an explicit
 * empty array both mean "no marks" (Jira's own read responses use both
 * shapes for the same plain text node), so treating them differently here
 * would refuse editing ordinary, unformatted comments — the common case —
 * over a distinction that carries no real difference in meaning. `null`
 * means the value present isn't a marks array at all, which IS a real
 * "cannot represent this" case. */
function readMarksList(raw: unknown): unknown[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  return raw;
}

/**
 * One line's worth of inline content — a paragraph's, a heading's, one list
 * item's, one blockquote line's — turned into markdown-lite text plus the
 * mention spans found in it, relative to this line's own start (`prefix`
 * included, so a mention after "- " or "## " already accounts for it).
 *
 * `null` on anything `blockToAdf`'s own inline pipeline cannot produce: a
 * mention carrying marks (forbidden on the write side — see
 * `JiraAdfMentionNode`'s own comment in main/jira/jiraTypes.ts), an inline
 * node that isn't `text` or `mention` (a real Jira comment can carry an
 * `emoji`, `hardBreak`, `inlineCard`, `status`, or `date` node the composer's
 * toolbar has no way to type), a text node whose `marks` carries more than
 * one entry (the composer never produces compound marks — see
 * `parseInlineRange`'s own comment on why bold-and-italic-together isn't
 * detected as one span), or a mark this file doesn't recognize.
 */
function inlineContentToLineText(
  content: unknown,
  prefix: string,
): { text: string; mentions: RelativeMentionSpan[] } | null {
  if (!Array.isArray(content)) return null;
  let text = prefix;
  const mentions: RelativeMentionSpan[] = [];
  for (const node of content) {
    if (!isAdfRecord(node) || typeof node.type !== 'string') return null;
    if (node.type === 'mention') {
      if (node.marks !== undefined) return null;
      const attrs = node.attrs;
      if (
        !isAdfRecord(attrs) ||
        typeof attrs.id !== 'string' ||
        typeof attrs.text !== 'string'
      ) {
        return null;
      }
      const displayName = attrs.text.startsWith('@')
        ? attrs.text.slice(1)
        : attrs.text;
      if (!displayName) return null;
      const label = `@${displayName}`;
      mentions.push({
        start: text.length,
        end: text.length + label.length,
        accountId: attrs.id,
        displayName,
      });
      text += label;
      continue;
    }
    if (node.type === 'text' && typeof node.text === 'string') {
      const marks = readMarksList(node.marks);
      if (marks === null || marks.length > 1) return null;
      const wrapped =
        marks.length === 0 ? node.text : wrapWithMark(node.text, marks[0]);
      if (wrapped === null) return null;
      text += wrapped;
      continue;
    }
    return null;
  }
  return { text, mentions };
}

/** One block's worth of output lines — a paragraph or heading is exactly
 * one, a list or blockquote is one per item, a code block is its fenced
 * lines — each paired with that same line's own mentions (relative to the
 * line, same contract as `inlineContentToLineText`'s return). `null` for
 * anything outside `blockToAdf`'s own range: a `table`, `panel`, `rule`,
 * `mediaSingle`/`media` (an embedded image or file — the one shape the
 * founder's own real corpus was refused for), a list item spanning more than
 * one paragraph, or any block whose inline content itself failed to
 * deserialize. */
function blockToLines(
  raw: unknown,
): { lines: string[]; lineMentions: RelativeMentionSpan[][] } | null {
  if (!isAdfRecord(raw) || typeof raw.type !== 'string') return null;

  if (raw.type === 'paragraph') {
    const inline = inlineContentToLineText(raw.content, '');
    return inline && { lines: [inline.text], lineMentions: [inline.mentions] };
  }

  if (raw.type === 'heading') {
    const attrs = raw.attrs;
    const level = isAdfRecord(attrs) ? attrs.level : undefined;
    if (level !== 1 && level !== 2 && level !== 3) return null;
    const inline = inlineContentToLineText(
      raw.content,
      `${'#'.repeat(level)} `,
    );
    return inline && { lines: [inline.text], lineMentions: [inline.mentions] };
  }

  if (raw.type === 'bulletList' || raw.type === 'orderedList') {
    if (!Array.isArray(raw.content)) return null;
    const lines: string[] = [];
    const lineMentions: RelativeMentionSpan[][] = [];
    for (let i = 0; i < raw.content.length; i += 1) {
      const item = raw.content[i];
      if (
        !isAdfRecord(item) ||
        item.type !== 'listItem' ||
        !Array.isArray(item.content) ||
        item.content.length !== 1
      ) {
        return null;
      }
      const paragraph = item.content[0];
      if (!isAdfRecord(paragraph) || paragraph.type !== 'paragraph') {
        return null;
      }
      // ADF's own list-item shape carries no per-item number to preserve
      // (see JiraAdfOrderedList's own comment: `blockToAdf` never writes
      // one either), so this synthesizes sequential numbers purely for a
      // readable draft — `groupLinesIntoBlocks`' ordered-line regex accepts
      // any digits, and re-encoding discards them the same way regardless
      // of which ones are here, so the round trip cannot be sensitive to
      // this choice.
      const prefix = raw.type === 'bulletList' ? '- ' : `${i + 1}. `;
      const inline = inlineContentToLineText(paragraph.content, prefix);
      if (!inline) return null;
      lines.push(inline.text);
      lineMentions.push(inline.mentions);
    }
    return { lines, lineMentions };
  }

  if (raw.type === 'blockquote') {
    if (!Array.isArray(raw.content)) return null;
    const lines: string[] = [];
    const lineMentions: RelativeMentionSpan[][] = [];
    for (const paragraph of raw.content) {
      if (!isAdfRecord(paragraph) || paragraph.type !== 'paragraph') {
        return null;
      }
      const inline = inlineContentToLineText(paragraph.content, '> ');
      if (!inline) return null;
      lines.push(inline.text);
      lineMentions.push(inline.mentions);
    }
    return { lines, lineMentions };
  }

  if (raw.type === 'codeBlock') {
    if (!Array.isArray(raw.content)) return null;
    let combined = '';
    for (const node of raw.content) {
      if (!isAdfRecord(node) || node.type !== 'text') return null;
      if (typeof node.text !== 'string') return null;
      const marks = readMarksList(node.marks);
      if (marks === null || marks.length > 0) return null;
      combined += node.text;
    }
    const fenceLines = ['```', ...combined.split('\n'), '```'];
    return { lines: fenceLines, lineMentions: fenceLines.map(() => []) };
  }

  // Everything else — table, panel, expand, rule, mediaSingle/media, and
  // any node this dialect never grew a spelling for — is refused here
  // rather than approximated. There is no markdown-lite text this file's
  // dialect can represent it as.
  return null;
}

/**
 * ADF document -> markdown-lite text + mention spans, or `null` for a
 * document this narrow dialect cannot represent at all.
 *
 * This is `buildCommentAdf`'s inverse in the sense that every shape
 * `groupLinesIntoBlocks`/`blockToAdf` can produce, this can read back — but
 * it is NOT, on its own, a promise that the result re-serializes to the same
 * document. A `null` return here is one honest signal ("this comment can't
 * even be represented"); a non-null return is not yet a second one ("this
 * comment can be edited without changing it") — only `prepareJiraCommentEdit`
 * below, which actually performs the round trip, gets to say that. See this
 * section's own header comment for why the distinction matters: the literal-
 * delimiter case deserializes here just fine and is caught one step later.
 */
function deserializeJiraCommentAdf(
  raw: unknown,
): { text: string; mentions: JiraMentionSpan[] } | null {
  if (!isAdfRecord(raw) || raw.type !== 'doc' || !Array.isArray(raw.content)) {
    return null;
  }

  const blockResults = raw.content.map(blockToLines);
  if (blockResults.some((r) => r === null)) return null;

  const lines: string[] = [];
  const lineMentions: RelativeMentionSpan[][] = [];
  for (const result of blockResults as NonNullable<
    ReturnType<typeof blockToLines>
  >[]) {
    lines.push(...result.lines);
    lineMentions.push(...result.lineMentions);
  }

  let cursor = 0;
  const mentions: JiraMentionSpan[] = [];
  lines.forEach((line, i) => {
    for (const m of lineMentions[i]) {
      mentions.push({
        start: m.start + cursor,
        end: m.end + cursor,
        accountId: m.accountId,
        displayName: m.displayName,
      });
    }
    cursor += line.length + 1; // +1 for the '\n' joining this line to the next
  });

  return { text: lines.join('\n'), mentions };
}

/**
 * A recursive structural equality over two ADF (sub)trees, order-sensitive
 * on arrays (content order is real document order and must match exactly)
 * and order-insensitive on object keys.
 *
 * One normalization, not a general fuzzy match: `marks: []` and an absent
 * `marks` key compare equal (see `normalizeAdfForCompare` below), for the
 * same reason `readMarksList` above treats them alike on the read side —
 * Jira's own responses use both shapes for the same plain text node, and a
 * strict raw-JSON comparison would refuse editing on that alone, which would
 * mean refusing nearly every ordinary, unformatted comment rather than the
 * rare structurally-different one this proof exists to catch.
 */
function deepEqualAdf(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqualAdf(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const aKeys = Object.keys(aRec).sort();
    const bKeys = Object.keys(bRec).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k, i) => k === bKeys[i] && deepEqualAdf(aRec[k], bRec[k]),
    );
  }
  return false;
}

/** See `deepEqualAdf`'s own comment — this is the one normalization it
 * applies before comparing: an empty `marks` array is dropped so it compares
 * equal to the key being absent entirely, on any object anywhere in the
 * tree. */
function normalizeAdfForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAdfForCompare);
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      if (key === 'marks' && Array.isArray(rec[key]) && rec[key].length === 0) {
        continue;
      }
      // Jira's own editor stamps identity-only attrs onto everything it
      // creates: a `localId` on each node, and `accessLevel` on a mention.
      // Neither carries anything the author wrote - they are editor
      // bookkeeping - but this app's builder never emits them, so comparing
      // them refused every comment composed in Jira rather than in Waypoint.
      // Replies always hit it, because Jira's Reply always produces a
      // mention. Captured from a real one: ENG-84 comment 10192.
      //
      // Ignored for the comparison only, and safe to drop from the saved
      // body for the same reason: they identify nodes to Jira's editor
      // rather than encoding content, and Jira reissues them. Everything
      // that does encode content - text, marks, a mention's id, a link's
      // href - is still compared exactly, so this widens which comments are
      // editable without weakening what "lossless" means.
      if (key === 'localId') continue;
      if (key === 'accessLevel' && rec[key] === '') continue;
      out[key] = normalizeAdfForCompare(rec[key]);
    }
    // A node whose only attrs were identity-only is left with an empty attrs
    // object, where the builder emits no attrs key at all. Treat those as
    // the same rather than failing on a difference that is now empty by
    // definition.
    const attrs = out.attrs;
    if (
      attrs &&
      typeof attrs === 'object' &&
      !Array.isArray(attrs) &&
      Object.keys(attrs as Record<string, unknown>).length === 0
    ) {
      delete out.attrs;
    }
    return out;
  }
  return value;
}

/**
 * The one function anything in this app may trust to decide whether a
 * comment can be edited in place without changing it — see this section's
 * own header comment for why a node-type whitelist alone (which
 * `deserializeJiraCommentAdf` above effectively is) cannot make that call by
 * itself.
 *
 * The proof, exactly: deserialize `comment.bodyAdf` to markdown-lite text,
 * run that text back through `buildCommentAdf` — the SAME function that
 * posts a real comment, not a copy of its logic — and deep-compare the
 * result against the original. Anything other than an exact match, including
 * a `null` from the deserializer itself, means "not editable": there is no
 * partial-fidelity fallback, because a partial-fidelity editor is worse than
 * no Edit button at all (see this app's own comment permissions model for
 * the same shape of decision: `getJiraCommentPermissions`' `editOwn`/
 * `editAll` decide whether Edit may be OFFERED; this decides whether it can
 * be SAFELY offered for this particular comment's own content).
 *
 * Returns the prefill a caller hands the composer on success — the same
 * `text`/`mentions` shape `postJiraComment` already takes — so a caller
 * never has to deserialize a second time to get what it just proved safe.
 */
export function prepareJiraCommentEdit(
  comment: JiraComment,
): { text: string; mentions: JiraMentionSpan[] } | null {
  if (comment.bodyAdf == null) return null;
  const deserialized = deserializeJiraCommentAdf(comment.bodyAdf);
  if (!deserialized) return null;

  const rebuilt = buildCommentAdf(deserialized.text, deserialized.mentions);
  const matches = deepEqualAdf(
    normalizeAdfForCompare(rebuilt),
    normalizeAdfForCompare(comment.bodyAdf),
  );
  return matches ? deserialized : null;
}

/**
 * The permalink Jira's own comment menu produces for one comment: the
 * issue's browse URL with `focusedCommentId` naming a specific comment.
 *
 * Verified against live Jira: opening this URL scrolls straight to that
 * comment and highlights it in the timeline. `site` is the bare host the
 * connection identity already carries (no scheme), so the `https://` is
 * added here once rather than re-typed at every call site — the same reason
 * `jiraUrl` in JiraTicketDetail.tsx builds its own plain browse URL the same
 * way.
 */
export function buildJiraCommentPermalink(
  site: string,
  issueKey: string,
  commentId: string,
): string {
  return `https://${site}/browse/${issueKey}?focusedCommentId=${commentId}`;
}

/**
 * Posts a comment as the connected user.
 *
 * `mentions` are the spans over `text` the composer's @-popover produced
 * (see JiraCommentComposer.tsx) — `buildCommentAdf` is where those become
 * real ADF `mention` nodes. A draft with no mentions goes through the same
 * builder as a single-run paragraph, so there is one write path rather than
 * a plain-text one and a separate mention-aware one.
 *
 * `parentId`, when given, is the comment this one is replying to — set by
 * JiraCommentComposer's Reply flow, and omitted from the IPC call entirely
 * (rather than sent as an explicit `null`) for anything else, since the
 * public comment-create endpoint accepting this field at all is undocumented
 * and unverified; sending nothing is the honest request for "no parent
 * asked". Whatever Jira actually did with it is read back off the response
 * through the same `toComment` every other read uses — this function must
 * never construct the returned comment's own `parentId` from this argument,
 * because that is exactly the claim this feature cannot make on the
 * request's word alone. See JiraComment.parentId's own comment.
 */
export async function postJiraComment(
  ticketId: string,
  text: string,
  mentions: JiraMentionSpan[] = [],
  parentId: string | null = null,
): Promise<JiraComment> {
  const body = buildCommentAdf(text, mentions);
  const comment = toComment(
    unwrap(
      await bridge().postComment(
        parentId ? { ticketId, body, parentId } : { ticketId, body },
      ),
    ),
  );

  // Posting a comment moves the ISSUE's `updated` in Jira, not just the
  // comment's own. Unlike the four writes above this path gets a comment back
  // rather than a ticket, so there is no fresh ticket to re-baseline from —
  // and left alone, the next queue read compares a stale cached timestamp
  // against a value this module's own comment moved, reports "Someone changed
  // this", and disables the priority/assignee/transition/attachment writes
  // until the user reloads. A safety banner that fires on the user's own
  // action is how a safety feature gets learned-ignored.
  //
  // Dropping the cached timestamp states the honest position — this module no
  // longer holds a baseline it can compare — and detectConflict already reads
  // an unknown timestamp as "no conflict" rather than guessing, so this needs
  // no new branch there. The next real read re-establishes the baseline.
  //
  // It does mean a third party editing in the window between this comment and
  // the next read is absorbed silently rather than flagged. That is not a
  // regression against the alternative: re-reading the ticket here would
  // absorb it identically, because nothing in the payload distinguishes
  // "updated moved because of me" from "because of me AND someone else". The
  // trade is a rare missed warning against a constant false one.
  lastTickets = lastTickets.map((t) =>
    t.id === ticketId ? { ...t, updatedAt: null } : t,
  );
  return comment;
}

/**
 * Overwrites a real comment's body outright, as the connected user.
 *
 * Callers must never reach this function without first proving the edit is
 * safe with `prepareJiraCommentEdit` — that is what decides whether `text`
 * and `mentions` came from a comment whose ADF this app can actually
 * reconstruct losslessly. This function itself does not re-check that; it
 * trusts its caller the same way `postJiraComment` trusts the composer to
 * have produced a real draft, not because the stakes are lower (they are
 * higher — this overwrites something that already exists, with no undo) but
 * because the proof is expensive to redo per keystroke and belongs at the
 * one point that decides whether Edit is even offered.
 *
 * `text`/`mentions` go through the exact same `buildCommentAdf` every other
 * write in this file uses — the whole point of round-tripping through it
 * during the proof is that the write path and the proof path can never
 * disagree, because they are the same function call.
 *
 * The returned comment comes straight off Jira's response, through the same
 * `toComment(unwrap(...))` every read and every other write uses — never
 * assembled from what was sent. That is what lets `parentId` survive an
 * edit honestly: this function never asks Jira to change it and never
 * fabricates it locally (see `JiraComment.parentId`'s own comment), so an
 * edited reply keeps whatever thread position Jira's response says it still
 * has, the same guarantee `postJiraComment` makes for a brand-new reply.
 */
export async function updateJiraComment(
  ticketId: string,
  commentId: string,
  text: string,
  mentions: JiraMentionSpan[] = [],
): Promise<JiraComment> {
  const body = buildCommentAdf(text, mentions);
  const comment = toComment(
    unwrap(await bridge().updateComment({ ticketId, commentId, body })),
  );

  // Same trap as postJiraComment/deleteJiraComment, solved the same way:
  // editing a comment moves the ISSUE's `updated` in Jira too, not just the
  // comment's own. Left alone, the next queue read would compare a stale
  // cached timestamp against a value this module's own edit just moved,
  // report "Someone changed this" about the user's own action, and disable
  // every other write until they reloaded. Dropping the cached timestamp
  // states the honest position — this module no longer holds a baseline it
  // can compare — and detectConflict already reads an unknown timestamp as
  // "no conflict" rather than guessing, so this needs no new branch there.
  lastTickets = lastTickets.map((t) =>
    t.id === ticketId ? { ...t, updatedAt: null } : t,
  );
  return comment;
}

/**
 * Deletes a real comment outright, as the connected user. No undo on either
 * side of this call: main's `deleteComment` (jiraClient.ts) answers a plain
 * 204 with no body, so — unlike every write above — there is no fresh
 * comment or ticket coming back to re-read or re-baseline from.
 *
 * Same trap as postJiraComment, solved the same way: deleting a comment
 * moves the ISSUE's `updated` in Jira too, not just the comment's own. Left
 * alone, the next queue read would compare a stale cached timestamp against
 * a value this module's own delete just moved, report "Someone changed
 * this" about the user's own action, and disable every other write until
 * they reloaded. Dropping the cached timestamp states the honest position —
 * this module no longer holds a baseline it can compare — and
 * detectConflict already reads an unknown timestamp as "no conflict" rather
 * than guessing, so this needs no new branch there either.
 *
 * Removing the row from whatever list a comment thread renders from is the
 * caller's job, not this module's: unlike `lastTickets` and
 * `transitionsByTicketId` above, this file keeps no cache of a ticket's
 * comments — `listJiraComments` is read straight through — so there is no
 * local state here for a delete to drop the row out of.
 */
export async function deleteJiraComment(
  ticketId: string,
  commentId: string,
): Promise<void> {
  unwrap(await bridge().deleteComment({ ticketId, commentId }));
  lastTickets = lastTickets.map((t) =>
    t.id === ticketId ? { ...t, updatedAt: null } : t,
  );
}

// dismissJiraTombstone — no ticket is ever marked tombstoned (see toTicket's
// own note on why that stays false), so this strip never renders and this
// function is unreachable from the UI today. Kept as the callback
// JiraTicketRow's props require, doing the only honest thing available if it
// ever does fire: dropping the row locally rather than pretending to un-do a
// reassignment this module cannot undo.
export async function dismissJiraTombstone(ticketId: string): Promise<void> {
  lastTickets = lastTickets.filter((t) => t.id !== ticketId);
}

// resolveJiraConflict backs the conflict strip's "Reload" button — the one
// user action a real hasConflict:true is reachable from. A full re-read is
// the whole fix: rememberTickets recomputes every ticket's conflict against
// what THIS read returns as the new baseline (see its own comment), so a
// ticket whose drift is not ongoing — the common case, since the strip's own
// copy calls it "your first conflict in 3 weeks" — comes back with
// hasConflict:false and writes unblock. A ticket still actively racing
// (rare) simply flags again on whatever read notices it next; there is
// nothing to acknowledge here beyond "look again", which is exactly what a
// re-read is.
export async function resolveJiraConflict(
  ticketId: string,
): Promise<JiraTicket> {
  const { tickets } = await listMyJiraTickets();
  const found = tickets.find((t) => t.id === ticketId);
  if (!found) throw new Error('That issue is no longer in your queue.');
  return found;
}
