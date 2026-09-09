// Types for the "My Jira" companion project (phase 1 of 2 — see the build
// plan handed to this agent). Deliberately NOT folded into types/entities.ts:
// the real Project entity has no notion of "type" (independent vs
// companion) yet, and no backend for this exists — My Jira is modeled as
// its own standalone concept, not a row in the existing projects list/store.
//
// Ported from the approved interactive mockup
// (docs — see the My Jira mockup handed to this agent for the source of
// truth on markup/copy/interactions) into this app's own type conventions.

import type { ID, Priority } from '@/types/entities';

/**
 * A Jira project key — "ENG", "OPS", "WAY". Deliberately an open string
 * rather than the closed union this was while the data layer was fixtures:
 * project keys are whatever a real site's admins created, and a union would
 * mean a connected user's own projects failed to typecheck against a list
 * written before their site existed.
 */
export type JiraProjectKey = string;

/** The per-project identity colors, as `var(--p-*)` references — see
 * index.css. Three of them, which was one-per-project when there were exactly
 * three fixture projects and is now a palette to distribute across however
 * many a real account can see. */
const JIRA_PROJECT_COLORS = [
  'var(--p-eng)',
  'var(--p-plat)',
  'var(--p-grw)',
] as const;

/**
 * A stable color for a project key. Stable is the whole requirement: the same
 * key must get the same swatch on the filter chip, the row's left border and
 * the drawer header, across reloads and regardless of which projects happen
 * to be in the current result set — so this hashes the key rather than
 * assigning colors by list position. Two projects can collide on a color;
 * that's acceptable for what is a secondary visual grouping cue next to the
 * key itself, which is always shown.
 */
export function jiraProjectColor(projectKey: string): string {
  let hash = 0;
  for (let i = 0; i < projectKey.length; i += 1) {
    hash = (hash * 31 + projectKey.charCodeAt(i)) % 100003;
  }
  return JIRA_PROJECT_COLORS[hash % JIRA_PROJECT_COLORS.length];
}

/**
 * Why a Jira call failed, in the renderer's own vocabulary — the same set
 * `main/jira/jiraTypes.ts` defines as `JiraFailureReason`, widened to a bare
 * string so this file stays independent of the main process's own types (the
 * only thing crossing that line is `data/jiraApi.ts`'s type-only import).
 */
export type JiraErrorReason = string;

/**
 * What `data/jiraApi.ts` throws when main answers with a failure.
 *
 * Still an `Error` with Jira's own message verbatim, so every existing
 * `catch (err) { showErrorToast(err.message) }` path is unchanged. The
 * addition is `reason`: main distinguishes `invalid_credentials` from
 * `network` from `site_not_found` deliberately (see `JiraFailureReason`'s
 * own note), and collapsing that to a message string meant the UI could not
 * tell "your token died — reconnect" from "you're offline — try again".
 *
 * Declared here rather than in `data/jiraApi.ts` so a component can narrow
 * a caught error without importing the data module — which component tests
 * routinely `jest.mock()` wholesale.
 */
export class JiraApiError extends Error {
  readonly reason: JiraErrorReason;

  constructor(message: string, reason: JiraErrorReason) {
    super(message);
    this.name = 'JiraApiError';
    this.reason = reason;
  }
}

/** True when this failure means the stored credential can no longer be used
 * — i.e. the fix is reconnecting, not retrying. */
export function isJiraCredentialFailure(err: unknown): boolean {
  return (
    err instanceof JiraApiError &&
    (err.reason === 'invalid_credentials' ||
      err.reason === 'not_connected' ||
      err.reason === 'forbidden')
  );
}

/** How the current user relates to a ticket — never mutually exclusive in
 * real Jira (a person can be all three), but each row renders a single
 * `role-tag` pill, so main picks the strongest claim and this carries it.
 *
 * `'none'` is the absence of all three rather than a fourth role, and it is
 * a real state on a real ticket: reassign one away from yourself and, unless
 * you also report or watch it, that is exactly what you are to it now. The
 * row keeps showing until the next refresh (see setJiraTicketAssignee in
 * data/jiraApi.ts), so the pill has to be able to say so. */
export type JiraTicketRole = 'assignee' | 'reporter' | 'watcher' | 'none';

export interface JiraTransitionField {
  key: string;
  label: string;
  type: 'select' | 'text';
  required: boolean;
  /** Only meaningful for type: 'select'. */
  options?: string[];
  /** Shown under the field — e.g. "Optional on this workflow." */
  hint?: string;
}

/** One transition your Jira workflow allows from a ticket's current state —
 * "Waypoint doesn't invent them" (the mockup's own framing, preserved
 * verbatim in the popover footer copy). */
export interface JiraTransition {
  id: string;
  targetStateName: string;
  targetStateColor: string;
  requiresFields: JiraTransitionField[];
}

/**
 * One priority the connected site offers on a particular issue, in the site's
 * own words — read live from that issue rather than from a list this app
 * keeps, because a Jira admin can attach a different priority scheme to every
 * project.
 *
 * Distinct from `Priority` (types/entities.ts), which is the five-bucket enum
 * `PriorityIcon` draws and which this app shares with its own native tickets.
 * That enum is a display normalization and cannot be written back — "urgent"
 * is Waypoint's word, not any site's — so a write is built from `id` here.
 */
export interface JiraPriorityOption {
  id: string;
  name: string;
}

/**
 * One person the connected site says an issue can be assigned to — the rows
 * of the assignee picker's typeahead.
 *
 * Read live from the issue rather than from any list this app keeps, for the
 * same reason `JiraPriorityOption` is: assignability is a per-project
 * permission, so who can take ENG-421 is not who can take OPS-3.
 *
 * `avatarUrl` is carried across the wire but nothing renders it — every avatar
 * in this app is drawn from initials by components/ui/Avatar, which is also
 * what keeps the picker from firing a request per row at Atlassian's CDN just
 * to open a menu.
 */
export interface JiraUserOption {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * One file attached to a Jira issue.
 *
 * Mirrors `JiraWireAttachment` (main/jira/jiraTypes.ts) including its most
 * important property, which is a field that is not here: Jira's own `content`
 * URL. A download is an authenticated request carrying a whole-account
 * credential, and main builds its URL from the connected site plus `id` rather
 * than from a string that arrived inside a response body. Nothing on this side
 * names a destination, and nothing on this side could.
 */
export interface JiraAttachment {
  /** Jira's own id, or null when it returned none — which is exactly when no
   * download can be offered for this row. */
  id: string | null;
  fileName: string;
  sizeLabel: string;
  /** The same size as a number. Display uses `sizeLabel`; this is what a
   * comparison against a size cap is made from. */
  sizeBytes: number;
  mimeType: string;
  uploaderName: string;
}

/** Present only on a ticket reassigned away from the current user — kept
 * visible (struck through) for a grace window rather than vanishing, so it
 * "doesn't vanish mid-thought" (mockup copy). */
export interface JiraTombstoneInfo {
  reassignedTo: string;
  reassignedAt: string; // ISO
  reason?: string;
}

/** Present only while another Jira user's edit raced the local copy — rare,
 * and deliberately understated in the UI (a thin strip, not a modal). */
export interface JiraConflictInfo {
  changedBy: string;
  changedAt: string; // ISO
}

export interface JiraTicket {
  id: ID;
  key: string; // e.g. "ENG-421"
  projectKey: JiraProjectKey;
  title: string;
  role: JiraTicketRole;
  stateName: string;
  stateColor: string;
  /** The normalized bucket PriorityIcon draws — five values shared with this
   * app's own native tickets. Lossy by design, and not writable back to Jira:
   * no real site has a priority named "urgent". */
  priority: Priority;
  /** This site's own id for the current priority, or null when none is set.
   * The only handle a priority write can be built from. */
  priorityId: string | null;
  /** The site's own label ("Highest", "Blocker", or whatever it was renamed
   * to), so the picker can show what the ticket actually says rather than the
   * bucket it was flattened into. */
  priorityName: string;
  assigneeName: string;
  /** The assignee's own Atlassian account id, or null when nobody is
   * assigned. The only handle an assignee write can be built from, and what
   * lets the assignee picker mark who the issue is already on — `assigneeName`
   * renders the literal "Unassigned" for both "nobody" and "we couldn't read
   * who", which are not the same answer. */
  assigneeAccountId: string | null;
  reporterName: string;
  description: string;
  epicName: string | null;
  storyPoints: number | null;
  sprintName: string | null;
  /**
   * When Jira last changed this issue (ISO), or null when Jira's payload
   * omitted `updated`. Carried across the wire since the first read (see
   * JiraWireTicket) but dropped here until now, which is why the list could
   * only ever render in whatever order the search returned. "Recently
   * updated" is the sort a work queue actually wants, and it needs a
   * timestamp to be one.
   *
   * This used to be typed as always-present, because main filled a missing
   * `updated` in with `new Date().toISOString()` (jiraMap.ts) — so a trimmed
   * payload sorted to the very top of the queue claiming it was just
   * touched, which read as "updated just now" for an issue that might be
   * untouched for months. Main now maps a missing `updated` to null instead
   * of fabricating one, and useMyJiraQueue.ts's compareTickets treats null as
   * "unknown", sorting it to the bottom rather than the top.
   */
  updatedAt: string | null;
  attachments: JiraAttachment[];
  isTombstoned: boolean;
  tombstone: JiraTombstoneInfo | null;
  hasConflict: boolean;
  conflict: JiraConflictInfo | null;
}

// `assigneeInitials`/`watcherNames` above, and `authorInitials`/`mentions`
// below, were fixture-only fields no component ever rendered (Avatar derives
// its own initials from a name). Two of them are also things a Jira search
// response cannot supply — the search returns a watcher *count*, never the
// names — so keeping them would have meant shipping fields permanently filled
// with empty placeholders.

export interface JiraComment {
  id: ID;
  ticketId: ID;
  authorName: string;
  body: string;
  /** When the comment was posted (ISO), or null when Jira's payload omitted
   * `created` — see JiraTicket's updatedAt for why this is null rather than
   * a fabricated "now". */
  createdAt: string | null;
  postedByWaypoint: boolean;
  /** Self-disclosure prefix for a Copilot-authored comment (phase 2's
   * approval flow) — null for a plain, user-typed comment like every one
   * this phase's composer posts. */
  disclosureText: string | null;
}

/**
 * Why a queue read is a prefix rather than the answer — mirrors
 * main/jira/jiraTypes.ts's JiraTruncation, and exists for the same reason:
 * the two cases need different words on screen. Both are truthy, so
 * `if (truncated)` still reads as "incomplete".
 *
 *  - `'page-cap'`  the 500-issue crawl cap stopped a read Jira would have
 *                  kept feeding. Only here is "the first 500" true.
 *  - `'no-cursor'` Jira said there was more and gave nothing to page with.
 *                  Can happen on page one, so it implies nothing about size.
 */
export type JiraTruncation = false | 'page-cap' | 'no-cursor';

export interface JiraConnectionStatus {
  connected: boolean;
  accountName: string;
  accountEmail: string;
  /**
   * The connected user's own Atlassian account id.
   *
   * Their own, and only ever their own — this is not a directory. It is here
   * because "Assign to me" is a write, and a write needs an id: the picker
   * cannot build one from `accountName`, and searching the assignable list for
   * yourself by name would be guesswork on a site with two people called Sam.
   * Empty string when nothing is connected, matching the other fields here.
   */
  accountId: string;
  site: string;
  /**
   * When the ticket list was last actually read from Jira, or `null` when no
   * read has succeeded yet this session. Nullable deliberately: this used to
   * be seeded with `Date.now()` at module load, so a connected app that had
   * never reached Jira — offline at launch, dead token — still reported
   * "synced 0s ago". Absence of a sync is a real state and has to be
   * representable.
   */
  lastSyncAt: string | null; // ISO
  /** Issues in the last read of your queue — which is not the same as issues
   *  in your queue whenever `countsTruncated` is true. */
  issueCount: number;
  /** Distinct projects across that same read, and capped by it for the same
   *  reason: a project whose only issues fell past the cap is not counted. */
  projectCount: number;
  /**
   * Whether the page cap cut the read these counts are derived from.
   *
   * Both numbers above come from the cached ticket list, and that list stops
   * at MAX_PAGES × PAGE_SIZE. Without this bit, a user with 900 assigned
   * issues was shown a flat "500 issues in your queue" — not a rounded
   * number or an approximation, but a specific wrong one, in the panel whose
   * entire job is to report what Waypoint can see of their Jira. The counts
   * are floors, and this is what makes them render as floors.
   */
  countsTruncated: boolean;
}
// `pollIntervalSec` and `paused` used to live here, describing a background
// poll that kept the queue "feeling live". Neither the fixture layer nor the
// real Jira client ever polled: the list is read on mount and on an explicit
// Refresh. Now that these numbers describe a real Atlassian account rather
// than a mock, a poll interval this app does not honor is a claim it cannot
// back — so the fields, the interval readout and the Pause control are gone
// rather than left describing behavior that does not exist.

// JiraMentionCandidate — the composer's @-popover suggestion list — used to
// be listed here as gone: a real Jira mention is an ADF `mention` node
// carrying an accountId, and while the composer wrote to fixtures, typing
// "@Sam Lee" was a cosmetic shortcut that posted literal characters and
// notified nobody. That's no longer the gap. The composer's popover (see
// JiraCommentComposer.tsx) now searches this issue's real assignable users
// via `searchJiraAssignableUsers` and, on selection, records a
// `JiraMentionSpan` (data/jiraApi.ts) — start/end/accountId/displayName —
// rather than just splicing text in. `buildCommentAdf` is where that span
// becomes a genuine `mention` node before the comment is posted, which is
// what makes Jira actually notify the person picked.
