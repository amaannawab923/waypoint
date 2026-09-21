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
import { isResumeNoteText, type NoteGitRunner } from './startRun';
import { LedgerRequestError } from './ledgerClient';
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
  /**
   * W6, ROAD-131: proves a run's cwd (`worktreePath ?? cwd`, the same
   * derivation `pullRequests.ts`'s own `publish` makes) before this file
   * ever pushes a branch or opens a PR in it — the same gate
   * `runsIpc.ts`'s retry button applies, shared so the two can never
   * check a different path than the one git actually runs in. Required,
   * not optional like the read-only `assertWorktreeGitDir` above: a
   * missing dep here must refuse the push, not skip the check.
   */
  assertPublishableCwd: (run: AgentRun) => Promise<string>;
  /** Told after `needs-review` or `failed` lands: the notification hook (engine/notifications.ts). */
  onRunStatus?: (run: AgentRun, previous: AgentRunStatus) => void;
  /** The transcript snapshot taken before the session is killed (ROAD-124). */
  transcripts?: TranscriptKeeper;
  /** W6: pushes a writing run's branch and opens the PR before the proposals are filed. */
  pullRequests?: PullRequestPublisher;
  /** W5b: main's Jira reads, for the transition a Fix on a Jira issue proposes (runs/jiraRuns.ts). */
  jira?: JiraRunDeps;
  /**
   * Never-lock: the per-ticket lock a follow-up publish runs under
   * (dispatch.ts's withTicketDispatchLock), so two finalizes on one
   * ticket in one Waypoint can't both push. The backend's publish claim
   * is the cross-process half (design §3.3b).
   */
  withTicketLock?: <T>(ticketId: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Never-lock: deliver the run's outbox once the row is settled — the
   * last step of REST and FILE (design §4.4), for a message typed while
   * finalize held the row (`finishing`). sendPrompt.ts's
   * deliverPendingAfterFinalize; reopens the run if it must.
   */
  drainOutbox?: (runId: string) => Promise<void>;
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
/** The first user message of the last turn — what that turn was asked. */
export function openingPromptOf(turns: DaemonTranscriptTurn[]): string {
  const last = turns[turns.length - 1];
  if (!last) return '';
  const item = last.items.find(
    (i) => i.kind === 'message' && i.role === 'user',
  );
  return item && typeof item.text === 'string' ? item.text : '';
}

/** The last committed turn's id — where a marker for this finalize anchors (design §5.2). */
export function lastTurnId(turns: DaemonTranscriptTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last?.id ?? null;
}

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
        /** Never-lock: a continued run's later report, the nth filed. */
        followUp?: number;
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
  let pr = '';
  if (outcome.published?.kind === 'opened')
    pr = ` · PR opened: ${outcome.published.url}`;
  else if (outcome.published?.kind === 'updated')
    pr = ` · PR updated: ${outcome.published.url}`;
  else if (
    outcome.published?.kind === 'skipped' ||
    outcome.published?.kind === 'pushed-only'
  )
    // Found in review, round 3: this line used to only show for a
    // follow-up (`&& outcome.followUp`) — harmless while a first-ever
    // publish could only ever come back 'opened'/'updated'/'failed', but
    // now that it also takes the same publish claim as a follow-up
    // (claimAndPublish, above), a first publish can genuinely come back
    // 'skipped' too (another run holds the ticket's claim) — and this
    // note would otherwise say nothing about why.
    pr = ` · ${outcome.published.reason}`;
  else if (outcome.published?.kind === 'failed')
    pr = ` · the branch was not published (${outcome.published.stage} failed)`;
  const what = outcome.followUp
    ? `filed follow-up ${outcome.followUp} (${outcome.turns} turn${outcome.turns === 1 ? '' : 's'} so far)`
    : `finished (${outcome.turns} turn${outcome.turns === 1 ? '' : 's'})`;
  return `Run ${label(run)} ${what}${verdict} · ${filed}${pr}.`;
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

  /**
   * The outbox, once the row is settled — the last step of every way a
   * run leaves `finishing` (design §4.4): REST, FILE, and (round 5 of
   * review, found missing on every first-finalize failure branch) a run
   * that failed. A message typed while finalize held the row is not the
   * finalize's fault, and `failed` is revivable: deliverPendingAfterFinalize
   * resumes the run for it if it must. Never throws.
   */
  const drainOutbox = async (runId: string, after: string): Promise<void> => {
    await deps
      .drainOutbox?.(runId)
      .catch((error: unknown) =>
        warn(`engine: outbox drain after ${after} failed`, error, { runId }),
      );
  };

  /**
   * A run that cannot be finalized is `failed` — visible, revivable, with
   * the reason on the row — never left at `finishing`. Any session kill
   * belongs BEFORE this call: the drain at the end may resume the run to
   * deliver a waiting message, and a kill after it would take that new
   * session down.
   */
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
    await drainOutbox(run.id, 'a failed finalize');
  };

  /**
   * THE way a run leaves `finishing` for a settled status — needs-review
   * or done. Three review rounds each found a hand-written copy of this
   * tail that, on a failed write, warned and returned: the run stayed at
   * `finishing`, a status nothing revives and reconcile treats as live.
   * One copy now. A write that fails falls back to `fail()` — revivable,
   * and it drains the outbox itself — and answers null; a write that
   * lands is notified and answered, and the caller finishes its own
   * bookkeeping, draining the outbox last.
   */
  const settle = async (
    run: AgentRun,
    patch: Parameters<LedgerClient['updateRun']>[1],
    onFailure: { reason: string; detail?: Record<string, unknown> },
  ): Promise<AgentRun | null> => {
    let settled: AgentRun;
    try {
      settled = await deps.ledger.updateRun(run.id, patch);
    } catch (error) {
      warn('engine: finalize could not write the final status', error, {
        runId: run.id,
        status: patch.status,
      });
      await fail(run, `${onFailure.reason}: ${describe(error)}`, {
        stage: 'final-write',
        ...onFailure.detail,
      });
      return null;
    }
    deps.notify({ runId: run.id, status: settled.status });
    return settled;
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

  /** The branch HEAD, through the hardened runner, after the worktree check; null for a run without one or when git could not say. */
  const headShaOf = async (run: AgentRun): Promise<string | null> => {
    const cwd = run.worktreePath ?? run.cwd;
    if (
      !cwd ||
      !deps.git ||
      !deps.assertWorktreeGitDir ||
      run.isolation === 'directory'
    )
      return null;
    try {
      await deps.assertWorktreeGitDir(cwd);
      const out = await deps.git(['rev-parse', 'HEAD'], { cwd });
      const sha = out.stdout.trim();
      return out.code === 0 && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  };

  /** Commits on the branch past what the last report was filed at; null when it cannot be told. */
  const newCommitsSince = async (
    run: AgentRun,
    since: string | null,
  ): Promise<number | null> => {
    const cwd = run.worktreePath ?? run.cwd;
    if (!since || !cwd || !deps.git || run.isolation === 'directory')
      return null;
    try {
      const out = await deps.git(
        ['rev-list', '--count', `${since}..HEAD`, '--'],
        { cwd },
      );
      const n = Number(out.stdout.trim());
      return out.code === 0 && Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };

  /**
   * REST (design §4.4): the turn was conversation, not a report. The run
   * goes back to needs-review if it still has open proposals, else done;
   * summary/verdict untouched; nothing filed, nothing published. Then the
   * outbox — a message typed while finalize held the row — is delivered.
   */
  const rest = async (
    run: AgentRun,
    reason: string,
    detail: Record<string, unknown>,
    turns?: DaemonTranscriptTurn[],
  ): Promise<void> => {
    let open = 0;
    if (run.ticketId) {
      try {
        const proposals = await deps.ledger.listTicketProposals(run.ticketId);
        open = proposals.filter(
          (p) =>
            p.agentRunId === run.id &&
            (p.status === 'proposed' || p.status === 'executing'),
        ).length;
      } catch (error) {
        warn('engine: rest could not read the ticket proposals', error, {
          runId: run.id,
        });
      }
    }
    const status: AgentRunStatus = open > 0 ? 'needs-review' : 'done';
    const rested = await settle(
      run,
      {
        status,
        reason: `Turn ended; nothing to file (${reason})`,
        ...(turns ? { turnCount: countTurns(turns) } : {}),
      },
      { reason: 'Could not record that the turn was conversation' },
    );
    if (!rested) return;
    if (Object.keys(detail).length || /error|could not/i.test(reason)) {
      await deps.ledger
        .appendEvent(run.id, 'note', {
          stage: 'finalize',
          rest: reason,
          ...detail,
        })
        .catch(() => {});
    }
    deps.logger.info('engine: run rested', { runId: run.id, status, reason });
    if (turns) await deps.transcripts?.capture(run.id, turns);
    await drainOutbox(run.id, 'rest');
  };

  const prFact = (
    published: PublishOutcome | null,
    notPublishedBecause: string | null,
  ): Record<string, unknown> => {
    if (published?.kind === 'opened' || published?.kind === 'updated') {
      return { action: published.kind, url: published.url };
    }
    if (published?.kind === 'failed')
      return { action: 'failed', reason: published.message };
    if (published?.kind === 'skipped' || published?.kind === 'pushed-only') {
      return { action: 'skipped', reason: published.reason };
    }
    if (notPublishedBecause)
      return { action: 'skipped', reason: notPublishedBecause };
    return { action: 'none' };
  };

  /** The summary the last `finalized` event carried, for the duplicate check. */
  const lastFinalizedSummary = async (
    runId: string,
  ): Promise<string | null> => {
    try {
      const events = await deps.ledger.listEvents(runId);
      const last = [...events].reverse().find((e) => e.kind === 'finalized');
      const summary = last?.payload.summary;
      return typeof summary === 'string' ? summary : null;
    } catch {
      return null;
    }
  };

  /**
   * Claim the ticket's publish slot (§3.3b), then attempt the push/PR
   * under it — every failure, claim or push, becomes a `PublishOutcome`,
   * never a throw. A publish problem is a sentence on the comment and an
   * event, never a stuck run (found in review, round 3: this used to
   * only catch the claim's 409 case; any other claim failure — a
   * timeout, a 5xx — propagated uncaught past the caller's
   * `withTicketLock`, wedging the run at `finishing` forever, since
   * nothing re-finalizes a run that already left `running`). Shared by
   * both the first-ever publish and every follow-up's, which used to
   * diverge here: only the follow-up path took this claim at all (found
   * in review, round 3) — a run's first publish went straight to
   * `push()` with no ticket-level coordination, so two runs finalizing
   * for the first time on the same ticket at once could each open a
   * competing PR.
   */
  const claimAndPublish = async (
    run: AgentRun,
    headSha: string | null,
    push: () => Promise<PublishOutcome>,
  ): Promise<PublishOutcome> => {
    try {
      await deps.ledger.claimPublish(run.id, headSha);
    } catch (error) {
      if (error instanceof LedgerRequestError && error.status === 409) {
        await deps.ledger
          .appendEvent(run.id, 'note', {
            stage: 'finalize',
            publish: 'skipped',
            claim: 'refused',
            reason: error.message,
          })
          .catch(() => {});
        return {
          kind: 'skipped',
          reason: `${error.message} Open PR from the run header, or ask the agent to summarize its changes again.`,
        };
      }
      deps.logger.warn('engine: could not claim the publish', {
        runId: run.id,
        message: describe(error),
      });
      return {
        kind: 'failed',
        stage: 'push',
        message: `Could not claim the publish for this ticket: ${describe(error)}`,
      };
    }
    try {
      await deps.assertPublishableCwd(run);
      return await push();
    } catch (error) {
      deps.logger.warn('engine: publish failed', {
        runId: run.id,
        message: describe(error),
      });
      return { kind: 'failed', stage: 'push', message: describe(error) };
    }
  };

  /**
   * FOLLOW-UP (design §4.3): a continued run's turn ends. File iff the
   * closing message carries an explicit `Verdict:` AND a `## Summary`
   * heading — a verdict word alone is conversation that mentioned one
   * (customer feedback round 1: a reply quoting the old report's
   * `Verdict:` line was filed and reached Review); the verb's default
   * verdict is NOT applied. Commits are for the marker, never the
   * trigger. A duplicate of the last filed summary is conversation.
   */
  const finalizeFollowUp = async (
    run: AgentRun,
    turns: DaemonTranscriptTurn[],
    closing: string,
  ): Promise<void> => {
    const report = parseReport(closing);
    const headSha = await headShaOf(run);
    const newCommits = await newCommitsSince(run, run.finalizedHeadSha);
    const lastSummary = await lastFinalizedSummary(run.id);
    const duplicate =
      report.verdict !== null &&
      lastSummary !== null &&
      report.summary.trim() === lastSummary.trim();

    const verdictWithoutSummary =
      report.verdict !== null && !report.hasSummaryHeading;
    if (report.verdict === null || verdictWithoutSummary || duplicate) {
      if ((newCommits ?? 0) > 0) {
        await deps.ledger
          .appendEvent(run.id, 'note', {
            stage: 'finalize',
            unpublishedCommits: newCommits,
            headSha,
            afterTurnId: lastTurnId(turns),
          })
          .catch(() => {});
      }
      // A verdict word with no Summary heading gets a note the transcript
      // shows (markerFold.ts), so a reviewer sees why nothing was filed.
      await rest(
        run,
        verdictWithoutSummary
          ? 'Verdict line found without a Summary — treated as conversation'
          : duplicate
            ? 'The report repeated the last one'
            : 'No report in the closing message',
        verdictWithoutSummary
          ? {
              suppressed: 'verdict-without-summary',
              afterTurnId: lastTurnId(turns),
            }
          : {},
        turns,
      );
      return;
    }

    const { verdict } = report;
    const closes = isClosingVerdict(verdict);
    // The row as this finalize knows it; a publish may set its PR.
    let current: AgentRun = run;
    const ticket = await describeRunTicket(deps.ledger, run.ticketId);
    const external = ticket?.external === true;
    const sequence = run.finalizeCount + 1;

    let published: PublishOutcome | null = null;
    let notPublishedBecause: string | null = null;
    const wantsPublish =
      !closes &&
      (newCommits ?? 0) > 0 &&
      deps.pullRequests &&
      isDispatchedWriter(run) &&
      run.branch;
    if (closes && isDispatchedWriter(run) && run.branch) {
      notPublishedBecause = `the session's verdict was ${verdictLabel(verdict)}`;
    } else if (wantsPublish && deps.pullRequests) {
      const push = () =>
        deps.pullRequests!.publishFollowUp({
          run,
          closingMessage: closing,
          title: ticket
            ? `${ticket.identifier}: ${ticket.title}`
            : (run.title ?? run.branch!),
          ticketUrl: ticket?.url ?? null,
        });
      published =
        run.ticketId && deps.withTicketLock
          ? await deps.withTicketLock(run.ticketId, () =>
              claimAndPublish(run, headSha, push),
            )
          : await claimAndPublish(run, headSha, push);
      if (published.kind === 'opened' || published.kind === 'updated') {
        current = { ...run, prUrl: published.url };
      }
    } else if (
      (newCommits ?? 0) === 0 &&
      isDispatchedWriter(run) &&
      run.branch
    ) {
      notPublishedBecause = 'no new commits since the last report';
    }

    let filed = 0;
    const filedIds: Array<{ id: string; kind: string }> = [];
    try {
      const work = isDispatchedWriter(current)
        ? await describeBranchWork(deps, current)
        : null;
      const body = buildRunComment({
        report,
        verdict,
        runLabel: `${label(current)} · follow-up ${sequence}`,
        work,
        published,
        notPublishedBecause,
      });
      const comment = await deps.ledger.createRunProposal(
        run.id,
        {
          kind: 'comment',
          body: clip(`**Follow-up ${sequence}**\n\n${body}`, MAX_PROPOSAL_BODY),
        },
        { external },
      );
      filed += 1;
      filedIds.push({ id: comment.id, kind: 'comment' });
      await deps.ledger
        .appendEvent(run.id, 'proposal_created', {
          proposalId: comment.id,
          kind: 'comment',
          followUp: sequence,
        })
        .catch(() => {});
      const plan = statePlanFor(run, verdict);
      if (plan && verdict !== run.verdict) {
        if (external && ticket?.ref) {
          filed += await proposeJiraTransition(deps, run, ticket.ref.key, plan);
        } else if (run.projectId) {
          const states = await deps.ledger.listStates(run.projectId);
          const target =
            plan === 'close'
              ? pickClosingState(states)
              : pickReviewState(states);
          if (target) {
            const change = await deps.ledger.createRunProposal(run.id, {
              kind: 'state_change',
              stateId: target.id,
            });
            filed += 1;
            filedIds.push({ id: change.id, kind: 'state_change' });
            await deps.ledger
              .appendEvent(run.id, 'proposal_created', {
                proposalId: change.id,
                kind: 'state_change',
                stateId: target.id,
                stateName: target.name,
                plan,
                followUp: sequence,
              })
              .catch(() => {});
          }
        }
      }
    } catch (error) {
      await rest(
        run,
        `The follow-up proposal could not be filed: ${describe(error)}`,
        { filed },
        turns,
      );
      return;
    }

    const turnCount = countTurns(turns);
    const headline = report.summary || closing;
    const reviewed = await settle(
      run,
      {
        status: 'needs-review',
        reason: `Follow-up ${sequence}: ${filed} proposal${filed === 1 ? '' : 's'} filed`,
        summary: clip(
          headline.split('\n').find((l) => l.trim()) ?? headline,
          MAX_SUMMARY_CHARS,
        ),
        verdict,
        turnCount,
        finalizeCount: sequence,
        finalizedHeadSha: headSha,
      },
      {
        reason: "Could not record the follow-up's report",
        detail: { followUp: sequence },
      },
    );
    if (!reviewed) return;
    await deps.ledger
      .appendEvent(run.id, 'finalized', {
        sequence,
        verdict,
        summary: clip(report.summary || closing, MAX_SUMMARY_CHARS),
        proposals: filedIds,
        pr: prFact(published, notPublishedBecause),
        headSha,
        newCommits,
        afterTurnId: lastTurnId(turns),
      })
      .catch(() => {});
    deps.logger.info('engine: run follow-up finalized', {
      runId: run.id,
      sequence,
      verdict,
      proposals: filed,
    });
    await deps.transcripts?.capture(run.id, turns);
    deps.onRunStatus?.(reviewed, 'finishing');
    await deps.ledger
      .postCopilotNote(
        run.id,
        finishedNote(reviewed, {
          turns: turnCount,
          proposals: filed,
          published,
          verdict,
          followUp: sequence,
        }),
      )
      .catch((error: unknown) =>
        warn('engine: Copilot note not posted', error, { runId: run.id }),
      );
    await drainOutbox(run.id, 'a follow-up');
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

    // Never-lock: a run whose report is already filed is being continued.
    // Its later turns are conversation unless the agent explicitly ends
    // one with a report — REST, or FILE a follow-up (design §4).
    const followUp = run.finalizeCount > 0;

    if (summary.lastTurnErrored) {
      if (followUp) {
        await rest(run, "The agent's turn ended in an error.", {
          stopReason: summary.lastStopReason ?? null,
        });
        return;
      }
      await killSession(daemon, run);
      await fail(run, "The agent's turn ended in an error.", {
        stopReason: summary.lastStopReason ?? null,
      });
      return;
    }

    let turns: DaemonTranscriptTurn[];
    try {
      turns = await daemon.getHistory(run.id, HISTORY_TURNS);
    } catch (error) {
      if (followUp) {
        await rest(
          run,
          `The session's history could not be read: ${describe(error)}`,
          {},
        );
        return;
      }
      await killSession(daemon, run);
      await fail(
        run,
        `The session's history could not be read: ${describe(error)}`,
      );
      return;
    }
    const closing = closingMessageOf(turns);
    if (!closing) {
      if (followUp) {
        await rest(run, 'The agent ended its turn without a closing message.', {
          stopReason: summary.lastStopReason ?? null,
        });
        return;
      }
      await killSession(daemon, run, turns);
      await fail(run, 'The agent ended its turn without a closing message.', {
        stopReason: summary.lastStopReason ?? null,
      });
      return;
    }

    // A legacy Waypoint-authored resume note *turn* (before never-lock the
    // note was a prompt of its own): the agent's "understood" reply is
    // not a report (design §4.6).
    if (isResumeNoteText(openingPromptOf(turns))) {
      await rest(run, 'The turn answered a resume note', {}, turns);
      return;
    }

    if (followUp) {
      await finalizeFollowUp(run, turns, closing);
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
    // Computed here, once, so claimPublish (below) and the finalized
    // event's own headSha (further down) always agree.
    const headSha = await headShaOf(run);

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
      // ROAD-131: `assertPublishableCwd` proves the ledger row's
      // `worktreePath`/`cwd` before this ever pushes a branch or opens a
      // PR in it — untrusted by the time this runs (the ledger arrives
      // over HTTP, the worktree is writable by the very agent whose
      // session just ended). Unlike the retry button (runsIpc.ts's
      // openRunPullRequest), nobody is in the loop here to catch a
      // surprise PR — so this is where it matters most, and it must fail
      // closed: a provenance failure is reported the same way a push
      // failure already is, never silently skipped. `claimAndPublish`
      // (found missing here in review, round 3) is the same one-
      // publisher-per-ticket claim finalizeFollowUp already took below —
      // a run's first-ever publish used to skip it entirely, so two runs
      // finalizing for the first time on one ticket at once could each
      // open a competing PR with nothing to serialize them.
      // `run` is `let`-bound and reassigned below, so a closure over it
      // loses TypeScript's non-null narrowing — captured once, here,
      // as the row this publish attempt actually runs against.
      const runToPublish = run;
      const { branch } = run;
      const push = () =>
        deps.pullRequests!.publish({
          run: runToPublish,
          closingMessage: closing,
          title: ticket
            ? `${ticket.identifier}: ${ticket.title}`
            : (runToPublish.title ?? branch),
          ticketUrl: ticket?.url ?? null,
        });
      published =
        runToPublish.ticketId && deps.withTicketLock
          ? await deps.withTicketLock(runToPublish.ticketId, () =>
              claimAndPublish(runToPublish, headSha, push),
            )
          : await claimAndPublish(runToPublish, headSha, push);
      if (published.kind === 'opened') run = { ...run, prUrl: published.url };
    }

    // The proposals: the board-shaped comment (the verdict, the Summary,
    // and the host's facts about the branch and the PR), and the state
    // change the verdict calls for.
    let filed = 0;
    const filedIds: Array<{ id: string; kind: string }> = [];
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
      filedIds.push({ id: comment.id, kind: 'comment' });
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
          filedIds.push({ id: change.id, kind: 'state_change' });
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
      await killSession(daemon, run, turns);
      await fail(run, `The proposal could not be filed: ${describe(error)}`, {
        filed,
      });
      return;
    }

    const turnCount = countTurns(turns);
    const headline = report.summary || closing;
    // The session is left alone either way — the success path just below
    // keeps it alive (never-lock), and a failed write is no reason to
    // take a healthy conversation down (round 5 of review: this used to
    // kill it, a leftover from before never-lock).
    const reviewed = await settle(
      run,
      {
        status: 'needs-review',
        reason: `${filed} proposal${filed === 1 ? '' : 's'} filed`,
        summary: clip(
          headline.split('\n').find((l) => l.trim()) ?? headline,
          MAX_SUMMARY_CHARS,
        ),
        verdict,
        turnCount,
        finalizeCount: 1,
        finalizedHeadSha: headSha,
      },
      { reason: 'Could not record the finalized report' },
    );
    if (!reviewed) return;
    await deps.ledger
      .appendEvent(run.id, 'finalized', {
        sequence: 1,
        verdict,
        summary: clip(report.summary || closing, MAX_SUMMARY_CHARS),
        proposals: filedIds,
        pr: prFact(published, notPublishedBecause),
        headSha,
        afterTurnId: lastTurnId(turns),
      })
      .catch(() => {});
    deps.logger.info('engine: run finalized', {
      runId: run.id,
      intent: run.intent,
      verdict,
      proposals: filed,
      turns: turnCount,
    });
    // Never-lock: the session stays alive — a finished run is a
    // conversation that may be continued (§7.1). The snapshot is still
    // taken now, so the panel has it if the daemon ever loses the session.
    await deps.transcripts?.capture(run.id, turns);
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
    await drainOutbox(run.id, 'finalize');
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
