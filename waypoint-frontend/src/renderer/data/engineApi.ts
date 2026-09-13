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
import type {
  AgentRun,
  BriefPreview,
  BriefPreviewInput,
  DispatchRunInput,
  FolderChoice,
  OpenPrResult,
  ResumeRunResult,
  RunFocus,
  RunBranches,
  SessionFolder,
  RunChanged,
  RunDiff,
  StartRunInput,
  StopRunResult,
} from '@/types/agentRuns';

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

/**
 * A main-side refusal arrives as Electron's own wrapper — "Error invoking
 * remote method 'runs:start': Error: <ours>" — and only the last part is
 * a sentence for a person (found in W4's live pass: the dialog showed the
 * wrapper). Stripped once here, so every run channel's error is main's
 * own words.
 */
function unwrapIpcError(error: unknown): never {
  if (error instanceof Error) {
    const m =
      /^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(
        error.message,
      );
    if (m) throw new Error(m[1]);
  }
  throw error;
}

export function stopRun(runId: string): Promise<StopRunResult> {
  return bridge().stopRun(runId).catch(unwrapIpcError);
}

export function getRunDiff(runId: string): Promise<RunDiff> {
  return bridge().runDiff(runId).catch(unwrapIpcError);
}

export function revealRunWorktree(runId: string): Promise<void> {
  return bridge().revealRunWorktree(runId).catch(unwrapIpcError);
}

// W4 (docs/design/w4-start-session.md §5): the renderer names a project,
// never a path; main answers with the run once it is `provisioning`, and
// the rest arrives through onRunChanged.
export function startRun(input: StartRunInput): Promise<AgentRun> {
  return bridge().startRun(input).catch(unwrapIpcError);
}

export function resumeRun(runId: string): Promise<ResumeRunResult> {
  return bridge().resumeRun(runId).catch(unwrapIpcError);
}

export function listRunBranches(folderHandle: string): Promise<RunBranches> {
  return bridge().listRunBranches(folderHandle).catch(unwrapIpcError);
}

// W4b (docs/design/w4b-sessions-anywhere.md §2): folders are handles main
// minted — from the OS picker, or from its recents and the projects'
// linked repositories. The renderer shows the description and hands the
// handle back; it never names a path.
export function chooseFolder(): Promise<FolderChoice> {
  return bridge().chooseFolder().catch(unwrapIpcError);
}

export function listRecentFolders(): Promise<SessionFolder[]> {
  return bridge().listRecentFolders().catch(unwrapIpcError);
}

let homeDirPromise: Promise<string | null> | null = null;
/** The home directory, read once, so a run's folder can be shown as `~/…`. Null outside Electron. */
export function getHomeDir(): Promise<string | null> {
  if (!homeDirPromise) {
    homeDirPromise = (async () => {
      try {
        return await bridge().homeDir();
      } catch {
        return null;
      }
    })();
  }
  return homeDirPromise;
}

/** Every ledger write main makes — the follower's, and a start or resume's. */
export function onRunChanged(cb: (change: RunChanged) => void): () => void {
  return bridge().onRunChanged(cb);
}

// W5a (docs/design/w5a-investigate-fix.md §1.3): a session on a ticket.
// The preview is built in main from the ledger's view of the ticket; the
// dispatch sends the brief back as the person left it, and the run
// arrives `provisioning` like a started one.
export function getBriefPreview(
  input: BriefPreviewInput,
): Promise<BriefPreview> {
  return bridge().briefPreview(input).catch(unwrapIpcError);
}

export function dispatchRun(input: DispatchRunInput): Promise<AgentRun> {
  return bridge().dispatchRun(input).catch(unwrapIpcError);
}

/** W6: push the run's branch and open its pull request, as the person — the retry after a failed publish. */
export function openRunPullRequest(runId: string): Promise<OpenPrResult> {
  return bridge().openRunPr(runId).catch(unwrapIpcError);
}

/** The person clicked a notification about a run (main/engine/notifications.ts). */
export function onRunFocus(cb: (focus: RunFocus) => void): () => void {
  try {
    return bridge().onRunFocus(cb);
  } catch {
    return () => {};
  }
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
