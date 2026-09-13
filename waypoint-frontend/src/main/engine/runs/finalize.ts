import type { RunChanged } from '../types';
import type {
  DaemonRunsApi,
  DaemonSessionSummary,
  DaemonTranscriptTurn,
} from './daemonApi';
import { isRefSafeComponent } from './worktrees';
import type {
  AgentRun,
  AgentRunStatus,
  LedgerClient,
  LedgerState,
} from './ledgerClient';
import type { NoteGitRunner } from './startRun';
import type { TranscriptKeeper } from './transcripts';
import { isDispatchedWriter } from './agentEnv';
import {
  describeRunTicket,
  pickClosingTransition,
  pickReviewTransition,
  type JiraRunDeps,
} from './jiraRuns';
import type { PublishOutcome, PullRequestPublisher } from './pullRequests';
import {
  defaultVerdict,
  isClosingVerdict,
  parseReport,
  verdictLabel,
  type Verdict,
} from './report';
import { buildRunComment, type BranchWork } from './runComment';

/**
 * Host-side finalize — W5a, ROAD-120 (docs/design/w5a-investigate-fix.md
 * §1.6, §2.4, §3.3).
 *
 * The agent never files anything. When a dispatched run's turn has ended
 * (the follower's idle fact: not generating, nothing pending, nothing
 * queued, a stop reason recorded), main reads the last assistant message
 * of the last committed turn through `acp.getHistory`, reads it as a
 * report (report.ts: a verdict, a Summary, the Details) and files the
 * board-shaped part as a comment proposal on the ticket, origin
 * `agent_run` (runComment.ts). The verdict decides the state change
 * filed beside it (W5c): a Fix that is fixed or partial proposes the
 * review state; a closing verdict — not a bug, won't fix — on either
 * verb proposes the closing state instead, and is not published. The
 * run goes `finishing → needs-review` with its verdict on the row, the
 * session is killed (its transcript is kept in the ledger), and the
 * person's Copilot conversation gets a note the ledger wrote. A turn that ended with no closing message, or in
 * error, makes the run `failed` with the reason on the row.
 *
 * Idempotent by the `finishing` status: the first writer to move the
 * run off `running` wins, every later idle fact for the same run finds
 * it elsewhere and does nothing. Every step after `finishing` is
 * best-effort in order — a proposal that could not be filed is an error
 * event and a `failed` run, never a needs-review with nothing to review.
 */
export interface FinalizeDeps {
  ledger: LedgerClient;
  daemon: () => DaemonRunsApi | null;
  /** `runs:changed` to the renderer after every status written here. */
  notify: (change: RunChanged) => void;
  /** The hardened git runner and worktree check (runsIpc.ts), for the Fix comment's file list. */
  git?: NoteGitRunner;
  assertWorktreeGitDir?: (worktreePath: string) => Promise<void>;
  /** Told after `needs-review` or `failed` lands: the notification hook (engine/notifications.ts). */
  onRunStatus?: (run: AgentRun, previous: AgentRunStatus) => void;
  /** The transcript snapshot taken before the session is killed (ROAD-124). */
  transcripts?: TranscriptKeeper;
  /** W6: pushes a writing run's branch and opens the PR before the proposals are filed. */
  pullRequests?: PullRequestPublisher;
  /** W5b: main's Jira reads, for the transition a Fix on a Jira issue proposes (runs/jiraRuns.ts). */
  jira?: JiraRunDeps;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
  /** Test seam: how long to wait before re-checking that the session is still idle. */
  confirmMs?: number;
}

/**
 * An idle fact is confirmed against a fresh session list this long later:
 * the daemon dequeues a waiting prompt in the same state change that
 * ends a turn, so the list can say "idle, nothing queued" for the instant
 * before the next turn starts (machine.ts `TurnEnded`).
 */
export const IDLE_CONFIRM_MS = 1_500;
/** The committed turns read back; the closing message is in the last. */
export const HISTORY_TURNS = 100;
/** What the ledger accepts for a proposal body. */
export const MAX_PROPOSAL_BODY = 20_000;
/** The row's one-line summary. */
export const MAX_SUMMARY_CHARS = 200;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when the session's turn has ended and nothing is waiting: the
 * follower's idle fact (§2.4). A cancelled turn is not a finished one —
 * the person stopped it from the transcript and may steer on.
 */
export function isTurnEnded(summary: DaemonSessionSummary): boolean {
  if (summary.isGenerating) return false;
  if (summary.pendingPermissionCount > 0) return false;
  if ((summary.queuedPromptCount ?? 0) > 0) return false;
  if (summary.lastTurnErrored) return true;
  const reason = summary.lastStopReason ?? null;
  return reason !== null && reason !== 'cancelled';
}

/** The last assistant message's text in the last turn that has one; null when the turn said nothing. */
export function closingMessageOf(turns: DaemonTranscriptTurn[]): string | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  let text: string | null = null;
  for (const item of last.items) {
    if (
      item.kind === 'message' &&
      (item as { role?: string }).role === 'assistant'
    ) {
      const t = String((item as { text?: unknown }).text ?? '').trim();
      if (t) text = t;
    }
  }
  return text;
}

/** The turns a person or Waypoint opened — what the row's turn count shows. */
export function countTurns(turns: DaemonTranscriptTurn[]): number {
  return turns.length;
}

/**
 * The state a finished Fix proposes moving the ticket to: one named for
 * review when the project has it, else the last `started` state (In
 * Progress on the default workflow — the ticket is being worked, and a
 * person decides the rest). Null when the project has neither.
 */
export function pickReviewState(states: LedgerState[]): LedgerState | null {
  const byOrder = [...states].sort((a, b) => a.sortOrder - b.sortOrder);
  const review = byOrder.find((s) => /review/i.test(s.name));
  if (review) return review;
  const started = byOrder.filter((s) => s.group === 'started');
  return started[started.length - 1] ?? null;
}

/** A native state name that closes a ticket without saying it was done. */
const CLOSING_STATE_NAME =
  /won'?t\s*(do|fix)|cannot\s*reproduce|can'?t\s*reproduce|not\s*a\s*bug|invalid|declined|rejected|cancel|closed|duplicate/i;

/**
 * The state a closing verdict — not a bug, won't fix — proposes moving
 * the ticket to (W5c): a `cancelled`-group state named for closing when
 * the project has one, else the first `cancelled`-group state. Never a
 * `completed` state: Done would say the ticket was fixed. Null when the
 * project has no cancelled group; the caller files only the comment.
 */
export function pickClosingState(states: LedgerState[]): LedgerState | null {
  const byOrder = [...states]
    .filter((s) => s.group === 'cancelled')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    byOrder.find((s) => CLOSING_STATE_NAME.test(s.name)) ?? byOrder[0] ?? null
  );
}

/**
 * Which state change a finished run proposes, from its verb and its
 * verdict: a Fix that is fixed or partial → the review state (as W5a); a
 * closing verdict on Investigate or Fix → the closing state; anything
 * else (a root cause found, needs a decision, *Something else…*) → none.
 */
export function statePlanFor(
  run: Pick<AgentRun, 'intent'>,
  verdict: Verdict | null,
): 'review' | 'close' | null {
  if (run.intent !== 'investigate' && run.intent !== 'fix') return null;
  if (isClosingVerdict(verdict)) return 'close';
  if (run.intent === 'fix' && (verdict === 'fixed' || verdict === 'partial')) {
    return 'review';
  }
  return null;
}

function countLines(text: string): number {
  return text.split('\n').filter((l) => l.trim().length).length;
}

/**
 * For a writing run's comment: the branch, and how many commits, files
 * and uncommitted changes are on it — counted through the hardened
 * runner, after the worktree's `.git` has been checked, the way the
 * resume note does. The listing itself is the PR body's (W6); the board
 * gets the counts. Best-effort: any failure leaves it out.
 */
async function describeBranchWork(
  deps: FinalizeDeps,
  run: AgentRun,
): Promise<BranchWork | null> {
  const cwd = run.worktreePath;
  if (!cwd || !deps.git || !deps.assertWorktreeGitDir) return null;
  try {
    await deps.assertWorktreeGitDir(cwd);
    const range =
      run.baseRef && run.baseRef.split('/').every(isRefSafeComponent)
        ? `${run.baseRef}..HEAD`
        : 'HEAD';
    const log = await deps.git(
      ['log', '--oneline', '--no-decorate', range, '--'],
      { cwd },
    );
    const files = await deps.git(
      ['diff', '--name-status', range === 'HEAD' ? 'HEAD' : run.baseRef!, '--'],
      { cwd },
    );
    const status = await deps.git(
      ['status', '--short', '--untracked-files=all', '--'],
      { cwd },
    );
    return {
      branch: run.branch ?? '(unknown)',
      baseRef: run.baseRef ?? null,
      commits: log.code === 0 ? countLines(log.stdout) : 0,
      files: files.code === 0 ? countLines(files.stdout) : 0,
      uncommitted: status.code === 0 ? countLines(status.stdout) : 0,
    };
  } catch (error) {
    deps.logger.warn('engine: finalize could not describe the branch', {
      runId: run.id,
      message: describe(error),
    });
    return null;
  }
}

const INTENT_LABEL: Record<NonNullable<AgentRun['intent']>, string> = {
  investigate: 'Investigate',
  fix: 'Fix',
  custom: 'Session',
};

function label(run: AgentRun): string {
  return (
    run.title ??
    `${run.ticketId ?? run.id} · ${run.intent ? INTENT_LABEL[run.intent] : 'Session'}`
  );
}

/** The note Copilot's conversation gets, written by the ledger's facts — never the model. */
export function finishedNote(
  run: AgentRun,
  outcome:
    | {
        turns: number;
        proposals: number;
        published?: PublishOutcome | null;
        verdict?: Verdict | null;
      }
    | { failed: string },
): string {
  if ('failed' in outcome) {
    return `Run ${label(run)} failed: ${outcome.failed}`;
  }
  const verdict = outcome.verdict
    ? ` · verdict: ${verdictLabel(outcome.verdict)}`
    : '';
  const filed =
    outcome.proposals === 0
      ? 'nothing filed'
      : outcome.proposals === 1
        ? '1 proposal filed, waiting for your review'
        : `${outcome.proposals} proposals filed, waiting for your review`;
  const pr =
    outcome.published?.kind === 'opened'
      ? ` · PR opened: ${outcome.published.url}`
      : outcome.published?.kind === 'failed'
        ? ` · the branch was not published (${outcome.published.stage} failed)`
        : '';
  return `Run ${label(run)} finished (${outcome.turns} turn${outcome.turns === 1 ? '' : 's'})${verdict} · ${filed}${pr}.`;
}

/**
 * The state change for a run on a Jira issue: the issue's live transitions
 * through main's own client, the one the plan's picker names — review
 * (`pickReviewTransition`) or closing (`pickClosingTransition`) — filed
 * as the `state_change` shape Copilot's are — `stateId` is the TRANSITION
 * id, re-checked by the backend at filing and again at approve. Answers
 * how many proposals it filed (0 or 1); a transition list Jira would not
 * give, or none that fits, is a `note` event on the run, never a guess.
 */
async function proposeJiraTransition(
  deps: FinalizeDeps,
  run: AgentRun,
  key: string,
  plan: 'review' | 'close',
): Promise<number> {
  const note = async (message: string, extra: Record<string, unknown>) => {
    deps.logger.info(`engine: finalize ${message}`, {
      runId: run.id,
      ...extra,
    });
    await deps.ledger
      .appendEvent(run.id, 'note', { stage: 'finalize', message, ...extra })
      .catch(() => {});
  };
  if (!deps.jira || !deps.jira.site()) {
    await note('filed only the comment: Jira is not connected', { key });
    return 0;
  }
  const listed = await deps.jira.listTransitions(key);
  if (!listed.ok) {
    await note('filed only the comment: the transitions could not be read', {
      key,
      reason: listed.message,
    });
    return 0;
  }
  const target =
    plan === 'close'
      ? pickClosingTransition(listed.value)
      : pickReviewTransition(listed.value);
  if (!target) {
    await note(
      plan === 'close'
        ? 'filed only the comment: no transition that closes the issue'
        : 'filed only the comment: no transition to review or in progress',
      {
        key,
        plan,
        offered: listed.value.map((t) => t.targetStateName),
      },
    );
    return 0;
  }
  const change = await deps.ledger.createRunProposal(
    run.id,
    { kind: 'state_change', stateId: target.id },
    { external: true },
  );
  await deps.ledger
    .appendEvent(run.id, 'proposal_created', {
      proposalId: change.id,
      kind: 'state_change',
      transitionId: target.id,
      stateName: target.targetStateName,
      plan,
    })
    .catch(() => {});
  return 1;
}

export interface RunFinalizer {
  /** The follower's idle fact for a session. Returns once finalize has run or declined. */
  onSessionIdle(runId: string): Promise<void>;
}

export function createRunFinalizer(deps: FinalizeDeps): RunFinalizer {
  const confirmMs = deps.confirmMs ?? IDLE_CONFIRM_MS;
  const inFlight = new Set<string>();

  const warn = (
    message: string,
    error: unknown,
    meta: Record<string, unknown> = {},
  ) => deps.logger.warn(message, { ...meta, error: describe(error) });

  const fail = async (
    run: AgentRun,
    reason: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    try {
      await deps.ledger.updateRun(run.id, {
        status: 'failed',
        reason,
        errorKind: 'finalize',
        errorMessage: clip(reason, 4000),
      });
      await deps.ledger
        .appendEvent(run.id, 'error', {
          stage: 'finalize',
          message: reason,
          ...detail,
        })
        .catch(() => {});
    } catch (error) {
      warn('engine: finalize could not record the failure', error, {
        runId: run.id,
      });
      return;
    }
    deps.notify({ runId: run.id, status: 'failed' });
    deps.onRunStatus?.({ ...run, status: 'failed' }, run.status);
    await deps.ledger
      .postCopilotNote(run.id, finishedNote(run, { failed: reason }))
      .catch((error: unknown) =>
        warn('engine: Copilot note not posted', error, { runId: run.id }),
      );
  };

  const killSession = async (
    daemon: DaemonRunsApi,
    run: AgentRun,
    turns?: DaemonTranscriptTurn[],
  ): Promise<void> => {
    // The transcript first: after the kill the daemon has nothing to read.
    await deps.transcripts?.capture(run.id, turns);
    await daemon.killSession(run.id).catch((error: unknown) =>
      warn('engine: finalize could not kill the session', error, {
        runId: run.id,
      }),
    );
    await deps.ledger
      .appendEvent(run.id, 'session_ended', { reason: 'finalized' })
      .catch(() => {});
  };

  const finalize = async (runId: string): Promise<void> => {
    const daemon = deps.daemon();
    if (!daemon) return;
    let run = await deps.ledger.getRun(runId);
    if (!run || run.entry !== 'dispatched' || run.status !== 'running') return;

    // Confirm against a fresh list: still idle after the dequeue window.
    if (confirmMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, confirmMs).unref?.();
      });
    }
    const sessions = await daemon.listSessions();
    const summary = sessions[runId];
    if (!summary || !isTurnEnded(summary)) return;
    run = await deps.ledger.getRun(runId);
    if (!run || run.status !== 'running') return;

    // The claim: whoever moves the run to `finishing` finalizes it.
    try {
      run = await deps.ledger.updateRun(run.id, {
        status: 'finishing',
        reason: 'The turn ended',
      });
    } catch (error) {
      warn('engine: finalize lost the claim', error, { runId });
      return;
    }
    deps.notify({ runId: run.id, status: run.status });

    if (summary.lastTurnErrored) {
      await fail(run, "The agent's turn ended in an error.", {
        stopReason: summary.lastStopReason ?? null,
      });
      await killSession(daemon, run);
      return;
    }

    let turns: DaemonTranscriptTurn[];
    try {
      turns = await daemon.getHistory(run.id, HISTORY_TURNS);
    } catch (error) {
      await fail(
        run,
        `The session's history could not be read: ${describe(error)}`,
      );
      await killSession(daemon, run);
      return;
    }
    const closing = closingMessageOf(turns);
    if (!closing) {
      await fail(run, 'The agent ended its turn without a closing message.', {
        stopReason: summary.lastStopReason ?? null,
      });
      await killSession(daemon, run, turns);
      return;
    }

    // The report (W5c): the verdict the session named, else the verb's
    // default; the Summary is what the board gets.
    const report = parseReport(closing);
    const verdict = report.verdict ?? defaultVerdict(run.intent);
    const closes = isClosingVerdict(verdict);

    // The run's ticket — a native ticket, or a Jira issue's handle (W5b):
    // its label for the PR, and which write path its proposals take.
    const ticket = await describeRunTicket(deps.ledger, run.ticketId);
    const external = ticket?.external === true;

    // W6: a writing run's branch is pushed and its PR opened first — by
    // the host, as the person — so the comment can lead with the link.
    // A failure here is a sentence on the comment and an event, never a
    // failed run: the session's work is done and on its branch. A closing
    // verdict is not published: a won't-fix pull request is noise for the
    // team, and the branch stays in the worktree for whoever wants it.
    let published: PublishOutcome | null = null;
    let notPublishedBecause: string | null = null;
    if (closes && deps.pullRequests && isDispatchedWriter(run) && run.branch) {
      notPublishedBecause = `the session's verdict was ${verdictLabel(verdict!)}`;
      await deps.ledger
        .appendEvent(run.id, 'note', {
          stage: 'finalize',
          message: `not published: ${notPublishedBecause}`,
          verdict,
        })
        .catch(() => {});
    } else if (deps.pullRequests && isDispatchedWriter(run) && run.branch) {
      published = await deps.pullRequests.publish({
        run,
        closingMessage: closing,
        title: ticket
          ? `${ticket.identifier}: ${ticket.title}`
          : (run.title ?? run.branch),
        ticketUrl: ticket?.url ?? null,
      });
      if (published.kind === 'opened') run = { ...run, prUrl: published.url };
    }

    // The proposals: the board-shaped comment (the verdict, the Summary,
    // and the host's facts about the branch and the PR), and the state
    // change the verdict calls for.
    let filed = 0;
    try {
      const work = isDispatchedWriter(run)
        ? await describeBranchWork(deps, run)
        : null;
      const body = buildRunComment({
        report,
        verdict,
        runLabel: label(run),
        work,
        published,
        notPublishedBecause,
      });
      // A Jira issue's proposals carry the borrowed credential, so the
      // backend can read the issue live and build the external-write card
      // — the path Copilot's own Jira proposals take (W5b §2.4).
      const comment = await deps.ledger.createRunProposal(
        run.id,
        {
          kind: 'comment',
          body: clip(body, MAX_PROPOSAL_BODY),
        },
        { external },
      );
      filed += 1;
      await deps.ledger
        .appendEvent(run.id, 'proposal_created', {
          proposalId: comment.id,
          kind: 'comment',
        })
        .catch(() => {});
      const plan = statePlanFor(run, verdict);
      if (plan && external && ticket?.ref) {
        // W5b §2.6: a transition the issue offers now, picked by name —
        // review, else in progress; or, for a closing verdict, one that
        // closes. None → the comment alone, and the trail says which
        // transitions the issue did offer.
        filed += await proposeJiraTransition(deps, run, ticket.ref.key, plan);
      } else if (plan && run.projectId) {
        const states = await deps.ledger.listStates(run.projectId);
        const target =
          plan === 'close' ? pickClosingState(states) : pickReviewState(states);
        if (target) {
          const change = await deps.ledger.createRunProposal(run.id, {
            kind: 'state_change',
            stateId: target.id,
          });
          filed += 1;
          await deps.ledger
            .appendEvent(run.id, 'proposal_created', {
              proposalId: change.id,
              kind: 'state_change',
              stateId: target.id,
              stateName: target.name,
              plan,
            })
            .catch(() => {});
        } else {
          deps.logger.info(
            `engine: finalize found no ${plan === 'close' ? 'closing' : 'review'} state to propose`,
            {
              runId: run.id,
              projectId: run.projectId,
            },
          );
          await deps.ledger
            .appendEvent(run.id, 'note', {
              stage: 'finalize',
              message:
                plan === 'close'
                  ? 'filed only the comment: the project has no state that closes a ticket without completing it'
                  : 'filed only the comment: the project has no review or started state',
              plan,
              offered: states.map((s) => s.name),
            })
            .catch(() => {});
        }
      }
    } catch (error) {
      await fail(run, `The proposal could not be filed: ${describe(error)}`, {
        filed,
      });
      await killSession(daemon, run, turns);
      return;
    }

    const turnCount = countTurns(turns);
    let reviewed: AgentRun;
    try {
      const headline = report.summary || closing;
      reviewed = await deps.ledger.updateRun(run.id, {
        status: 'needs-review',
        reason: `${filed} proposal${filed === 1 ? '' : 's'} filed`,
        summary: clip(
          headline.split('\n').find((l) => l.trim()) ?? headline,
          MAX_SUMMARY_CHARS,
        ),
        verdict,
        turnCount,
      });
    } catch (error) {
      warn('engine: finalize could not write needs-review', error, {
        runId: run.id,
      });
      await killSession(daemon, run, turns);
      return;
    }
    deps.notify({ runId: run.id, status: reviewed.status });
    deps.logger.info('engine: run finalized', {
      runId: run.id,
      intent: run.intent,
      verdict,
      proposals: filed,
      turns: turnCount,
    });
    await killSession(daemon, run, turns);
    deps.onRunStatus?.(reviewed, 'finishing');
    await deps.ledger
      .postCopilotNote(
        run.id,
        finishedNote(reviewed, {
          turns: turnCount,
          proposals: filed,
          published,
          verdict,
        }),
      )
      .catch((error: unknown) =>
        warn('engine: Copilot note not posted', error, { runId: run.id }),
      );
  };

  return {
    async onSessionIdle(runId) {
      if (inFlight.has(runId)) return;
      inFlight.add(runId);
      try {
        await finalize(runId);
      } catch (error) {
        warn('engine: finalize failed', error, { runId });
      } finally {
        inFlight.delete(runId);
      }
    },
  };
}
