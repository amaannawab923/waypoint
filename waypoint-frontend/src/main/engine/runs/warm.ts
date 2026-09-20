import { promises as fs } from 'node:fs';
import type { WarmRunResult } from '../types';
import { agentEnvFor } from './agentEnv';
import type { DaemonSessionSummary } from './daemonApi';
import { assertRunId } from './ledgerClient';
import { withRunLock } from './runLock';
import {
  ENGINE_NOT_RUNNING,
  RESUMABLE_RUN_STATUSES,
  sessionModeOf,
  type StartRunDeps,
} from './startRun';

/**
 * Start on open (never-lock, design §2.5; parity with emdash's `start()`
 * on tab open). When the pane opens a run whose daemon session is gone,
 * the session is loaded again — DAEMON ONLY. Nothing touches the ledger:
 * no reopenRun, no status write, no providerSessionId write, no note,
 * no event, no marker. Merely looking at a finished run must change
 * nothing about it. What the warm-up learned — the provider's session
 * id, and whether it was the same one — waits in `warmed` for the first
 * real send, which does the reopen and records `session_resumed` at the
 * moment the conversation actually continues.
 *
 * Under the run lock, so a send arriving mid-warm-up sees `isRunBusy`
 * and goes to the outbox (sendPrompt.ts) rather than waiting a cold
 * spawn out. A failure is logged only; the send path handles it again.
 */

export interface Warmed {
  sessionId: string;
  /** The provider restored the same session (vs. started a fresh one in the same cwd). */
  loaded: boolean;
}

const warmed = new Map<string, Warmed>();

/** What a warm-up learned for `runId`, consumed once by the first send. */
export function takeWarmed(runId: string): Warmed | null {
  const w = warmed.get(runId) ?? null;
  warmed.delete(runId);
  return w;
}

/** For tests. */
export function clearWarmed(): void {
  warmed.clear();
}

export async function warmRun(
  deps: StartRunDeps,
  rawRunId: unknown,
): Promise<WarmRunResult> {
  if (typeof rawRunId !== 'string') throw new Error('Not a run id.');
  assertRunId(rawRunId);
  const runId = rawRunId;
  return withRunLock(runId, async () => {
    const run = await deps.ledger.getRun(runId);
    if (!run) throw new Error(`No run ${runId} in the ledger.`);
    const daemon = deps.daemon();
    if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) {
      // Live, or on its way (queued/provisioning): nothing to warm.
      return { kind: 'already-live' };
    }
    const sessions = await daemon
      .listSessions()
      .catch((): Record<string, DaemonSessionSummary> => ({}));
    if (sessions[runId]) return { kind: 'already-live' };
    if (warmed.has(runId)) return { kind: 'already-live' };

    const cwd = run.cwd ?? run.worktreePath;
    if (!cwd) return { kind: 'skipped', why: 'no-cwd' };
    // A worktree that would need recreating writes ledger fields a
    // terminal row refuses — that is the send path's job (it reopens
    // first). A plain existence check is all a warm-up may do.
    const present = await fs
      .stat(cwd)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!present) return { kind: 'skipped', why: 'worktree-unusable' };
    if (run.isolation !== 'directory') {
      const linked = await deps.assertWorktreeGitDir(cwd).then(
        () => true,
        () => false,
      );
      if (!linked) return { kind: 'skipped', why: 'worktree-unusable' };
    }

    try {
      const { sessionId } = await daemon.startSession({
        conversationId: run.id,
        providerId: run.providerId,
        cwd,
        sessionId: run.providerSessionId,
        modeId: sessionModeOf(run),
        ...(agentEnvFor(run) ? { env: agentEnvFor(run) } : {}),
      });
      const loaded =
        run.providerSessionId !== null && sessionId === run.providerSessionId;
      warmed.set(runId, { sessionId, loaded });
      deps.logger.info('engine: run warmed on open', { runId, loaded });
      return { kind: 'warmed', loaded };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn('engine: warm-up failed', { runId, message });
      return { kind: 'failed', message };
    }
  });
}
