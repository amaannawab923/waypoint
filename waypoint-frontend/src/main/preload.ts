// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
// Type-only, so repoLink.ts's `electron`/`child_process` imports are erased
// rather than pulled into the sandboxed preload bundle — the channel
// payloads stay defined in exactly one place either way.
import type {
  ChooseFolderOptions,
  ChooseFolderResult,
  RepoDescribeResult,
} from './repoLink';

// The global Web Crypto API, not Node's `crypto` module: this preload script
// runs in Electron's sandboxed renderer context by default (Electron 20+),
// where only a curated subset of Node's own built-ins is guaranteed
// available — `require('crypto')` is not one of the documented ones.
// `crypto.randomUUID()` is a standard Web Platform API present in every
// Chromium context regardless of sandboxing, so it sidesteps the question
// entirely instead of depending on the sandbox's Node module allowlist.
//
// Not destructured off `crypto` — `Crypto.prototype.randomUUID` is a native
// method that throws "TypeError: Illegal invocation" when called without
// its `crypto` receiver (confirmed live: destructuring it broke every
// Copilot send with exactly that error). Wrapping in an arrow function
// keeps the call bound to the right `this`.
const randomUUID = () => crypto.randomUUID();

export type Channels = 'ipc-example' | 'copilot:run' | 'copilot:stream';

export type CopilotErrorKind = 'binary_not_found' | 'auth_failed' | 'generic';

interface CopilotStreamPayload {
  requestId: string;
  type: 'chunk' | 'done' | 'error';
  text?: string;
  fullText?: string;
  sessionId?: string | null;
  needsRepoLink?: boolean;
  kind?: CopilotErrorKind;
  message?: string;
}

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
  },
  // A dedicated API, not just the generic sendMessage/on bridge above: a
  // Copilot run is a single logical call that produces a *stream* of events
  // (any number of chunks, then exactly one done or error) — modeling that
  // on the raw channel primitives would mean every caller hand-rolling its
  // own subscribe/unsubscribe/correlate-by-requestId bookkeeping. This does
  // it once, here.
  copilot: {
    runPrompt(
      // conversationId lets the main process bake the proposal-targeting
      // header into --mcp-config; outcomePreamble is prepended to the
      // prompt on the subprocess's stdin only (never persisted as a
      // message) — both validated again in copilotRunner.ts, so this stays
      // a pass-through with no new channels.
      // repoPath is the project-settings-linked checkout for whichever
      // project's page is open at send time (Copilot V3) — resolved fresh
      // per message by the renderer, re-validated in copilotRunner.ts, and
      // absent whenever no project route is open or none is linked.
      args: {
        prompt: string;
        resumeSessionId?: string;
        conversationId?: string;
        outcomePreamble?: string;
        repoPath?: string;
      },
      handlers: {
        onChunk: (text: string) => void;
        onDone: (result: {
          fullText: string;
          sessionId: string | null;
          needsRepoLink: boolean;
        }) => void;
        onError: (err: { kind: CopilotErrorKind; message: string }) => void;
      },
    ): () => void {
      const requestId = randomUUID();

      const subscription = (
        _event: IpcRendererEvent,
        payload: CopilotStreamPayload,
      ) => {
        if (payload.requestId !== requestId) return;
        if (payload.type === 'chunk' && typeof payload.text === 'string') {
          handlers.onChunk(payload.text);
          return;
        }
        // done/error are terminal — this run will never emit anything else
        // for this requestId, so the listener removes itself right here
        // instead of relying solely on the caller's returned unsubscribe.
        // Without this, every run left its listener registered until
        // either the caller happened to call unsubscribe or the whole
        // panel unmounted — on a long conversation, dozens of long-dead
        // listeners would sit on 'copilot:stream' for the rest of the
        // panel's life, each still paying the requestId-mismatch check on
        // every future run's every chunk.
        if (payload.type === 'done') {
          ipcRenderer.removeListener('copilot:stream', subscription);
          handlers.onDone({
            fullText: payload.fullText ?? '',
            sessionId: payload.sessionId ?? null,
            needsRepoLink: payload.needsRepoLink === true,
          });
        } else if (payload.type === 'error') {
          ipcRenderer.removeListener('copilot:stream', subscription);
          handlers.onError({
            kind: payload.kind ?? 'generic',
            message: payload.message ?? 'Unknown error',
          });
        }
      };
      ipcRenderer.on('copilot:stream', subscription);
      ipcRenderer.send('copilot:run', { requestId, ...args });

      // Stops listening on this side only — does not cancel the
      // main-process subprocess. If the panel closes mid-stream, the run is
      // left to finish and its result is simply dropped rather than wasted;
      // see CopilotPanel.tsx's unmount effect.
      return () => {
        ipcRenderer.removeListener('copilot:stream', subscription);
      };
    },
    // Request/response, not the stream bridge above — invoke/handle fits a
    // single answer per call better than hand-rolling a send/on pair for
    // each of these. Backs the "connect your Claude subscription" settings
    // page: lets a user recover from an expired/missing CLI login without
    // ever opening a terminal, by pasting a token generated once via
    // Anthropic's own `claude setup-token` command instead.
    auth: {
      status(): Promise<{ connected: boolean; last4: string | null }> {
        return ipcRenderer.invoke('copilot:auth:status');
      },
      save(
        token: string,
      ): Promise<{ ok: true; last4: string } | { ok: false; message: string }> {
        return ipcRenderer.invoke('copilot:auth:save', token);
      },
      clear(): Promise<{ ok: true }> {
        return ipcRenderer.invoke('copilot:auth:clear');
      },
      // Runs `claude setup-token` end to end without a terminal: a stream
      // bridge (mirrors copilot.runPrompt's shape) rather than invoke/handle,
      // since this produces an open-ended sequence of raw terminal output
      // chunks followed by exactly one exit, not a single answer.
      connect(
        requestId: string,
        handlers: {
          onData: (chunk: string) => void;
          onExit: (result: {
            code: number | null;
            spawnError?: string;
          }) => void;
        },
      ): () => void {
        const dataSubscription = (
          _event: IpcRendererEvent,
          payload: { requestId: string; chunk: string },
        ) => {
          if (payload.requestId !== requestId) return;
          handlers.onData(payload.chunk);
        };
        const exitSubscription = (
          _event: IpcRendererEvent,
          payload: {
            requestId: string;
            code: number | null;
            spawnError?: string;
          },
        ) => {
          if (payload.requestId !== requestId) return;
          ipcRenderer.removeListener(
            'copilot:auth:connect:data',
            dataSubscription,
          );
          ipcRenderer.removeListener(
            'copilot:auth:connect:exit',
            exitSubscription,
          );
          handlers.onExit({
            code: payload.code,
            spawnError: payload.spawnError,
          });
        };
        ipcRenderer.on('copilot:auth:connect:data', dataSubscription);
        ipcRenderer.on('copilot:auth:connect:exit', exitSubscription);
        ipcRenderer.send('copilot:auth:connect:start', { requestId });

        // Listener-only, like runPrompt's own unsubscribe above — does NOT
        // cancel the main-process PTY. A plain component unmount (e.g. route
        // navigation away from Settings mid-handshake) shouldn't
        // guarantee-fail an attempt that might still complete moments later
        // with nobody watching; call cancel() below for that instead.
        return () => {
          ipcRenderer.removeListener(
            'copilot:auth:connect:data',
            dataSubscription,
          );
          ipcRenderer.removeListener(
            'copilot:auth:connect:exit',
            exitSubscription,
          );
        };
      },
      // A separate, explicit kill — distinct from connect()'s unsubscribe
      // above, which only stops listening. Callers use this for an actual
      // user-initiated cancel/close, not a plain unmount.
      cancel(requestId: string): void {
        ipcRenderer.send('copilot:auth:connect:cancel', { requestId });
      },
      // Narrowly scoped on the main-process side to only the real Anthropic
      // OAuth host — see copilotConnect.ts's own handler.
      openExternal(url: string): Promise<{ ok: boolean }> {
        return ipcRenderer.invoke('copilot:auth:open-external', url);
      },
    },
  },
  // Top-level, not nested under `copilot`: "point me at a local folder" is
  // a general filesystem concern, and the same channel is what any future
  // feature needing a directory from the user would reuse.
  repo: {
    chooseFolder(opts?: ChooseFolderOptions): Promise<ChooseFolderResult> {
      return ipcRenderer.invoke('repo:choose-folder', opts);
    },
    checkPath(repoPath: string): Promise<{ exists: boolean }> {
      return ipcRenderer.invoke('repo:check-path', repoPath);
    },
    describe(repoPath: string): Promise<RepoDescribeResult> {
      return ipcRenderer.invoke('repo:describe', repoPath);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
