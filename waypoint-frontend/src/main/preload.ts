// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { CopilotDetectResult } from './copilot/copilotDetect';
import type { JiraCommentPermissions } from './jira/jiraClient';
import type {
  JiraCommentBody,
  JiraConnectionSnapshot,
  JiraIdentity,
  JiraPriorityOption,
  JiraResult,
  JiraTicketQueryResult,
  JiraCommentPage,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
  JiraWireUser,
} from './jira/jiraTypes';
// A value import, unlike every jira/copilot import above — deliberately.
// ENGINE_IPC's own channel constants are the whole point of importing it:
// this bridge and engineIpc.ts (the other side of every one of these calls)
// share the literal channel names by construction, so the two can never
// drift the way two independently hand-typed 'engine:...' strings could.
// Safe to pull in as a value here specifically because engine/types.ts
// documents itself as importing neither Electron nor Node runtime modules
// (see that file's own header) — unlike jiraClient.ts or copilotDetect.ts,
// nothing about it would bloat what ships in the preload bundle.
import {
  ENGINE_IPC,
  type EngineHealth,
  type EngineStatus,
} from './engine/types';

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
    // Backs the real Claude Code CLI probe (W1.2) — request/response, like
    // `auth` above, since a single `claude --version` run produces exactly
    // one settled answer, never a stream. See copilotDetect.ts's own
    // handler for what each case actually means.
    detect(): Promise<CopilotDetectResult> {
      return ipcRenderer.invoke('copilot:detect');
    },
    // Acting on a write proposal.
    //
    // These three are the odd ones out in this bridge: they are plain HTTP
    // calls to waypoint-backend, which the renderer can perfectly well make
    // itself — and did, through data/api.ts's fetch wrapper, until approving
    // one could write to Jira. The Jira API token only ever exists in the
    // main process (see main/jira/jiraAuth.ts), so the request has to be
    // issued from where the credential is; the alternative would be handing
    // a bearer credential for someone's whole Jira account to the renderer,
    // which is the one thing that store exists to prevent.
    //
    // Nothing here takes or returns a credential. `T` is the caller's own
    // declared result shape — the same unchecked assertion data/api.ts's
    // http.post<T> already made about a JSON body, in the same place.
    proposals: {
      approve<T>(id: string): Promise<T> {
        return ipcRenderer.invoke('copilot:proposals:approve', id);
      },
      reject<T>(id: string): Promise<T> {
        return ipcRenderer.invoke('copilot:proposals:reject', id);
      },
      bulkApprove<T>(ids: string[]): Promise<T> {
        return ipcRenderer.invoke('copilot:proposals:bulk-approve', ids);
      },
    },
  },
  // The My Jira companion's entire data path. Every one of these is
  // request/response rather than a stream — a Jira call produces exactly one
  // answer — and every one of them crosses into the main process rather than
  // being a fetch() from the renderer, because the API token that
  // authenticates them is a real bearer credential for the user's whole Jira
  // account and never leaves main (see main/jira/jiraAuth.ts).
  //
  // Nothing here takes or returns a token: `connect` sends one in and gets an
  // identity back, and every later call authenticates from what main already
  // has stored.
  jira: {
    status(): Promise<JiraConnectionSnapshot> {
      return ipcRenderer.invoke('jira:status');
    },
    connect(args: {
      site: string;
      email: string;
      apiToken: string;
    }): Promise<JiraResult<JiraIdentity>> {
      return ipcRenderer.invoke('jira:connect', args);
    },
    disconnect(): Promise<{ ok: true }> {
      return ipcRenderer.invoke('jira:disconnect');
    },
    listTickets(): Promise<JiraResult<JiraTicketQueryResult>> {
      return ipcRenderer.invoke('jira:tickets:list');
    },
    listTransitions(
      ticketId: string,
    ): Promise<JiraResult<JiraWireTransition[]>> {
      return ipcRenderer.invoke('jira:tickets:transitions', ticketId);
    },
    transition(args: {
      ticketId: string;
      transitionId: string;
      fieldValues: Record<string, string>;
    }): Promise<JiraResult<JiraWireTicket>> {
      return ipcRenderer.invoke('jira:tickets:transition', args);
    },
    listPriorityOptions(
      ticketId: string,
    ): Promise<JiraResult<JiraPriorityOption[]>> {
      return ipcRenderer.invoke('jira:tickets:priority-options', ticketId);
    },
    setPriority(args: {
      ticketId: string;
      priorityId: string;
    }): Promise<JiraResult<JiraWireTicket>> {
      return ipcRenderer.invoke('jira:tickets:set-priority', args);
    },
    // `ticketKey`, not `ticketId`: Jira's assignable-user search takes the
    // issue key. The name says so here rather than leaving the one channel
    // that differs looking like all the others.
    searchAssignableUsers(args: {
      ticketKey: string;
      query: string;
    }): Promise<JiraResult<JiraWireUser[]>> {
      return ipcRenderer.invoke('jira:tickets:assignable-users', args);
    },
    // `accountId: null` means unassign — Jira's own payload for it, and a
    // value this signature has to keep nullable all the way down rather than
    // collapsing to an empty string on the way (see jiraIpc.ts).
    setAssignee(args: {
      ticketId: string;
      accountId: string | null;
    }): Promise<JiraResult<JiraWireTicket>> {
      return ipcRenderer.invoke('jira:tickets:set-assignee', args);
    },
    // No path in the arguments and no path in the answer, and that is the
    // shape rather than an omission. Main fetches the bytes, opens a native
    // save dialog and writes the file, all inside its own handler — the
    // renderer never names a location and never learns one. `fileName` is a
    // suggestion for the dialog's default, which main sanitizes before use.
    //
    // `canceled: true` is a success. The user closing the dialog is not an
    // error, and modelling it as one would fire an error toast on every
    // Escape (see `unwrap` in data/jiraApi.ts).
    downloadAttachment(args: {
      ticketId: string;
      attachmentId: string;
      fileName: string;
    }): Promise<JiraResult<{ canceled: boolean }>> {
      return ipcRenderer.invoke('jira:attachments:download', args);
    },
    // One issue id, and that is the entire argument list — no filename and no
    // path. Main opens its own file picker, so the renderer cannot name what
    // gets read off this machine.
    //
    // The answer carries the whole re-read ticket, like every other write
    // here, so the renderer can patch its cached list with what Jira actually
    // holds rather than with a ticket it assembled by guessing.
    uploadAttachment(args: {
      ticketId: string;
    }): Promise<JiraResult<{ canceled: boolean; ticket?: JiraWireTicket }>> {
      return ipcRenderer.invoke('jira:attachments:upload', args);
    },
    listComments(ticketId: string): Promise<JiraResult<JiraCommentPage>> {
      return ipcRenderer.invoke('jira:comments:list', ticketId);
    },
    // `parentId`, when present, is the comment this one replies to — see
    // JiraWireComment.parentId's own comment on why this undocumented field
    // is trusted at all. Optional and omitted (not sent as an explicit
    // `null`) for an ordinary, non-reply comment: jiraApi.ts's
    // postJiraComment only puts the key in `args` at all when it has a real
    // value to put there.
    postComment(args: {
      ticketId: string;
      body: JiraCommentBody;
      parentId?: string;
    }): Promise<JiraResult<JiraWireComment>> {
      return ipcRenderer.invoke('jira:comments:post', args);
    },
    // Overwrites one comment's body outright — the answer carries the
    // updated comment straight off Jira's own PUT response, like postComment
    // above and unlike deleteComment below, so a caller reads `parentId` and
    // every other field off what Jira actually reports rather than
    // assembling one from what was sent (see jiraClient.ts's own
    // updateComment for why that matters for an edited reply).
    updateComment(args: {
      ticketId: string;
      commentId: string;
      body: JiraCommentBody;
    }): Promise<JiraResult<JiraWireComment>> {
      return ipcRenderer.invoke('jira:comments:update', args);
    },
    // No re-read on success, unlike every write above: a deleted comment has
    // no state left to fetch back. `void` is the honest payload for that —
    // the renderer already holds the comment it just asked to delete and can
    // drop it from its own list on `ok: true`.
    deleteComment(args: {
      ticketId: string;
      commentId: string;
    }): Promise<JiraResult<void>> {
      return ipcRenderer.invoke('jira:comments:delete', args);
    },
    // One comment, read fresh. Exists for the edit path's freshness check:
    // the thread is read once when a ticket opens, so without re-reading the
    // single comment about to be overwritten, an edit can silently replace a
    // change someone else made in Jira since. listComments cannot answer that
    // reliably — it is capped at the 100 newest, so an older comment on a
    // busy thread may not be in it at all.
    getComment(args: {
      ticketId: string;
      commentId: string;
    }): Promise<JiraResult<JiraWireComment>> {
      return ipcRenderer.invoke('jira:comments:get', args);
    },
    // The project-level own/all answer the Delete/Edit affordance decides its
    // visibility from, since a comment itself carries no per-comment
    // permission hint (see jiraClient.ts's `getMyPermissions`). Per issue key,
    // like `searchAssignableUsers` above.
    getCommentPermissions(
      issueKey: string,
    ): Promise<JiraResult<JiraCommentPermissions>> {
      return ipcRenderer.invoke('jira:comments:permissions', issueKey);
    },
  },
  // Top-level, not nested under `copilot`: "point me at a local folder" is
  // a general filesystem concern, and the same channel is what any future
  // feature needing a directory from the user would reuse.
  repo: {
    chooseFolder(): Promise<
      { canceled: true } | { canceled: false; path: string }
    > {
      return ipcRenderer.invoke('repo:choose-folder');
    },
  },
  // ROAD-48/51: the agent-session engine (emdash's `workspace-server`
  // daemon). Every call is request/response like the Jira bridge above —
  // ENGINE_IPC's own comment (engine/types.ts) says `status` never throws
  // ("a broken engine is a status, not an error"), and the same holds for
  // install/start/stop/health: a failure is an EngineStatus with `kind:
  // 'failed'`, not a rejected promise, so there is no JiraResult-style
  // unwrap needed on this side. `onStatusChanged` is the one push channel,
  // for the same reason copilot.runPrompt's onDone/onChunk are: a status
  // can change with no renderer call in flight to answer it (the daemon
  // exiting on its own, say).
  engine: {
    status(): Promise<EngineStatus> {
      return ipcRenderer.invoke(ENGINE_IPC.status);
    },
    install(): Promise<EngineStatus> {
      return ipcRenderer.invoke(ENGINE_IPC.install);
    },
    start(): Promise<EngineStatus> {
      return ipcRenderer.invoke(ENGINE_IPC.start);
    },
    stop(): Promise<EngineStatus> {
      return ipcRenderer.invoke(ENGINE_IPC.stop);
    },
    health(): Promise<EngineHealth | null> {
      return ipcRenderer.invoke(ENGINE_IPC.health);
    },
    onStatusChanged(cb: (status: EngineStatus) => void): () => void {
      const subscription = (_event: IpcRendererEvent, status: EngineStatus) =>
        cb(status);
      ipcRenderer.on(ENGINE_IPC.statusChanged, subscription);
      return () => {
        ipcRenderer.removeListener(ENGINE_IPC.statusChanged, subscription);
      };
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
