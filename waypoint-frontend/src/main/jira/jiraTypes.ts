// The wire shapes the Jira integration passes across the main→preload→
// renderer boundary. Deliberately its own file rather than living in either
// jiraClient.ts or renderer/types/jira.ts: all three of jiraAuth.ts,
// jiraClient.ts and jiraIpc.ts need them, and preload.ts re-states them in
// its own bridge signatures (which is how renderer/preload.d.ts ends up
// knowing about them at all).
//
// These are NOT renderer/types/jira.ts's types, and are not meant to
// converge with them. That file describes what the My Jira *UI* renders —
// including CSS-variable colors and presentation-only fields; this one
// describes only what a real Jira Cloud site can actually be asked for.
// renderer/data/jiraApi.ts owns the translation between the two, which is
// where "Jira gave us a status category" becomes "the chip is var(--warning)".

/** What a validated connection knows about the person it belongs to. Never
 * carries the API token — see jiraAuth.ts's own note on why the credential
 * and the identity are separate shapes even though they're stored together. */
export interface JiraIdentity {
  /** Bare hostname, e.g. "waypoint123.atlassian.net" — never a URL. */
  site: string;
  accountId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Why a Jira call failed, in the terms the UI actually has to distinguish.
 * `invalid_credentials` and `network` in particular must stay separable: the
 * connect form says something completely different for "Jira said no" than
 * for "we never reached Jira", and collapsing them would make a typo'd token
 * and an offline laptop look identical.
 */
export type JiraFailureReason =
  | 'not_connected'
  | 'invalid_input'
  | 'invalid_credentials'
  | 'forbidden'
  | 'site_not_found'
  | 'network'
  | 'storage_unavailable'
  | 'jira_error';

export interface JiraFailure {
  ok: false;
  reason: JiraFailureReason;
  message: string;
}

/** The same discriminated-union shape copilotAuth.ts's IPC handlers already
 * return — this codebase has no `Result<T, E>` helper, and inventing one for
 * this feature alone would be a new error-handling dialect for no gain. */
export type JiraResult<T> = { ok: true; value: T } | JiraFailure;

/** Jira's own three-way status grouping (`statusCategory.key`: new /
 * indeterminate / done), normalized. The renderer maps these to colors —
 * main has no business knowing about CSS variables, and Jira has no business
 * dictating a palette. */
export type JiraStateCategory = 'todo' | 'in-progress' | 'done';

export type JiraPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

/**
 * One priority a site actually offers, in its own words.
 *
 * Deliberately separate from `JiraPriority` above, and not a replacement for
 * it. That enum is a *normalization* — five buckets every site's scheme is
 * squeezed into so `PriorityIcon` (shared with this app's own native tickets)
 * can pick a glyph. It is lossy by design and cannot be written back: a site
 * running the Blocker/Critical/Major scheme has no priority called "urgent",
 * and one that renamed "Highest" to "Drop everything" has neither. Writing a
 * priority needs the site's real id, which is what this carries.
 */
export interface JiraPriorityOption {
  id: string;
  name: string;
}

/**
 * One person this site says an issue can be assigned to.
 *
 * Deliberately not `JiraIdentity`. That shape describes the *connected*
 * account and carries its email — which is a real personal detail belonging to
 * the person holding the credential, and has no business being handed to the
 * renderer for every colleague who turns up in a typeahead. An assignee write
 * needs an id, and a picker needs a name; nothing here needs more than that.
 *
 * `avatarUrl` mirrors `JiraIdentity.avatarUrl` and is carried for the same
 * reason it is there: it is the one presentational detail Jira volunteers
 * about a user, and dropping it at the boundary would mean re-reading the user
 * to get it back. Like that one, nothing renders it today — every avatar in
 * this app is drawn from initials by components/ui/Avatar.
 */
export interface JiraWireUser {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * How the signed-in user relates to an issue — strongest claim first, since
 * the my-work JQL matches on all three at once and a person is frequently
 * more than one of them.
 *
 * `'none'` is not a fourth kind of ownership. It is the positive absence of
 * all three, and it exists because `mapIssue` is reached by paths that JQL
 * guarantees nothing about: every write in this client re-reads its issue
 * through `getTicket`, which runs no query at all. See `roleOf` in jiraMap.ts
 * for why that distinction had to become representable.
 */
export type JiraTicketRole = 'assignee' | 'reporter' | 'watcher' | 'none';

/** One field a transition screen requires before Jira will accept the move. */
export interface JiraWireTransitionField {
  /** The real Jira field id — "resolution", "timetracking",
   * "customfield_10010". Sent back verbatim on the transition call so main
   * can look its metadata up again. */
  key: string;
  label: string;
  type: 'select' | 'text';
  required: boolean;
  /** Display strings for a select, taken from the field's allowedValues.
   * The transition call resolves whichever one comes back to its real id. */
  options?: string[];
  hint?: string;
}

export interface JiraWireTransition {
  id: string;
  targetStateName: string;
  targetStateCategory: JiraStateCategory;
  requiresFields: JiraWireTransitionField[];
}

/**
 * One file attached to an issue.
 *
 * Note what is NOT here: Jira's own `content` URL, which every attachment in a
 * real response carries. Leaving it out is the deliberate part.
 *
 * A download has to be authenticated, and this client's authentication is HTTP
 * Basic over `email:apiToken` — a bearer credential for the user's entire
 * Atlassian account. Carrying `content` across the wire and later fetching it
 * with that header attached would mean sending the whole-account credential to
 * whatever host a string inside a JSON response body happened to name. That
 * field is Jira's to fill in, not this app's to verify, and "the response said
 * so" is not a property worth aiming a credential at.
 *
 * `id` is what replaces it. Main builds
 * `https://{the stored site}/rest/api/3/attachment/content/{id}` itself, from a
 * hostname it validated at connect time and an id it validated at the IPC
 * boundary — so the destination of an authenticated request is always
 * constructed here, never quoted from a payload. Null when Jira returned no
 * usable id, which is exactly the case where no download can be offered.
 */
export interface JiraWireAttachment {
  id: string | null;
  fileName: string;
  /** Human-readable, for display — "214 KB". */
  sizeLabel: string;
  /** The same size as a number, because a size cap is a comparison and
   * "214 KB" is not one. 0 when Jira didn't say. */
  sizeBytes: number;
  /** Jira's own `mimeType` for the file, or `application/octet-stream` when it
   * didn't say — the honest default for bytes of unknown kind. */
  mimeType: string;
  uploaderName: string;
}

export interface JiraWireTicket {
  /** Jira's numeric issue id, not the key. Both work as `issueIdOrKey` in
   * every REST path this uses, but the id survives an issue being moved to
   * another project (which changes its key) — so it's the safer handle for
   * the renderer to hold across a refresh. */
  id: string;
  key: string;
  projectKey: string;
  title: string;
  role: JiraTicketRole;
  stateName: string;
  stateCategory: JiraStateCategory;
  /** The normalized bucket, for display only — see JiraPriorityOption. */
  priority: JiraPriority;
  /** This site's own id for the issue's current priority, or null when the
   * issue has none set. The one value a priority write can be built from. */
  priorityId: string | null;
  /** The site's own label — "Highest", "Blocker", whatever this site renamed
   * it to. "None" when the issue has no priority, which is a display fallback
   * and not a name Jira returned. */
  priorityName: string;
  assigneeName: string;
  /**
   * The assignee's own Atlassian account id, or null when nobody is assigned.
   *
   * The only handle an assignee *write* can be built from — `assigneeName` is
   * a display string, and two people on a site can share one. It also does the
   * job `priorityId` does for priority: separating "this issue is unassigned"
   * from "this issue has an assignee whose name we could not read", since
   * `assigneeName` collapses both into the literal "Unassigned".
   */
  assigneeAccountId: string | null;
  reporterName: string;
  description: string;
  epicName: string | null;
  storyPoints: number | null;
  sprintName: string | null;
  attachments: JiraWireAttachment[];
  /**
   * Whatever the bulk search's `expand=transitions` actually returned for
   * this issue — frequently empty, and NOT to be trusted as "this issue has
   * no legal moves". jiraApi.ts treats an empty array as "unknown, ask
   * again" and falls back to the per-issue transitions endpoint; see its own
   * comment for why that fallback is not optional.
   */
  transitions: JiraWireTransition[];
  updatedAt: string;
}

export interface JiraWireComment {
  id: string;
  ticketId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

/** What `jira:status` answers with — a purely local read of the credential
 * store, never a network call, since the renderer asks for it on every mount
 * of the sidebar and the My Jira page. */
export interface JiraConnectionSnapshot {
  connected: boolean;
  identity: JiraIdentity | null;
}
