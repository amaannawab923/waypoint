import type { DaemonSessionSummary } from './daemonApi';
import type { AgentRun } from './ledgerClient';

/**
 * What a warm-up (warm.ts) learned about a run's daemon session, waiting
 * for the first path that actually continues the run. A leaf module on
 * purpose: warm.ts records here, and every path that can start or take
 * over a session (sendPrompt.ts, startRun.ts) asks here — with no import
 * cycle between them.
 */
export interface Warmed {
  sessionId: string;
  /** The provider restored the same session (vs. started a fresh one in the same cwd). */
  loaded: boolean;
}

const warmed = new Map<string, Warmed>();

export function recordWarmed(runId: string, w: Warmed): void {
  warmed.set(runId, w);
}

export function hasWarmed(runId: string): boolean {
  return warmed.has(runId);
}

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

/**
 * What session a resume can take over, for a run that is not live in the
 * ledger — the ONE answer every path that continues a run uses: the
 * three resume-then-deliver paths in sendPrompt.ts and the explicit
 * resume in startRun.ts (round 6 of review: that fourth one had been
 * left out, so a warm-up followed by an explicit resume started the
 * daemon's conversation a second time). Three review rounds each found
 * one of these diverging from the others; this is the fix for the
 * class, not the instance.
 *
 * A warm-up's own record comes first: warm.ts asked the daemon and was
 * told whether the provider restored the run's session or replaced it —
 * `loaded` — and which id it is running now. Guessing `{providerSessionId,
 * loaded: true}` just because the daemon lists a session (round 5 of
 * review: every path did exactly that) threw that answer away, so a
 * warm-up that lost the conversation was reported as continuous: the
 * agent never got the context-lost note, the person never got the
 * marker, and the ledger kept the dead session id. Only with no warm-up
 * record does a listed session mean what finalize left alive — the run's
 * own session, restored. The record is consumed either way, so a stale
 * one can never be trusted by a later send.
 */
export function aliveSessionFor(
  run: AgentRun,
  live: DaemonSessionSummary | undefined,
): Warmed | null {
  const record = takeWarmed(run.id);
  if (record) return record;
  return live
    ? { sessionId: run.providerSessionId ?? run.id, loaded: true }
    : null;
}
