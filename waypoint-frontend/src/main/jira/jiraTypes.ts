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
  | 'jira_error'
  /**
   * Jira answered 404 for the thing this request named.
   *
   * Split out of `jira_error` because one caller has to branch on it rather
   * than just print it: the comment freshness guards (see `getComment`)
   * decide whether to refuse a Save or a Delete on whether the comment they
   * are about to overwrite still exists. Before this reason existed those
   * guards inferred "gone" from the comment being absent from
   * `listComments`' newest-`COMMENT_PAGE_SIZE` page — which is also exactly
   * what a comment scrolling off a busy thread looks like, so they could
   * tell someone their comment had been deleted when nothing of the sort
   * had happened.
   *
   * Read this as "Jira will not show you this", never as "this was
   * deleted". Atlassian deliberately answers 404 rather than 403 for an
   * issue or comment the account may not browse, so a permission that
   * changed under you and a real deletion arrive here identically. Every
   * message built on this reason has to allow for both — that is the
   * strongest claim the response actually supports.
   */
  | 'not_found'
  /**
   * The local filesystem said no — the disk is full, the chosen folder is not
   * writable, the picked file vanished between the dialog and the read.
   *
   * Separate from `jira_error` for the same reason `invalid_credentials` is
   * separate from `network`: they are different facts about different systems
   * and they need different sentences. "Jira rejected that upload" sends a
   * user to their Jira admin; "Waypoint couldn't write that file" sends them
   * to their own disk, and telling them the first when the second happened
   * wastes their time on someone else's system.
   */
  | 'file_error'
  /**
   * A transfer of the exact same attachment (download) or to the exact same
   * ticket (upload) is already running, and this request was refused rather
   * than allowed to double up.
   *
   * The renderer's own per-control `downloading`/`uploading` booleans are
   * not enough to prevent this on their own: an upload to a ticket can be
   * started from two separate controls mounted together on the same open
   * ticket — `JiraTicketDetail.tsx`'s "Attach a file" button and
   * `JiraCommentComposer.tsx`'s toolbar attach button — each tracking its
   * own state with no visibility into the other's. Only a guard in main,
   * which every IPC call for a transfer passes through, can make "one
   * transfer of this attachment/ticket at a time" actually true. Separate
   * from `file_error` and `jira_error` for the same reason those are
   * separate from each other: this is neither the local disk nor Jira
   * refusing anything, so the sentence has to say what actually happened —
   * try again once the first transfer finishes.
   */
  | 'transfer_in_progress';

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

/**
 * A subtask as Jira reports it on the parent's `fields.subtasks`. Deliberately
 * a flat summary, not a full JiraWireTicket: Jira returns only these fields
 * inline, and pretending to more would mean a fetch per subtask.
 */
export interface JiraWireSubtask {
  id: string;
  key: string;
  title: string;
  stateName: string;
  stateCategory: JiraStateCategory;
}

/**
 * One issue link, already flattened to the OTHER issue plus the phrase that
 * describes this issue's relationship to it ("blocks", "is blocked by", ...).
 * Jira nests inward/outward differently; that asymmetry is resolved in the
 * mapper so the renderer never has to know which side it was on.
 */
export interface JiraWireIssueLink {
  id: string;
  relation: string;
  key: string;
  title: string;
  stateName: string;
  stateCategory: JiraStateCategory;
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
  labels: string[];
  dueDate: string | null;
  subtasks: JiraWireSubtask[];
  links: JiraWireIssueLink[];
  /**
   * The description's raw ADF, carried ALONGSIDE the flattened `description`
   * rather than replacing it. Keeping both is what lets the rich renderer land
   * without a flag day: surfaces that still read `description` keep working
   * unchanged, and null here simply means "render the plain text".
   */
  descriptionAdf: unknown | null;
  attachments: JiraWireAttachment[];
  /**
   * Whatever the bulk search's `expand=transitions` actually returned for
   * this issue — frequently empty, and NOT to be trusted as "this issue has
   * no legal moves". jiraApi.ts treats an empty array as "unknown, ask
   * again" and falls back to the per-issue transitions endpoint; see its own
   * comment for why that fallback is not optional.
   */
  transitions: JiraWireTransition[];
  /** When Jira last changed this issue (ISO), or null when Jira's payload
   * omitted `updated`. Null, not "now" — jiraMap.ts's mapIssue used to
   * fabricate the current time for a missing field, which pinned an
   * untouched issue to the top of every "recently updated" sort. */
  updatedAt: string | null;
}

/**
 * What one "my work" read produced, and whether it is the whole answer.
 *
 * The array alone could not say. listMyTickets caps its crawl at
 * MAX_PAGES × PAGE_SIZE deliberately (see its own comment — a pathological
 * account must not turn "load my work" into an unbounded crawl), but a
 * capped list and a complete one are the same shape, so the UI had no way to
 * tell them apart and rendered both as "here is everything". `truncated` is
 * the one bit that distinguishes them.
 */
/**
 * Why a "my work" read is a prefix rather than the answer, or `false` when it
 * is the answer.
 *
 * This carries the reason and not just the fact, because the two reasons need
 * different words on screen and a boolean forced one sentence to cover both.
 * The UI copy was written for the cap — "this is the first 500, most recently
 * updated" — and when the second case was added under the same flag, a
 * twelve-issue queue could render that sentence. Naming a cap that never
 * applied is the same kind of unsupported claim the flag exists to prevent,
 * just louder than the silence it replaced.
 *
 *  - `'page-cap'`  MAX_PAGES x PAGE_SIZE stopped a crawl Jira would have kept
 *                  feeding. `tickets` is the first 500, most recently updated.
 *  - `'no-cursor'` Jira said `isLast: false` but returned no `nextPageToken`,
 *                  so there is more and no way to ask for it. Says nothing
 *                  about how many were read — it can happen on page one.
 *
 * Both are truthy, so `if (truncated)` still means "incomplete" and only code
 * that needs to explain WHY has to look closer.
 */
export type JiraTruncation = false | 'page-cap' | 'no-cursor';

export interface JiraTicketQueryResult {
  tickets: JiraWireTicket[];
  truncated: JiraTruncation;
}

/**
 * The ADF shape a comment is now written as — the renderer's own composer
 * builds one of these (see jiraApi.ts's `buildCommentAdf`) from its
 * lightweight-markdown draft, a toolbar-driven subset chosen to match what
 * Jira's own comment editor's toolbar offers, not general Markdown. Narrow
 * by design: exactly the node and mark kinds that subset can ever produce,
 * not the general ADF schema.
 */
export type JiraAdfMarkType = 'strong' | 'em' | 'strike' | 'code';

export interface JiraAdfMark {
  type: JiraAdfMarkType;
}

export interface JiraAdfLinkMark {
  type: 'link';
  attrs: { href: string };
}

export type JiraAdfAnyMark = JiraAdfMark | JiraAdfLinkMark;

export interface JiraAdfTextNode {
  type: 'text';
  text: string;
  marks?: JiraAdfAnyMark[];
}

export interface JiraAdfMentionNode {
  type: 'mention';
  attrs: { id: string; text: string };
  // Deliberately no `marks` field: live-confirmed that Jira's comment-create
  // endpoint 400s (INVALID_INPUT) on a mention node carrying any mark at
  // all, while every other node/mark combination here succeeds. A mention
  // inside a bold run renders unbold; the text around it still bolds.
}

export type JiraAdfInlineNode = JiraAdfTextNode | JiraAdfMentionNode;

export interface JiraAdfParagraph {
  type: 'paragraph';
  content: JiraAdfInlineNode[];
}

export interface JiraAdfHeading {
  type: 'heading';
  attrs: { level: 1 | 2 | 3 };
  content: JiraAdfInlineNode[];
}

export interface JiraAdfListItem {
  type: 'listItem';
  content: JiraAdfParagraph[];
}

export interface JiraAdfBulletList {
  type: 'bulletList';
  content: JiraAdfListItem[];
}

export interface JiraAdfOrderedList {
  type: 'orderedList';
  content: JiraAdfListItem[];
}

export interface JiraAdfBlockquote {
  type: 'blockquote';
  content: JiraAdfParagraph[];
}

/** Jira's codeBlock content is always plain text -- no marks, no mentions.
 * A code fence is meant to render exactly what's inside it, literally. */
export interface JiraAdfCodeBlock {
  type: 'codeBlock';
  content: JiraAdfTextNode[];
}

export type JiraAdfBlockNode =
  | JiraAdfParagraph
  | JiraAdfHeading
  | JiraAdfBulletList
  | JiraAdfOrderedList
  | JiraAdfBlockquote
  | JiraAdfCodeBlock;

export interface JiraCommentBody {
  type: 'doc';
  version: 1;
  content: JiraAdfBlockNode[];
}

/**
 * A restriction Jira placed on a comment — present on `JiraWireComment.visibility`
 * only when the comment is NOT visible to everyone who can otherwise see the
 * ticket. Read straight off the comment's own `visibility` object (Jira REST
 * v3's `Comment.visibility`, e.g. `{ type: "role", value: "Administrators" }`);
 * absent on the raw payload means the comment is fully public, which is why
 * `JiraWireComment.visibility` is `null` in that case rather than this type
 * with some "none" variant.
 *
 * This app can only ever READ this field. JiraCommentComposer.tsx has no
 * control for restricting a reply, so every comment this app posts is fully
 * public no matter what it is replying to. See ROAD-24, which this type
 * exists to fix: without it, a comment restricted to a project role rendered
 * indistinguishably from a public one, and a reasonable reply typed in the
 * open could land on something that was meant to stay internal — worst on
 * Jira Service Management projects, where "internal" is a real access
 * boundary, not just a convention.
 *
 * Deliberately not `jsdPublic`, JSM's own separate public/internal-note flag
 * for a customer-facing portal. That is a different axis — agent-only vs.
 * customer-visible on a service-desk request — from this one — open to the
 * whole ticket vs. restricted to a role or group — and Atlassian's own
 * tracker (JSDCLOUD-15406, open as of this writing) says the platform
 * comment-read endpoints this client calls do not reliably return it. Surfacing
 * a field that is frequently just missing would mean a lock icon that is
 * wrong as often as it's right, which is worse than not having one; that
 * belongs in a ticket of its own once the read gap is closed, not folded into
 * this one.
 */
export interface JiraCommentVisibility {
  /**
   * Jira's own two restriction kinds are 'role' and 'group'. 'restricted' is
   * never sent by Jira — mapComment (jiraMap.ts) falls back to it for any
   * `type` this app doesn't recognize, so a restriction scheme this app has
   * never seen still reads as "hidden from someone" instead of silently
   * degrading to the unmarked, fully-public `null` case on
   * `JiraWireComment.visibility`. Treating an unrecognized restriction as
   * "public" would reproduce the exact bug this type exists to fix, just
   * triggered by an unfamiliar shape instead of a missing field — so that
   * direction of failure is the one this app cannot afford, even though it
   * means occasionally locking a comment whose restriction we can't fully
   * describe.
   */
  type: 'role' | 'group' | 'restricted';
  /**
   * The role or group name Jira restricted this comment to — "Administrators",
   * "Service Desk Team". Empty when Jira sent a `visibility` object without a
   * usable `value`; the comment still renders as restricted, just without a
   * name to label it with.
   *
   * Jira's payload also carries a deprecated `identifier` (the role/group's
   * id) alongside this. Not carried here: nothing in this app writes
   * visibility — there is no call an id would ever feed — and Jira's own
   * spec already marks that field deprecated in favor of `value`.
   */
  value: string;
}

export interface JiraWireComment {
  id: string;
  ticketId: string;
  authorName: string;
  /**
   * The author's Atlassian account id, or null when Jira withheld it.
   *
   * Needed because a "Reply" prefills a real ADF mention of the author, and
   * an ADF mention node is keyed on accountId — a display name cannot build
   * one, and guessing an id from a name would be wrong on any site with two
   * people called Sam. Null is honest here: a mention simply cannot be
   * offered for an author Jira did not identify.
   */
  authorAccountId: string | null;
  /**
   * When Jira last changed this comment, and who did. Both are on every
   * comment in the payload and were being dropped.
   *
   * They are the freshness signal an edit needs: the thread is read once on
   * mount, so without re-checking this before saving, editing a comment
   * someone else changed in the meantime silently overwrites their words.
   * Null when Jira omits it - never fabricated, same rule as createdAt.
   */
  updatedAt: string | null;
  updateAuthorName: string | null;
  body: string;
  /** When the comment was posted (ISO), or null when Jira's payload omitted
   * `created` — see JiraWireTicket's updatedAt for why this is null rather
   * than a fabricated "now". */
  createdAt: string | null;
  /**
   * The id of the comment this one replies to, or null when it has none.
   *
   * Real and genuinely undocumented: verified live against the founder's own
   * Jira (issue ENG-84) that a comment posted through Jira's own Reply button
   * comes back carrying `parentId`, even though Atlassian's published OpenAPI
   * spec names no such field on a comment, for reading or for writing. Treat
   * the spec's silence as exactly that — silence, not proof the field isn't
   * real.
   *
   * `parentId` arrives as a JSON **number** on the wire, unlike `id`, which
   * Jira sends as a string — the same asymmetry `mapComment`'s `String(id)`
   * already exists to paper over for `id` itself. Coerced to a string here for
   * the same reason: two representations of the same kind of value invite a
   * `===` that silently never matches. Jira also only ever includes this key
   * on a comment that HAS a parent — it is absent, not present-and-null, on
   * every top-level comment — so null here means exactly that, "no parent",
   * not "Jira didn't say".
   */
  parentId: string | null;
  /** Jira's restriction on who can see this comment, or `null` when it is
   * fully public. See `JiraCommentVisibility` above for what each state
   * means, why an unrecognized restriction never resolves to `null`, and why
   * `jsdPublic` is deliberately not this field. */
  visibility: JiraCommentVisibility | null;
  /**
   * The comment's raw ADF, carried ALONGSIDE the flattened `body` — same
   * shape and same reason as `JiraWireTicket.descriptionAdf`: `body` stays
   * the safe, always-rendering plain-text surface, and this is what an
   * editor needing the real document tree (see jiraApi.ts's ADF <->
   * markdown-lite pair, `buildCommentAdf`'s inverse) reads instead of trying
   * to re-derive structure from flattened text. Null whenever Jira sent this
   * comment as its legacy wiki-markup string rather than v3's real ADF (see
   * `plainTextFromJiraBody`) — there is no document tree to carry in that
   * case, only the string `body` already holds. A comment whose `bodyAdf` is
   * null can never be offered for in-place editing: there is nothing to run
   * the losslessness round-trip against.
   */
  bodyAdf: unknown | null;
}

/**
 * One page of an issue's comments, and how many the issue actually has.
 *
 * Same lesson as JiraTicketQueryResult, in the one place it bites hardest.
 * A comment read is capped at COMMENT_PAGE_SIZE, and a capped page and a
 * complete thread were the same `JiraWireComment[]` — so a 300-comment
 * incident ticket rendered its newest hundred under a heading that says
 * "Comments", with nothing anywhere saying the other 200 exist. Reading a
 * thread and believing you have seen all of it is worse than being told the
 * thread is long.
 *
 * `total` is Jira's own count for the issue, not a derived one: unlike the
 * ticket crawl, which can only ever know that *more* existed, the comment
 * endpoint reports exactly how many there are, so the UI can say "the latest
 * 100 of 312" instead of a vaguer "there are more".
 */
export interface JiraCommentPage {
  /** Oldest-first, and at most COMMENT_PAGE_SIZE of them. */
  comments: JiraWireComment[];
  /** Every comment on the issue, per Jira. May exceed `comments.length`
   *  both because of the page cap and because an unparseable comment is
   *  dropped in mapping; "showing N of total" is true either way. */
  total: number;
}

/** What `jira:status` answers with — a purely local read of the credential
 * store, never a network call, since the renderer asks for it on every mount
 * of the sidebar and the My Jira page. */
export interface JiraConnectionSnapshot {
  connected: boolean;
  identity: JiraIdentity | null;
}
