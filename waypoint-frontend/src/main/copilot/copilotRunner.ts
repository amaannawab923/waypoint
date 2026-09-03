import { ipcMain, type BrowserWindow } from 'electron';
import {
  runSession,
  type CopilotErrorKind,
  type Query,
  type SessionHooks,
} from '../agent/claudeSession';
import { buildCopilotSessionPolicy } from '../agent/sessionPolicy';

// The thin ipcMain.on('copilot:run') adapter (P3c). All SDK-invocation
// logic — option building, env building, repo-root resolution, the
// generator loop, the stale-session retry, and Query.close() — now lives in
// ../agent/claudeSession.ts; the policy this hands it comes from
// ../agent/sessionPolicy.ts. This file's own job is unchanged: parse and
// validate the untrusted IPC payload, build the SessionPolicy it implies,
// and forward streamed events back to the renderer over the same
// 'copilot:stream' channel with the same payload shapes as before.

export type { CopilotErrorKind };

// Generous ceiling for the renderer-built outcome preamble (a few one-line
// outcome sentences) — a cap, not a format check, so a runaway/buggy caller
// can't stuff arbitrary content ahead of every prompt.
const OUTCOME_PREAMBLE_MAX_LENGTH = 4000;

type StreamPayload =
  | { requestId: string; type: 'chunk'; text: string }
  | {
      requestId: string;
      type: 'done';
      fullText: string;
      sessionId: string | null;
      // True only when the model emitted the [[NEEDS_REPO]] sentinel, which
      // it is only ever told about in the no-repo-linked system prompt — so
      // this can't fire in a state where the repo is already linked.
      needsRepoLink: boolean;
    }
  | {
      requestId: string;
      type: 'error';
      kind: CopilotErrorKind;
      message: string;
    };

// requestId -> the running query, so before-quit/window-close can clean up
// anything still in flight instead of orphaning it. electronmon restarts the
// main process on every src/main/** file change during dev, which would
// otherwise leave a live subprocess with no owner.
const inFlight = new Map<string, Query>();

export function killAllCopilotProcesses(): void {
  // Query.close() "forcefully ends the query, cleaning up all resources
  // including... the CLI subprocess" — the direct replacement for the old
  // child.kill(), with the same call sites and the same semantics. This
  // runs from app teardown (before-quit) with every other in-flight query
  // still to close after it — one throwing close() must not skip the rest,
  // or leave inFlight.clear() unreached and a query record dangling past
  // the process that owned it exiting.
  // eslint-disable-next-line no-restricted-syntax
  for (const query of inFlight.values()) {
    try {
      query.close();
    } catch {
      // Best-effort teardown on app quit — nothing left to report a
      // failure to, and the remaining queries still need their turn.
    }
  }
  inFlight.clear();
}

export function registerCopilotIpc(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.on(
    'copilot:run',
    (
      _event,
      args: {
        requestId: string;
        prompt: string;
        resumeSessionId?: string;
        conversationId?: string;
        outcomePreamble?: string;
        repoPath?: string;
      },
    ) => {
      // Defensive only — the sole caller is this app's own preload bridge,
      // which always sends a well-formed payload. But ipcMain handlers run
      // in the main process with nothing else standing between a malformed
      // payload and a crash of the whole app, so it's cheap insurance
      // against a future caller (or a bug in preload) doing otherwise.
      if (
        !args ||
        typeof args.requestId !== 'string' ||
        !args.requestId ||
        typeof args.prompt !== 'string' ||
        !args.prompt.trim()
      ) {
        return;
      }
      const { requestId, prompt, resumeSessionId } = args;
      // Both optional fields degrade rather than fail: a malformed
      // conversationId just means no header (the backend then refuses
      // proposals cleanly, via sessionPolicy.ts's own re-validation), and a
      // malformed/oversized outcomePreamble is dropped rather than fed to
      // the model — the un-notified outcomes it carried stay un-notified
      // server-side (modelNotifiedAt only advances after a successful
      // run), so they re-deliver next turn.
      const conversationId =
        typeof args.conversationId === 'string'
          ? args.conversationId
          : undefined;
      const outcomePreamble =
        typeof args.outcomePreamble === 'string' &&
        args.outcomePreamble.trim() &&
        args.outcomePreamble.length <= OUTCOME_PREAMBLE_MAX_LENGTH
          ? args.outcomePreamble
          : undefined;
      // Degrades the same way: anything not a string simply falls through
      // to the unlinked branch inside claudeSession.ts's resolveRepoRoot —
      // a missing repo is a normal state here, never an error path.
      const repoPath =
        typeof args.repoPath === 'string' ? args.repoPath : undefined;

      const send = (payload: StreamPayload) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('copilot:stream', payload);
      };

      const policy = buildCopilotSessionPolicy({
        repoPath,
        resumeSessionId,
        conversationId,
        promptPreamble: outcomePreamble,
      });

      const hooks: SessionHooks = {
        onChunk: (text) => send({ requestId, type: 'chunk', text }),
        onDone: (result) =>
          send({
            requestId,
            type: 'done',
            fullText: result.fullText,
            sessionId: result.sessionId,
            needsRepoLink: result.needsRepoLink,
          }),
        onError: (error) =>
          send({
            requestId,
            type: 'error',
            kind: error.errorKind,
            message: error.message,
          }),
        // A retry starts a second Query under the same requestId —
        // inFlight must end up tracking whichever one is actually still
        // running. Deleting unconditionally by key would let the FIRST
        // query's own cleanup (which can still run after the retry has
        // already started) wipe out the SECOND query's entry. Comparing by
        // reference before deleting is what keeps killAllCopilotProcesses
        // targeting the live query either way.
        onQueryStarted: (query) => inFlight.set(requestId, query),
        onQueryEnded: (query) => {
          if (inFlight.get(requestId) === query) inFlight.delete(requestId);
        },
      };

      // Fire-and-forget: every outcome (chunks, the terminal reply, any
      // error) is delivered synchronously through `hooks` above as it
      // happens, matching how this handler always behaved — the returned
      // promise (resolving once the session's whole retry sequence has
      // settled) has no further caller here.
      void runSession(policy, prompt, hooks);
    },
  );
}
