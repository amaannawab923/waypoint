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
  pickReviewTransition,
  type JiraRunDeps,
} from './jiraRuns';
import {
  describePublish,
  type PublishOutcome,
  type PullRequestPublisher,
} from './pullRequests';

/**
 * Host-side finalize — W5a, ROAD-120 (docs/design/w5a-investigate-fix.md
 * §1.6, §2.4, §3.3).
 *
 * The agent never files anything. When a dispatched run's turn has ended
 * (the follower's idle fact: not generating, nothing pending, nothing
 * queued, a stop reason recorded), main reads the last assistant message
 * of the last committed turn through `acp.getHistory` and files it as a
 * comment proposal on the ticket, origin `agent_run`; for a Fix, also the
 * state change to the project's review state. The run goes `finishing →
 * needs-review`, the session is killed (its transcript stays in the
 * daemon's history), and the person's Copilot conversation gets a note
 * the ledger wrote. A turn that ended with no closing message, or in
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

const MAX_LIST_LINES = 40;

function firstLines(text: string, max: number): string {
  const lines = text
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => l.length);
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more)`;
}

/**
 * For a Fix comment: the branch, the commits on it since the base, and
 * the files still uncommitted — through the hardened runner, after the
 * worktree's `.git` has been checked, the way the resume note does.
 * Best-effort: any failure leaves it out.
 */
async function describeBranchWork(
  deps: FinalizeDeps,
  run: AgentRun,
): Promise<string | null> {
  const cwd = run.worktreePath;
  if (!cwd || !deps.git || !deps.assertWorktreeGitDir) return null;
  try {
    await deps.assertWorktreeGitDir(cwd);
    const range =
      run.baseRef && run.baseRef.split('/').every(isRefSafeComponent)
        ? `${run.baseRef}..HEAD`
        : 'HEAD';
    const log = await deps.git(
      [
        'log',
        '--oneline',
        '--no-decorate',
        `-n${MAX_LIST_LINES + 1}`,
        range,
        '--',
      ],
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
    const lines = [
      `Branch \`${run.branch ?? '(unknown)'}\`${run.baseRef ? ` from \`${run.baseRef}\`` : ''}, in the run's worktree.`,
    ];
    const commits =
      log.code === 0 ? firstLines(log.stdout, MAX_LIST_LINES) : '';
    lines.push('', 'Commits:', commits || '(none)');
    const changed =
      files.code === 0 ? firstLines(files.stdout, MAX_LIST_LINES) : '';
    if (changed) lines.push('', 'Files changed:', changed);
    const dirty =
      status.code === 0 ? firstLines(status.stdout, MAX_LIST_LINES) : '';
    if (dirty) lines.push('', 'Uncommitted:', dirty);
    return lines.join('\n');
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
    | { turns: number; proposals: number; published?: PublishOutcome | null }
    | { failed: string },
): string {
  if ('failed' in outcome) {
    return `Run ${label(run)} failed: ${outcome.failed}`;
  }
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
  return `Run ${label(run)} finished (${outcome.turns} turn${outcome.turns === 1 ? '' : 's'}) · ${filed}${pr}.`;
}

/**
 * The state change for a Fix on a Jira issue: the issue's live transitions
 * through main's own client, the one `pickReviewTransition` names, filed
 * as the `state_change` shape Copilot's are — `stateId` is the TRANSITION
 * id, re-checked by the backend at filing and again at approve. Answers
 * how many proposals it filed (0 or 1); a transition list Jira would not
 * give, or none that fits, is a `note` event on the run, never a guess.
 */
async function proposeJiraTransition(
  deps: FinalizeDeps,
  run: AgentRun,
  key: string,
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
  const target = pickReviewTransition(listed.value);
  if (!target) {
    await note(
      'filed only the comment: no transition to review or in progress',
      {
        key,
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

    // The run's ticket — a native ticket, or a Jira issue's handle (W5b):
    // its label for the PR, and which write path its proposals take.
    const ticket = await describeRunTicket(deps.ledger, run.ticketId);
    const external = ticket?.external === true;

    // W6: a writing run's branch is pushed and its PR opened first — by
    // the host, as the person — so the comment can lead with the link.
    // A failure here is a sentence on the comment and an event, never a
    // failed run: the session's work is done and on its branch.
    let published: PublishOutcome | null = null;
    if (deps.pullRequests && isDispatchedWriter(run) && run.branch) {
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

    // The proposals: the closing message as a comment (a writing run's
    // led by its pull request and the branch's work), and for a Fix the
    // state change.
    let filed = 0;
    try {
      let body = closing;
      if (isDispatchedWriter(run)) {
        const work = await describeBranchWork(deps, run);
        const lead = [published ? describePublish(published) : null, work]
          .filter(Boolean)
          .join('\n\n');
        if (lead) body = `${lead}\n\n---\n\n${closing}`;
      }
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
      if (run.intent === 'fix' && external && ticket?.ref) {
        // W5b §2.6: a transition the issue offers now, picked by name —
        // review, else in progress. None → the comment alone, and the
        // trail says which transitions the issue did offer.
        filed += await proposeJiraTransition(deps, run, ticket.ref.key);
      } else if (run.intent === 'fix' && run.projectId) {
        const states = await deps.ledger.listStates(run.projectId);
        const target = pickReviewState(states);
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
            })
            .catch(() => {});
        } else {
          deps.logger.info(
            'engine: finalize found no review state to propose',
            {
              runId: run.id,
              projectId: run.projectId,
            },
          );
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
      reviewed = await deps.ledger.updateRun(run.id, {
        status: 'needs-review',
        reason: `${filed} proposal${filed === 1 ? '' : 's'} filed`,
        summary: clip(
          closing.split('\n').find((l) => l.trim()) ?? closing,
          MAX_SUMMARY_CHARS,
        ),
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
