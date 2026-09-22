import type { PublishOutcome } from './pullRequests';
import {
  MAX_VERIFICATION_CHARS,
  verdictLabel,
  type Report,
  type Verdict,
} from './report';

/**
 * The comment a finished run files on its ticket — W5c, the PM's first
 * path-to-8 item ("board-shaped"), trimmed in customer-feedback round 1
 * (Fix 4) to what a ticket's readers asked for: the session's Summary,
 * what it verified, the pull request when there is one, and where the
 * rest lives. Nothing engineer-shaped — no verdict tag (the paired state
 * change says it), no branch name, commit or file counts, no "not pushed"
 * or "the push failed" — those are the host's facts and stay with the run
 * in Waypoint (the `finalized` event's `work` and `pr`), never on the
 * board. A run without a pull request simply has no PR line.
 *
 * S5 (PR #88 review): "the paired state change says it" is only true when
 * there IS a paired state change — `statePlanFor` (finalize.ts) returns
 * null for `root-cause` and `needs-info` on every intent, and for every
 * custom-intent run regardless of verdict. Those runs propose no state
 * change at all, so with no verdict tag either the ticket got a summary
 * with no sign the session only found a cause, or is stuck wanting a
 * decision. `buildRunComment` takes the plan the caller already computed
 * (statePlanFor, before this is ever called) and adds the verdict tag
 * back only for that one gap — a planned state change still carries it
 * alone, unchanged.
 *
 * Pure; table-tested.
 */

/**
 * Mirrors finalize.ts's own `StatePlan` — duplicated, not imported, so
 * this module (report.ts, pullRequests.ts only) never has to import from
 * finalize.ts, which imports THIS module.
 */
export type RunCommentStatePlan = 'review' | 'close' | 'complete';

/** What git says about the run's branch, counted by the host. */
export interface BranchWork {
  branch: string;
  baseRef: string | null;
  commits: number;
  /** Files changed against the base — commits and the working tree. */
  files: number;
  /** Uncommitted changes the session left in the worktree. */
  uncommitted: number;
}

export interface RunCommentInput {
  report: Report;
  /** How the run is named in Waypoint's Sessions view, for the footer. */
  runLabel: string;
  /** W6's outcome, when the host tried to publish; null when it did not. */
  published: PublishOutcome | null;
  /**
   * S5: the EFFECTIVE verdict — `report.verdict`, or the verb's default
   * when the agent named none (finalize.ts's own `defaultVerdict`) — and
   * the state plan it maps to (`statePlanFor`, called with this exact
   * value). Not `report.verdict` alone: a first-ever finalize applies
   * the default when the closing message named no verdict, so
   * `report.verdict` can be null while the effective verdict, and its
   * plan, are not — passed separately so this module never has to
   * reimplement that default itself.
   */
  verdict: Verdict | null;
  /** null when finalize will propose no state change for `verdict` at all. */
  plan: RunCommentStatePlan | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "Branch `agent/ENG-77` from `main` · 2 commits · 4 files changed" — the
 * run's own facts line in Waypoint; no longer part of the ticket comment.
 */
export function describeWork(work: BranchWork): string {
  const parts = [
    `Branch \`${work.branch}\`${work.baseRef ? ` from \`${work.baseRef}\`` : ''}`,
    plural(work.commits, 'commit'),
  ];
  if (work.files > 0) parts.push(`${plural(work.files, 'file')} changed`);
  if (work.uncommitted > 0) {
    parts.push(`${plural(work.uncommitted, 'uncommitted change')}`);
  }
  return parts.join(' · ');
}

/**
 * The pull request line: opened by this run, updated by a follow-up, or
 * — S4, PR #88 review — honestly absent when a push was actually
 * attempted and did not produce one (`failed`, or `pushed-only` — the
 * branch went up but `gh pr create` did not). Before this, both of those
 * read exactly like `skipped`: no line at all, so a Fix whose push
 * failed filed a comment that looked like finished work, paired with a
 * state change to review. Fix 4's own deviation still holds for all
 * three of `failed`/`pushed-only`/`skipped` alike — the REASON (a push
 * failure's message, why nothing was pushed) is the run's business and
 * stays off the ticket (the `finalized` event's `pr` fact, and the note
 * on the run, carry it); this says only that there is no PR yet, or, for
 * `skipped`, says nothing — a closing verdict or "nothing to publish" is
 * not a broken push, and already reads correctly with no line at all.
 */
function pullRequestLine(published: PublishOutcome | null): string | null {
  if (!published) return null;
  switch (published.kind) {
    case 'opened':
      return `Pull request: ${published.url}`;
    case 'updated':
      return `Pull request updated: ${published.url}`;
    case 'failed':
    case 'pushed-only':
      return 'No pull request yet — the branch was not published; the details are on the run in Waypoint.';
    default:
      return null;
  }
}

/** The comment body, markdown. */
export function buildRunComment(input: RunCommentInput): string {
  const blocks: string[] = [];
  // S5: only when there is no paired state change to say it instead —
  // root-cause, needs-info, or any custom-intent run's verdict. First,
  // so a reader scanning the ticket sees immediately that this is a
  // finding or a decision waiting on them, not a plain status update.
  if (input.plan === null && input.verdict) {
    blocks.push(`**Verdict:** ${verdictLabel(input.verdict)}`);
  }
  const summary = input.report.summary.trim();
  if (summary) blocks.push(summary);
  // A session asked to verify in the browser reports what it drove; that
  // is the "visual proof" a ticket's readers asked for, so it goes on the
  // ticket — bounded, with the screenshots themselves on the run.
  const verification = input.report.verification?.trim();
  if (verification) {
    const text =
      verification.length > MAX_VERIFICATION_CHARS
        ? `${verification.slice(0, MAX_VERIFICATION_CHARS - 1)}…`
        : verification;
    blocks.push(`**Verification**\n${text}`);
  }
  const pr = pullRequestLine(input.published);
  if (pr) blocks.push(pr);

  // `*…*`, not `_…_`: the one emphasis every renderer of this body reads
  // (renderer lib/markdown.ts, backend lib/markdownHtml.ts and the Jira
  // ADF builder's inlineToAdf).
  blocks.push(
    `*Full report — the evidence, files and how it was verified — is on the run in Waypoint (${input.runLabel}).*`,
  );
  return blocks.join('\n\n');
}
