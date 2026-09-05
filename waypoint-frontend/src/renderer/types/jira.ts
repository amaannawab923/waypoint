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

/** The three Jira projects the mock fixtures span — see jiraApi.ts. */
export type JiraProjectKey = 'ENG' | 'PLAT' | 'GRW';

/** Per-project identity color, as a `var(--p-*)` reference — see index.css. */
export const JIRA_PROJECT_COLOR: Record<JiraProjectKey, string> = {
  ENG: 'var(--p-eng)',
  PLAT: 'var(--p-plat)',
  GRW: 'var(--p-grw)',
};

/** How the current user relates to a ticket — never mutually exclusive in
 * real Jira (a person can be all three), but the mock fixtures (like the
 * mockup) assign each ticket exactly one role, matching the single
 * `role-tag` pill each row renders. */
export type JiraTicketRole = 'assignee' | 'reporter' | 'watcher';

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

export interface JiraAttachment {
  fileName: string;
  sizeLabel: string;
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
  priority: Priority;
  assigneeName: string;
  assigneeInitials: string;
  reporterName: string;
  watcherNames: string[];
  description: string;
  epicName: string | null;
  storyPoints: number | null;
  sprintName: string | null;
  attachments: JiraAttachment[];
  isTombstoned: boolean;
  tombstone: JiraTombstoneInfo | null;
  hasConflict: boolean;
  conflict: JiraConflictInfo | null;
}

export interface JiraComment {
  id: ID;
  ticketId: ID;
  authorName: string;
  authorInitials: string;
  body: string;
  /** Names mentioned via @Name — best-effort, matched against
   * listJiraMentionCandidates() at post time. */
  mentions: string[];
  createdAt: string; // ISO
  postedByWaypoint: boolean;
  /** Self-disclosure prefix for a Copilot-authored comment (phase 2's
   * approval flow) — null for a plain, user-typed comment like every one
   * this phase's composer posts. */
  disclosureText: string | null;
}

export interface JiraConnectionStatus {
  connected: boolean;
  accountName: string;
  accountEmail: string;
  site: string;
  lastSyncAt: string; // ISO
  issueCount: number;
  projectCount: number;
  pollIntervalSec: number;
  /** Sync paused by the user from the Connection tab — reads still work
   * (nothing here disables the ticket list), this only gates
   * refreshJiraSync()'s "feels live" polling story. */
  paused: boolean;
}

/** A mention target offered by the comment composer's @-popover. */
export interface JiraMentionCandidate {
  name: string;
  role: string; // e.g. "reviewer", "reporter", "watcher" — free text, display-only
}

/** phase 2 — the Copilot rail's proposal for ENG-421. Deliberately a SINGLE
 * combined proposal covering both a state move AND a comment post, unlike
 * the native ProposalView (types/entities.ts), which is one-kind-per-row.
 * The mockup's approveProp() applies both atomically behind one Approve
 * click, and that's a meaningful part of the design (a Jira transition and
 * its justifying comment belong together), not an accident of the mock —
 * so this type preserves it rather than splitting into two ProposalView-like
 * rows. Never built on top of ProposalView/ProposalKind: those are tightly
 * coupled to real ticket UUIDs and a backend-driven claim state machine that
 * doesn't exist for Jira (see JiraProposalCard.tsx's own header comment). */
export type JiraProposalStatus = 'proposed' | 'executing' | 'executed' | 'rejected';

export interface JiraProposal {
  id: ID;
  ticketId: ID;
  ticketKey: string;
  ticketProjectColor: string;
  status: JiraProposalStatus;
  fromStateName: string;
  fromStateColor: string;
  toStateName: string;
  toStateColor: string;
  commentBody: string;
  commentMentions: string[];
  /** Local-provenance context — "read from your checkout by the local
   * agent, no code left this machine" (mockup copy), rendered in the rail's
   * `.ctx` block. */
  repoPath: string;
  branch: string;
  commitCount: number;
  prNumber: number;
  prStatus: string; // e.g. "open" — free text, display-only, matches the mock's own PR fixture
  createdAt: string; // ISO
  resolvedAt: string | null; // ISO, set once executed or rejected
}

/** The rail's small "Also queued" duplicate-ticket nudge (GRW-12 vs GRW-9).
 * Deliberately NOT a second JiraProposal — there's no real second proposal
 * object to approve/reject here, just a dismissible pointer at an existing
 * ticket (see jiraApi.ts's getJiraDuplicateNudge for why this stays this
 * thin rather than growing a parallel fixture). */
export interface JiraDuplicateNudge {
  id: ID;
  ticketId: ID;
  ticketKey: string;
  ticketProjectColor: string;
  duplicateOfKey: string; // e.g. "GRW-9" — no real ticket object exists for it
}
