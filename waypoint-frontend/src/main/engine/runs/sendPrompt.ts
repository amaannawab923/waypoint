import { MAX_FIRST_MESSAGE_CHARS, type SendRunPromptResult } from '../types';
import { assertRunId } from './ledgerClient';
import { withRunLock } from './runLock';
import {
  ENGINE_NOT_RUNNING,
  RESUMABLE_RUN_STATUSES,
  resumeRunCore,
  type StartRunDeps,
} from './startRun';

export interface ValidatedSendPromptInput {
  runId: string;
  text: string;
}

export function validateSendPromptInput(
  input: unknown,
): ValidatedSendPromptInput {
  if (!input || typeof input !== 'object') throw new Error('Not a message.');
  const { runId, text } = input as Record<string, unknown>;
  if (typeof runId !== 'string') throw new Error('Not a run id.');
  assertRunId(runId);
  if (typeof text !== 'string') throw new Error('The message must be text.');
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('The message is empty.');
  if (trimmed.length > MAX_FIRST_MESSAGE_CHARS) {
    throw new Error(
      `The message can be at most ${MAX_FIRST_MESSAGE_CHARS} characters.`,
    );
  }
  return { runId, text: trimmed };
}

/** A run with a live daemon session that can accept a prompt right now — narrower than reconcile.ts's LIVE_RUN_STATUSES, which also counts `provisioning` (no session yet to send to). */
const READY_FOR_PROMPT = new Set(['running', 'blocked', 'finishing']);

// The body of a send, run only once sendRunPrompt below has this run's
// lock — see sendRunPrompt's own doc comment for the externally-visible
// contract this implements.
async function sendRunPromptLocked(
  deps: StartRunDeps,
  runId: string,
  text: string,
): Promise<SendRunPromptResult> {
  const run = await deps.ledger.getRun(runId);
  if (!run) throw new Error(`No run ${runId} in the ledger.`);
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);

  if (READY_FOR_PROMPT.has(run.status)) {
    await daemon.sendPrompt(run.id, text);
    await deps.ledger
      .appendEvent(run.id, 'prompt_sent', { by: 'user', kind: 'message' })
      .catch(() => {});
    return { outcome: 'sent', status: run.status };
  }
  if (run.status === 'queued' || run.status === 'provisioning') {
    // A session is already on its way (a Start or an earlier resume);
    // reviving again would race it. The renderer's own composer gating
    // should already keep this unreachable in practice — this is the
    // backstop, not the primary defense.
    return { outcome: 'not-ready', status: run.status };
  }
  if (!(RESUMABLE_RUN_STATUSES as readonly string[]).includes(run.status)) {
    return { outcome: 'not-resumable', status: run.status };
  }

  const resumed = await resumeRunCore(deps, runId, 'message');
  if (resumed.outcome !== 'loaded' && resumed.outcome !== 'replaced-by-new') {
    // worktree-gone or not-resumable (a Stop landed mid-resume, or
    // reopenRun's own refusal already threw and propagated past here —
    // this branch is only the outcomes resumeRunCore can actually return
    // rather than throw). The message was never sent.
    return { outcome: resumed.outcome, status: resumed.status };
  }
  await daemon.sendPrompt(run.id, text);
  await deps.ledger
    .appendEvent(run.id, 'prompt_sent', {
      by: 'user',
      kind: 'message',
      afterResume: resumed.outcome,
    })
    .catch(() => {});
  return {
    outcome: 'resumed-and-sent',
    status: 'running',
    resume: resumed.outcome,
  };
}

/**
 * Transparent resume-on-message (ROAD-XXX): the renderer's composer calls
 * this instead of the generic `acp.sendPrompt` daemon-bridge procedure
 * (topicsIpc.ts's `ALLOWED_PROCEDURES`), which has no run-status
 * awareness at all — a raw pass-through keyed by `conversationId`. This
 * is the one place that decides whether a message can go straight to the
 * daemon, needs the run revived first, or can't be sent at all.
 *
 * Resume-first, not send-then-retry-on-daemon-error (the shape Copilot's
 * own `claudeSession.ts` uses for its stale-session retry): Copilot has
 * no ledger to consult, so it can only discover staleness by hitting it —
 * a cross-provider error-string match is the only signal it has. Here the
 * ledger already, authoritatively, knows the run is dead before the
 * daemon is ever touched, so checking first is strictly more reliable
 * than probing and risks nothing a probe would (a daemon holding some
 * stale session object that silently swallows the prompt).
 */
export async function sendRunPrompt(
  deps: StartRunDeps,
  rawInput: unknown,
): Promise<SendRunPromptResult> {
  const { runId, text } = validateSendPromptInput(rawInput);
  return withRunLock(runId, () => sendRunPromptLocked(deps, runId, text));
}
