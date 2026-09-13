import type { PublishOutcome } from './pullRequests';
import { verdictLabel, type Report, type Verdict } from './report';

/**
 * The comment a finished run files on its ticket — W5c, the PM's first
 * path-to-8 item ("board-shaped"): a ticket's readers get the verdict,
 * the session's Summary, and the host's facts about the branch and the
 * pull request; the evidence and the file list stay with the run (its
 * transcript, and the PR body a reviewer reads there).
 *
 * The host's facts lead and come from the ledger and git, never the
 * model — a session told the host publishes cannot contradict a line it
 * did not write. Pure; table-tested.
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
  /** The verdict finalize settled on: the report's, else the verb's default. */
  verdict: Verdict | null;
  /** How the run is named in Waypoint's Sessions view, for the footer. */
  runLabel: string;
  /** A writing run's branch, as the host read it; null for a read-only run or when git could not say. */
  work: BranchWork | null;
  /** W6's outcome, when the host tried to publish; null when it did not. */
  published: PublishOutcome | null;
  /** Why the host did not publish, when it chose not to (a closing verdict). */
  notPublishedBecause?: string | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Branch `agent/ENG-77` from `main` · 2 commits · 4 files changed" */
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

function publishLine(input: RunCommentInput): string | null {
  const { published } = input;
  if (published) {
    switch (published.kind) {
      case 'opened':
        return `Pull request: ${published.url}`;
      case 'pushed-only':
      case 'skipped':
        return published.reason;
      case 'failed':
        return `Not published — the ${published.stage === 'push' ? 'push' : 'pull request'} failed: ${published.message}`;
      default:
        return null;
    }
  }
  if (input.notPublishedBecause)
    return `Not published: ${input.notPublishedBecause}`;
  return null;
}

/** The comment body, markdown. */
export function buildRunComment(input: RunCommentInput): string {
  const blocks: string[] = [];
  if (input.verdict) blocks.push(`**Verdict:** ${verdictLabel(input.verdict)}`);
  const summary = input.report.summary.trim();
  if (summary) blocks.push(summary);

  const facts = [
    input.work ? describeWork(input.work) : null,
    publishLine(input),
  ].filter((l): l is string => !!l);
  if (facts.length) blocks.push(facts.join('\n'));

  blocks.push(
    `_Full report — the evidence, files and how it was verified — is on the run in Waypoint (${input.runLabel})._`,
  );
  return blocks.join('\n\n');
}
