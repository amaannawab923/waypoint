import type { PublishOutcome } from './pullRequests';
import { MAX_VERIFICATION_CHARS, type Report } from './report';

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
 * Pure; table-tested.
 */

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
 * The pull request line, only when a pull request exists: opened by this
 * run, or updated by a follow-up. A push that failed, a push without a
 * PR, or a closing verdict the host chose not to publish all read the
 * same to the ticket — no line — and say why on the run instead.
 */
function pullRequestLine(published: PublishOutcome | null): string | null {
  if (!published) return null;
  switch (published.kind) {
    case 'opened':
      return `Pull request: ${published.url}`;
    case 'updated':
      return `Pull request updated: ${published.url}`;
    default:
      return null;
  }
}

/** The comment body, markdown. */
export function buildRunComment(input: RunCommentInput): string {
  const blocks: string[] = [];
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
