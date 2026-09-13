// The one integration point between the "Agent engine" section of
// MachinePage and its data — same contract as data/jiraApi.ts and
// data/api.ts (see their own header comments for the tone this mirrors).
// UI code never reaches past these functions to window.electron.engine
// directly.
//
// No IpcResult unwrap here, unlike jiraApi.ts's `unwrap()`: ENGINE_IPC's own
// contract (main/engine/types.ts) says status/install/start/stop never
// throw — "a broken engine is a status, not an error" — so a failure
// surfaces as an EngineStatus with `kind: 'failed'`, not a rejected
// promise. There is nothing for this file to catch and rethrow.

import type {
  EngineHealth,
  EngineStatus,
  LiveSnapshot,
  LiveUpdate,
  TopicClosedReason,
} from '@/types/engine';
import type { RunChanged, RunDiff, StopRunResult } from '@/types/agentRuns';

function bridge() {
  const api = window.electron?.engine;
  if (!api) {
    // Only reachable outside a real Electron window (a bare browser, a test
    // that forgot to stub) — matching jiraApi.ts's own bridge() guard.
    throw new Error('The agent engine is unavailable in this window.');
  }
  return api;
}

/** Whatever the supervisor currently believes, from its last real
 *  observation — not a fresh check. See installEngine() below for the call
 *  that actually verifies the install on disk. */
export function getEngineStatus(): Promise<EngineStatus> {
  return bridge().status();
}

/** Installs if needed (extracting the bundled archive), verifies, and probes
 *  the socket — the call MachinePage makes on mount to get a truthful first
 *  status, which may be `running` if a daemon outlived the last Waypoint. */
export function installEngine(): Promise<EngineStatus> {
  return bridge().install();
}

export function startEngine(): Promise<EngineStatus> {
  return bridge().start();
}

export function stopEngine(): Promise<EngineStatus> {
  return bridge().stop();
}

/** A fresh `health` call on the live connection, or `null` when there is
 *  none to ask. */
export function getEngineHealth(): Promise<EngineHealth | null> {
  return bridge().health();
}

/** Subscribes to every status transition the supervisor pushes — the
 *  daemon dying on its own, say, with no renderer call in flight to learn
 *  about it any other way. Returns the unsubscribe function. */
export function onEngineStatusChanged(
  cb: (status: EngineStatus) => void,
): () => void {
  return bridge().onStatusChanged(cb);
}

// ---------------------------------------------------------------------------
// Live topics and allowlisted calls (ROAD-60) — the bridge the session
// followers (data/live/) are built on. Same window.electron.engine
// surface; wrapped here so nothing in components/ reaches for the preload
// object directly, and so a test can hand a follower a fake.
// ---------------------------------------------------------------------------

export function subscribeEngineTopic(
  topic: string,
  handlers: {
    onUpdate: (update: LiveUpdate) => void;
    onClosed: (reason: TopicClosedReason) => void;
  },
): Promise<{
  subscriptionId: string;
  snapshot: LiveSnapshot;
  unsubscribe: () => void;
}> {
  return bridge().subscribeTopic(topic, handlers);
}

export function snapshotEngineTopic(
  subscriptionId: string,
): Promise<LiveSnapshot> {
  return bridge().snapshotTopic(subscriptionId);
}

export function callEngine(
  procedure: string,
  input: unknown,
): Promise<unknown> {
  return bridge().call(procedure, input);
}

/** What every `fallible` daemon procedure answers with (main/engine/runs/daemonApi.ts's own header). */
type Fallible<T> =
  { success: true; data: T } | { success: false; error: unknown };

/** The daemon's error object, as one sentence — `type: stage: message`, the parts it sent. */
function describeDaemonError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { type?: unknown; stage?: unknown; message?: unknown };
    const parts = [e.type, e.stage, e.message].filter(
      (p): p is string => typeof p === 'string',
    );
    if (parts.length) return parts.join(': ');
  }
  return JSON.stringify(error);
}

/**
 * A daemon procedure whose answer is a `{success, data | error}` envelope
 * — every `acp.*` procedure the panel calls. Unwrapped here, once, so a
 * refusal ("no such session", say) is a rejected promise carrying the
 * daemon's own words, the same shape main's daemonApi.ts gives its
 * callers.
 */
export async function callEngineFallible<T>(
  procedure: string,
  input: unknown,
): Promise<T> {
  const answer = (await bridge().call(procedure, input)) as Fallible<T>;
  if (!answer || typeof answer !== 'object' || !('success' in answer)) {
    throw new Error(`${procedure} answered in an unexpected shape.`);
  }
  if (!answer.success) {
    throw new Error(`${procedure}: ${describeDaemonError(answer.error)}`);
  }
  return answer.data;
}

/** The three functions above, as the object data/live/ expects. */
export const engineSessionBridge = {
  subscribeTopic: subscribeEngineTopic,
  snapshotTopic: snapshotEngineTopic,
  call: callEngineFallible,
};

// ---------------------------------------------------------------------------
// Run control and the session procedures the panel calls (W3). Each is a
// thin wrapper: main decides what the run id means (runsIpc.ts), and the
// daemon procedures are the ones ALLOWED_PROCEDURES lets through with
// exactly these inputs — a wrapper here is the one place that shape is
// spelled in the renderer.
// ---------------------------------------------------------------------------

export function stopRun(runId: string): Promise<StopRunResult> {
  return bridge().stopRun(runId);
}

export function getRunDiff(runId: string): Promise<RunDiff> {
  return bridge().runDiff(runId);
}

export function revealRunWorktree(runId: string): Promise<void> {
  return bridge().revealRunWorktree(runId);
}

/** Every ledger write main makes from the daemon's report (blocked ⇄ running, interrupted). */
export function onRunChanged(cb: (change: RunChanged) => void): () => void {
  return bridge().onRunChanged(cb);
}

/** Text only: the panel's composer has no attachments in W3. */
export function sendPrompt(
  runId: string,
  text: string,
): Promise<{ queued: boolean }> {
  return callEngineFallible<{ queued: boolean }>('acp.sendPrompt', {
    conversationId: runId,
    prompt: { text },
  });
}

export function resolvePermission(
  runId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return callEngineFallible<void>('acp.resolvePermission', {
    conversationId: runId,
    requestId,
    optionId,
  });
}

export function cancelTurn(runId: string): Promise<void> {
  return callEngineFallible<void>('acp.cancelTurn', { conversationId: runId });
}
