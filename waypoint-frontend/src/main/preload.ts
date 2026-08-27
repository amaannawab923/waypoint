// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { randomUUID } from 'crypto';
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels = 'ipc-example' | 'copilot:run' | 'copilot:stream';

export type CopilotErrorKind = 'binary_not_found' | 'auth_failed' | 'generic';

interface CopilotStreamPayload {
  requestId: string;
  type: 'chunk' | 'done' | 'error';
  text?: string;
  fullText?: string;
  sessionId?: string | null;
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
      args: { prompt: string; resumeSessionId?: string },
      handlers: {
        onChunk: (text: string) => void;
        onDone: (result: {
          fullText: string;
          sessionId: string | null;
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
        } else if (payload.type === 'done') {
          handlers.onDone({
            fullText: payload.fullText ?? '',
            sessionId: payload.sessionId ?? null,
          });
        } else if (payload.type === 'error') {
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
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
