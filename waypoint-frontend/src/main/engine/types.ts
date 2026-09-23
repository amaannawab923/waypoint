import { liveTopic, splitTopic } from './wire/topics';
/**
 * The agent-session engine: emdash's `workspace-server` daemon, run by Waypoint
 * as a pinned, self-built process, spoken to over its Wire protocol.
 *
 * This file is the contract between the three pieces that make that work and
 * were built in parallel against it — the transports (`./transport/`), the
 * Wire client (`./wire/`), and the supervisor (`./supervisor.ts`) — plus the
 * IPC surface the renderer sees. Nothing here imports Electron or Node
 * runtime modules, so the renderer's `types/engine.ts` can mirror the
 * status shapes and the Wire client can be unit-tested against an in-memory
 * transport.
 *
 * Why a daemon and not vendored code, in one paragraph: the daemon persists
 * session intents and reconciles them at boot, so a coding session survives
 * a Waypoint restart — the property the founder's "monitor their agent …
 * attached to their account" asks for and that no in-process design
 * delivered across three rounds of architecture review (ROAD-44, the epic).
 * It also carries every provider emdash supports. The cost is this client.
 *
 * Provenance of every protocol fact below: emdash `main` at 9b102a5f3,
 * `packages/wire/src/api/protocol.ts` (message shapes),
 * `packages/wire/src/api/transports/stream.ts` (framing),
 * `apps/workspace-server/src/api/controller.ts` (`health`/`initialize`),
 * `apps/workspace-server/src/config.ts` (CLI commands and serve modes),
 * `packages/core/src/workspace-server/versions/index.ts` (protocol semver).
 */

// ---------------------------------------------------------------------------
// 1. The pinned engine build (ROAD-46)
// ---------------------------------------------------------------------------

/**
 * Exactly the archive Waypoint ships. Built from emdash source with
 * `pnpm run package --target darwin-arm64 --verify` and smoke-tested
 * (start → status → stop on an isolated socket) before being pinned.
 * `engine.lock.json` at the package root is the machine-readable twin; this
 * constant exists so main-process code can refuse to run anything else.
 */
export const ENGINE_PIN = {
  name: 'emdash-workspace-server',
  version: '0.1.0',
  /** The daemon's own Wire protocol version, from its manifest.json. */
  protocolVersion: '1.0.0',
  /** Commit of Waypoint's fork of emdash (amaannawab923/emdash, branch
   *  `waypoint`) the archive was built from — upstream 9b102a5f3 plus
   *  Waypoint's own commits. 98c39e40e adds `mcpServers` to `acp.start`,
   *  which sessionMcpServers.ts depends on: without it the daemon drops
   *  the field and a dispatched session gets no Waypoint tools at all. */
  sourceCommit: '98c39e40e',
  target: 'darwin-arm64',
  sha256: 'c5e3b437b8b4b201915082840ac1214daa61a72452b6fac9333aba367faca10b',
  /** Inside the extracted archive: the shell launcher that execs the bundled
   *  `node` on `dist/index.mjs`. Takes the CLI commands in `EngineCommand`. */
  launcherRelPath: 'emdash-workspace-server/bin/emdash-workspace-server',
  /**
   * sha256 of that launcher — the nine-line `sh` script Waypoint main
   * spawns on every look and every start. Re-verified before each spawn
   * (installer.ts, verifyInstalledEngine): the archive is hash-checked
   * once at extraction, but the extracted tree is user-writable for the
   * life of the install, and W4's agents will run two directories away
   * from it. A launcher that is not the pinned one is `failed`/install,
   * never run. (Review round 2.)
   */
  launcherSha256:
    'a6f569e3f1da7287011ae19a65cd811123d539db411342f199181b0dfbf7420d',
} as const;

/**
 * The protocol version this client speaks. Sent in `initialize`; the daemon
 * answers compatible-or-not by semver major (see `negotiateProtocol` in
 * emdash). A major bump on the daemon side is a deliberate upgrade, never a
 * float — ROAD-96.
 */
export const CLIENT_PROTOCOL_VERSION = '1.0.0';

/** The launcher's commands (`apps/workspace-server/src/config.ts:7`). */
export type EngineCommand = 'serve' | 'start' | 'stop' | 'status';

// ---------------------------------------------------------------------------
// 2. Where the engine lives on disk (ROAD-51)
// ---------------------------------------------------------------------------

/**
 * Every path is under Waypoint's own `userData`, never under `~/.emdash`, so
 * a developer who also runs emdash never has the two fight over one socket
 * or one state database.
 *
 * `HOME` is deliberately NOT overridden for the daemon. The first draft of
 * ROAD-51 said "isolated HOME"; that would also hide `~/.claude/` from the
 * `claude` CLI the daemon spawns, and the CLI's own login lives there. What
 * actually needs isolating is the MCP-server list the Claude plugin reads
 * from `~/.claude.json` — and that only matters once sessions start, so it
 * moves to W5 (ROAD-74, the loopback proxy) where the session's MCP list is
 * decided. Recorded on ROAD-51.
 */
export interface EnginePaths {
  /** Extracted archive root, e.g. `<userData>/engine/0.1.0/`. */
  installDir: string;
  /** Absolute path to the launcher script inside `installDir`. */
  launcherPath: string;
  /**
   * The Node binary the engine archive ships, beside the launcher.
   *
   * This is what Waypoint's own MCP servers are spawned with. It used to
   * be `process.execPath` (this app's Electron binary, with
   * ELECTRON_RUN_AS_NODE=1) because the daemon's PATH resolved `npx` to a
   * Node 18 the servers refuse. That worked, but measured on macOS
   * 2026-09-24: running the Electron binary — an .app bundle with no
   * LSBackgroundOnly — makes LaunchServices register the child as
   * `type="Foreground"` REGARDLESS of ELECTRON_RUN_AS_NODE, so every
   * server got a Dock tile. The engine's own node registers
   * `BackgroundOnly` and gets none, is Node 24 (new enough for both
   * servers), and is covered by the archive's pinned sha256.
   */
  nodePath: string;
  /**
   * Unix domain socket the daemon serves on (socket mode). MUST be at most
   * `MAX_UNIX_SOCKET_PATH` bytes: observed live, a 150-char path fails with
   * `connect EINVAL` from the daemon's own `start`, which is why emdash's
   * default is the short `~/.emdash/…`. `resolveEnginePaths` refuses a longer
   * one with a message naming the limit rather than letting `start` fail
   * with EINVAL.
   */
  socketPath: string;
  /**
   * The directory holding the socket. Observed live: the daemon writes
   * `<socket>.pid` (mode 0600) and `<socket>.log` beside the socket, and —
   * not configurable, it follows the socket — its SQLite stores
   * (`workspace-registry.db`, `conversations.db`, `automations.db`,
   * `file-search.db`) under `stateDir` below.
   */
  runDir: string;
  /**
   * Where the daemon keeps its SQLite stores. Derived, never chosen: emdash's
   * `workspaceServerRuntimePaths` (`apps/workspace-server/src/runtime/paths.ts:19-22`)
   * strips a trailing `run` segment from the socket's directory and appends
   * `state` — so with `runDir = <engine>/run` this is `<engine>/state`, a
   * sibling of `run`, not inside it. `paths.ts` and its test pin exactly
   * that; the first draft of this comment said `<runDir>/state` and was wrong.
   */
  stateDir: string;
  /** Where Waypoint keeps the engine's stdout/stderr when it spawns it. */
  logPath: string;
  /**
   * Where a run's worktree goes: `<userData>/worktrees/<run id>` (ROAD-55).
   * Outside every linked checkout — the daemon's own path safety refuses a
   * worktree inside its repository — outside the engine tree (an agent
   * must not sit beside the launcher main spawns), and inside Waypoint's
   * data directory, so what Waypoint created, Waypoint can account for
   * and remove.
   */
  worktreesDir: string;
}

/**
 * `sun_path` is 104 bytes on macOS (108 on Linux). Measured in review on
 * this macOS with the same libuv the bundled node uses: a 104-byte path
 * binds and connects, 105 fails with EINVAL — so 104 usable bytes, and
 * `paths.ts` counts the path plus one for the terminating NUL against this
 * limit, which is conservative by exactly one byte. In the safe direction.
 */
export const MAX_UNIX_SOCKET_PATH = 104;

// ---------------------------------------------------------------------------
// 3. Transport (ROAD-50): bytes in, bytes out, mode-agnostic
// ---------------------------------------------------------------------------

/**
 * How Waypoint reaches a serving daemon. `socket` connects to an already
 * running daemon (started with `start --socket`); it outlives Waypoint.
 * `stdio` spawns `serve --stdio` as a child and speaks over its pipes; it
 * dies with Waypoint. Socket is the mode on macOS and Linux. Stdio exists
 * so Windows — no Unix sockets — is a packaging task later, not an
 * architecture change (ROAD-99).
 */
export type EngineTransportMode = 'socket' | 'stdio';

export type Unsubscribe = () => void;

/**
 * A connected byte stream to one serving daemon. Framing is the Wire
 * client's job, not the transport's: the transport moves bytes, and the
 * same client works over either mode.
 */
export interface EngineTransport {
  readonly mode: EngineTransportMode;
  /** Write raw bytes. Throws if closed. */
  send(bytes: Uint8Array): void;
  onData(cb: (chunk: Uint8Array) => void): Unsubscribe;
  /** Fires exactly once, when the underlying socket/pipe is gone. */
  onClose(cb: (reason: EngineTransportCloseReason) => void): Unsubscribe;
  close(): void;
}

export type EngineTransportCloseReason =
  | { kind: 'closed-by-us' }
  | { kind: 'peer-closed' }
  | { kind: 'error'; message: string }
  /** stdio mode only: the child exited. */
  | { kind: 'child-exited'; code: number | null; signal: string | null };

// ---------------------------------------------------------------------------
// 4. Wire messages (ROAD-49) — the subset Waypoint speaks
// ---------------------------------------------------------------------------

/**
 * Frame layout (`stream.ts` in emdash): a 5-byte header — one type byte
 * (0x00 JSON, 0x01 binary) then a big-endian u32 body length — followed by
 * the body. JSON frames carry one `WireMessage`. Binary frames are the
 * blob-chunk path for file uploads, which Waypoint does not use in W1; the
 * codec must still skip them correctly rather than desync the stream.
 * Max frame 16 MiB.
 */
export const WIRE_FRAME_JSON = 0x00;
export const WIRE_FRAME_BINARY = 0x01;
export const WIRE_HEADER_BYTES = 5;
export const WIRE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * The daemon's own vocabulary, uppercase — `packages/wire/src/api/protocol.ts:4-16`,
 * and observed live: an unknown path answers `UNKNOWN_PROCEDURE`, an unknown
 * topic `UNKNOWN_TOPIC`, a Zod-rejected input `HANDLER_ERROR` with the Zod
 * issues as the message. `DISCONNECTED` and `TIMEOUT` are also what this
 * client uses for its own locally-detected failures, so a caller sees one
 * vocabulary.
 */
export type WireErrorCode =
  | 'CANCELLED'
  | 'DISCONNECTED'
  | 'SERIALIZATION'
  | 'UNKNOWN_PROCEDURE'
  | 'UNKNOWN_TOPIC'
  | 'NOT_FOUND'
  | 'MISSING_HANDLER'
  | 'CONTRACT_MISMATCH'
  | 'ALREADY_EXISTS'
  | 'TIMEOUT'
  | 'HANDLER_ERROR';

export interface WireCallMessage {
  kind: 'call';
  id: string;
  /** Dotted procedure path, e.g. `health`, `initialize`, `acp.start`. */
  path: string;
  /**
   * OMIT this key for a void procedure. Observed live: `health` is declared
   * `z.void().optional()` (`workspace-server/wire/contract.ts:13`) and
   * answers `HANDLER_ERROR "expected void, received null"` to `input: null`.
   * JSON.stringify drops an `undefined` property, which is what makes
   * `call('health')` with no input work.
   */
  input?: unknown;
}
export interface WireCancelMessage {
  kind: 'cancel';
  id: string;
}
export interface WireAttachMessage {
  kind: 'attach';
  id: string;
  topic: string;
}
export interface WireDetachMessage {
  kind: 'detach';
  topic: string;
}
export interface WireSnapshotMessage {
  kind: 'snapshot';
  id: string;
  topic: string;
}
export type WireResultMessage =
  | { kind: 'result'; id: string; ok: true; value: unknown }
  | {
      kind: 'result';
      id: string;
      ok: false;
      code: WireErrorCode;
      message: string;
      cause?: unknown;
    };
/**
 * One change to an attached topic. `update` is emdash's `LiveUpdate` —
 * either a full replacement or a patch list; the client hands it to the
 * subscriber verbatim and lets the consumer decide (in W1 nobody attaches
 * anything but a debug view; W3's store adapter is the real consumer).
 */
export interface WireUpdateMessage {
  kind: 'update';
  topic: string;
  update: unknown;
}
export interface WireTopicGapMessage {
  kind: 'topic-gap';
  topic: string;
}
export interface WireTopicErrorMessage {
  kind: 'topic-error';
  topic: string;
  error: { code: WireErrorCode; message: string };
  retrying: boolean;
}
export type WireMessage =
  | WireCallMessage
  | WireCancelMessage
  | WireAttachMessage
  | WireDetachMessage
  | WireSnapshotMessage
  | WireResultMessage
  | WireUpdateMessage
  | WireTopicGapMessage
  | WireTopicErrorMessage;

/** What the daemon answers on `health` (`controller.ts:30`). Observed live:
 *  `{status:'ok', version:'0.1.0', uptimeMs:1478, protocolVersion:'1.0.0'}`. */
export interface EngineHealth {
  status: 'ok';
  version: string;
  uptimeMs: number;
  protocolVersion: string;
}

/**
 * `initialize` input — `clientHelloSchema`
 * (`packages/core/src/workspace-server/versions/schemas.ts:3-9`). The
 * `client` object is REQUIRED; without it the daemon answers
 * `HANDLER_ERROR "client: expected object"` (observed live).
 */
export interface EngineInitializeInput {
  protocolVersion: string;
  client: { id: string; appVersion: string };
}

/**
 * `initialize` is a `fallible` procedure. On the wire that means the
 * transport-level result is `ok: true` and its `value` carries emdash's own
 * Result envelope — `{ success: true, data }` or `{ success: false, error }`
 * — NOT `ok`/`value` again. Observed live against 0.1.0:
 *
 *   protocolVersion '1.0.0' → { success: true,  data: { agreedVersion: '1.0.0', agreedMinor: 0, server: {…} } }
 *   protocolVersion '9.0.0' → { success: false, error: { type: 'protocol-incompatible', action: 'upgrade-server', … } }
 *
 * A caller that reads `.ok` on the value will find it undefined and treat
 * every handshake as failed; this is the shape.
 */
export type EngineInitializeResult =
  | { success: true; data: EngineInitializeOk }
  | { success: false; error: EngineInitializeError };

export interface EngineInitializeOk {
  protocolVersion: string;
  agreedVersion: string;
  agreedMinor: number;
  server: { appVersion: string; daemonId: string; startedAt: number };
}
export interface EngineInitializeError {
  type: 'protocol-incompatible';
  /** e.g. 'upgrade-server' | 'upgrade-client' — the daemon's own words. */
  action: string;
  clientProtocolVersion: string;
  serverProtocolVersion: string;
}

/**
 * Thrown by `WireClient.call` when the daemon answers `ok: false`, or when
 * the transport drops mid-call (`code: 'DISCONNECTED'`). Carries the
 * daemon's own code and message so the supervisor and, later, the panel can
 * say what actually happened rather than "engine error".
 */
export class EngineCallError extends Error {
  readonly code: WireErrorCode;

  readonly path: string;

  readonly cause?: unknown;

  constructor(
    path: string,
    code: WireErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'EngineCallError';
    this.code = code;
    this.path = path;
    this.cause = cause;
  }
}

/**
 * The client the supervisor (and later every session feature) uses. One
 * instance per connected transport. Pure request/response plus topic
 * subscription; no reconnect logic — that is the supervisor's decision to
 * make (and to report honestly), not the client's to hide.
 */
export interface WireClient {
  call<T = unknown>(
    path: string,
    input?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  /**
   * One snapshot of a live topic — `{generation, sequence, timestamp,
   * data}` — with no attachment made or needed. The read for a caller
   * that wants the value now and not the updates (reconcile), and the
   * resync for one that already holds the attachment.
   */
  snapshot<T = unknown>(
    topic: string,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  /**
   * Subscribes to a live topic. Resolves once the initial snapshot arrives,
   * with a detach function. `onUpdate` receives every subsequent `update`
   * verbatim; `onGap`/`onError` are the daemon telling us we missed
   * something or the topic itself failed.
   */
  attach(
    topic: string,
    handlers: {
      onSnapshot: (value: unknown) => void;
      onUpdate: (update: unknown) => void;
      onGap?: () => void;
      onError?: (
        error: WireTopicErrorMessage['error'],
        retrying: boolean,
      ) => void;
    },
  ): Promise<Unsubscribe>;
  onDisconnect(cb: (reason: EngineTransportCloseReason) => void): Unsubscribe;
  /** Closes the transport; every pending call rejects with `DISCONNECTED`. */
  close(): void;
}

// ---------------------------------------------------------------------------
// 5. Supervisor state (ROAD-48) — what the renderer is told
// ---------------------------------------------------------------------------

/**
 * The engine's state as Waypoint can actually vouch for it. Every variant is
 * a claim the UI may render, so each one is only reachable when the
 * supervisor has observed the thing it names — this is the same posture as
 * the Jira connection status and the Claude CLI probe on MachinePage
 * (`Probe<T>`, never a fabricated status).
 */
export type EngineStatus =
  /** Nothing runnable at `installDir` and nothing to extract it from. (An
   *  archive whose sha256 does not match the pin is `failed`/`install`,
   *  not this: that is a fact to show, not an absence.) */
  | { kind: 'not-installed'; installDir: string }
  /** Installed; no daemon answering on the socket; not asked to start. */
  | { kind: 'stopped'; installDir: string; version: string }
  /** `start` issued; waiting for the socket to answer `health`. */
  | { kind: 'starting'; since: number }
  /** Socket answers and `initialize` agreed a protocol version. */
  | {
      kind: 'running';
      since: number;
      health: EngineHealth;
      agreed: EngineInitializeOk;
      transport: EngineTransportMode;
    }
  /** `stop` issued; waiting for the process to go away. */
  | { kind: 'stopping'; since: number }
  /** Something the supervisor observed and could not recover from. */
  | {
      kind: 'failed';
      since: number;
      /** Which step failed, in the supervisor's own vocabulary. */
      stage: 'install' | 'start' | 'connect' | 'initialize' | 'health' | 'stop';
      message: string;
      /** The daemon refused our protocol version. Upgrade, don't retry. */
      incompatible?: EngineInitializeError;
    };

// ---------------------------------------------------------------------------
// 6. IPC surface (main ↔ renderer)
// ---------------------------------------------------------------------------

/**
 * Channel names, matching this repo's `<domain>:<verb>` convention
 * (`jira:comments:post`, `copilot:proposals:approve`). Read from
 * `preload.ts` and `engineIpc.ts` — never retyped.
 */
export const ENGINE_IPC = {
  /** → EngineStatus. Never throws; a broken engine is a status, not an error. */
  status: 'engine:status',
  /** Ensures the archive is extracted and verified. → EngineStatus. */
  install: 'engine:install',
  /** `start --socket`, connect, `initialize`, `health`. → EngineStatus. */
  start: 'engine:start',
  /** `stop`. → EngineStatus. */
  stop: 'engine:stop',
  /** A fresh `health` call on the live connection. → EngineHealth | null. */
  health: 'engine:health',
  /** Push channel: every EngineStatus transition, in order. */
  statusChanged: 'engine:status-changed',

  // --- Live topics and calls for the sessions panel (ROAD-60) ------------
  // The renderer never sees the Wire client. It asks main for a topic by
  // name; main attaches on the live connection, answers with the first
  // snapshot, and pushes every update — each renderer subscription is one
  // daemon attachment, identified by the `subscriptionId` main mints.
  // Only topics matching ALLOWED_TOPIC (a run's ACP session states, the
  // session list, the workspace records) and procedures in
  // ALLOWED_PROCEDURES can cross: the bridge stays as narrow as what the
  // panel needs, and a conversation that is not one of our runs is not
  // reachable from the renderer at all.
  /** (topic) → { subscriptionId, snapshot }. Throws when not running or not allowed. */
  topicSubscribe: 'engine:topic:subscribe',
  /** (subscriptionId) → void. Idempotent. */
  topicUnsubscribe: 'engine:topic:unsubscribe',
  /** (subscriptionId) → a fresh snapshot of the same topic (resync). */
  topicSnapshot: 'engine:topic:snapshot',
  /** Push: { subscriptionId, update: LiveUpdate }. */
  topicUpdate: 'engine:topic:update',
  /** Push: { subscriptionId, reason } — the topic is gone (daemon away, topic failed). */
  topicClosed: 'engine:topic:closed',
  /** (procedure, input) → the daemon's answer, for ALLOWED_PROCEDURES only. */
  call: 'engine:call',
} as const;

// ---------------------------------------------------------------------------
// Run control for the sessions panel (W3, ROAD-61/64). The renderer names a
// run; main looks the run up in the ledger and acts on the daemon, the
// worktree on disk, or the OS shell — the renderer never names a path or a
// daemon record. Registered by runsIpc.ts.
// ---------------------------------------------------------------------------
export const RUNS_IPC = {
  /** (runId) → StopRunResult. Cancels the turn, kills the session, marks the run cancelled. */
  stop: 'runs:stop',
  /** (runId) → RunDiff. The worktree's changes against the run's base ref. */
  diff: 'runs:diff',
  /** (runId) → void. Shows the worktree in the OS file manager. */
  revealWorktree: 'runs:reveal-worktree',
  /** (runId) → WorktreeHealth. Whether the run's worktree still resolves to a repository, read live from git (feedback round 1, finding A). */
  worktreeHealth: 'runs:worktree-health',
  /** (runId) → CloseRunPreview. What closing the run would remove, for the confirm (Fix 8). */
  closePreview: 'runs:close-preview',
  /** (runId) → CloseRunResult. Removes a finished run's worktree, and its branch unless a pull request needs it (Fix 8). */
  close: 'runs:close',
  /**
   * (StartRunInput) → AgentRun, answered once the row is `provisioning`;
   * the worktree and the session follow in main (W4, ROAD-67,
   * docs/design/w4-start-session.md §3). Every later status arrives as
   * `changed`.
   */
  start: 'runs:start',
  /** (runId) → ResumeRunResult. A run that is not live, back on its worktree — the explicit path; a send does the same on its own (never-lock). */
  resume: 'runs:resume',
  /**
   * ({ runId, text }) → SendRunPromptResult. Sends a chat message to a
   * run — whatever its status (never-lock, 2026-09-20): handed to the
   * daemon, queued behind a working turn, continued/resumed first, or
   * accepted into the run's outbox and delivered when it can be. Replaces
   * the renderer's old direct use of the generic `acp.sendPrompt`
   * daemon-bridge procedure, which has no run-status awareness at all.
   */
  sendPrompt: 'runs:send-prompt',
  /**
   * (runId) → WarmRunResult. Never-lock: on opening a run whose daemon
   * session is gone, load it again — daemon only, the ledger untouched —
   * so the person's first message is a plain send. Parity with emdash's
   * `start()` on tab open.
   */
  warm: 'runs:warm',
  /** (runId) → PendingPrompt[]. The run's outbox, for the transcript's pending rows. */
  listPendingPrompts: 'runs:list-pending-prompts',
  /** ({ runId, pendingId }) → PendingPrompt. The person drops an outbox row. */
  dropPendingPrompt: 'runs:drop-pending-prompt',
  /** ({ runId, pendingId }) → SendRunPromptResult. Retry a pending row now (resets its automatic-attempt counter). */
  retryPendingPrompt: 'runs:retry-pending-prompt',
  /** (folder handle) → RunBranches. The folder's local branches, through the engine. */
  listBranches: 'runs:list-branches',
  /**
   * () → FolderChoice. The OS folder picker, parented to the window; the
   * folder comes back as a handle, never a path (W4b, ROAD-116,
   * docs/design/w4b-sessions-anywhere.md §2).
   */
  chooseFolder: 'runs:choose-folder',
  /** () → SessionFolder[]. Recent folders and every project's linked repository, as handles. */
  recentFolders: 'runs:recent-folders',
  /** () → string. The home directory, so the panel can show a run's folder as `~/…`. */
  homeDir: 'runs:home-dir',
  /**
   * (BriefPreviewInput) → BriefPreview. The brief a dispatched session
   * would be given, built in main from the ledger's view of the ticket,
   * plus the facts the preview dialog shows (W5a, ROAD-119,
   * docs/design/w5a-investigate-fix.md §1.3).
   */
  briefPreview: 'runs:brief-preview',
  /**
   * (DispatchRunInput) → AgentRun, answered once the row is
   * `provisioning`; a fresh worktree of the ticket's project repository
   * and the session follow in main, the brief as the first prompt.
   */
  dispatch: 'runs:dispatch',
  /**
   * Push: RunFocus — the person clicked a notification about a run
   * (engine/notifications.ts); the renderer opens the sessions panel on it.
   */
  focus: 'runs:focus',
  /**
   * (runId) → OpenPrResult. W6: push the run's branch and open its pull
   * request as the person — the retry for a publish that failed at
   * finalize (engine/runs/pullRequests.ts).
   */
  openPr: 'runs:open-pr',
  /**
   * (identifier) → ResolvedTicket | null. W5b: a typed key (`ROAD-116`,
   * `ENG-4`) to the ticket it names in either system, through the
   * backend's dual lookup with main's Jira credential — so a slash
   * command on a Jira key opens the same preview a native key does.
   * Throws with the backend's sentence when the key is ambiguous.
   */
  resolveTicket: 'runs:resolve-ticket',
  /**
   * ({ key, title }) → JiraTicketRef. W5b: the ledger handle (`tref-…`)
   * for a Jira issue the renderer has read through main's Jira client —
   * minted through the backend with the site from main's stored
   * credential, never the renderer's. What the My Jira drawer's Sessions
   * section names.
   */
  jiraTicketRef: 'runs:jira-ticket-ref',
  /**
   * Push: RunChanged — main wrote a run's ledger row from what the daemon
   * reported (runs/liveLedgerFollower.ts) or from a start/resume it is
   * driving (runs/startRun.ts). The renderer re-reads the ledger; the
   * payload is a hint, not the row.
   */
  changed: 'runs:changed',
} as const;

/**
 * The providers `runs:start` will hand to the daemon — a subset of the
 * daemon's own registry, listed here because a session on a provider
 * nobody has verified against this pin is not a session Waypoint should
 * start. Claude now; Codex arrives with W7 (ROAD-66's note). The New
 * session dialog offers exactly this list.
 */
export const SUPPORTED_PROVIDERS = ['claude'] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDERS)[number];

/** The most a session title may be — one line, as the row shows it. */
export const MAX_RUN_TITLE_CHARS = 120;
/** The most a first message typed in the dialog may be. */
export const MAX_FIRST_MESSAGE_CHARS = 20_000;

/**
 * Where the agent works (W4b): `worktree` — a fresh worktree Waypoint
 * provisions and owns; `directory` — the picked folder, edited in place.
 */
export type RunIsolation = 'worktree' | 'directory';

/** The provider mode an auto-approved session starts in (verified live on the Claude adapter). */
export const AUTO_APPROVE_MODE_ID = 'bypassPermissions';
/**
 * The provider mode a reading session starts in — the Claude adapter's
 * "planning mode, no actual tool execution": reads, no edits, no
 * commands. Investigate, and *Something else…* with "may change files"
 * off (W5a §2.1).
 */
export const PLAN_MODE_ID = 'plan';

/**
 * What a dispatched run was asked to do (W5a): find the root cause and
 * change nothing; implement the fix; or the person's own instruction.
 */
export type RunIntent = 'investigate' | 'fix' | 'custom';
export const RUN_INTENTS: readonly RunIntent[] = [
  'investigate',
  'fix',
  'custom',
];

/** The most a brief may be once the person has edited it — the same bound as a first message. */
export const MAX_BRIEF_CHARS = MAX_FIRST_MESSAGE_CHARS;
/** The most a *Something else…* instruction may be. */
export const MAX_INSTRUCTIONS_CHARS = 4_000;

/** What the renderer sends to `runs:brief-preview`: a ticket and a verb. */
export interface BriefPreviewInput {
  /** A native ticket's id (`wi-…`) or a Jira issue's ledger handle (`tref-…`, W5b). */
  ticketId: string;
  intent: RunIntent;
  /** *Something else…*: the person's instruction. Ignored for the other verbs. */
  instructions?: string | null;
  /** *Something else…*: whether the session may edit files (else plan mode). */
  mayChangeFiles?: boolean;
  /**
   * Writing sessions: after the change, start the app and drive the
   * reproduction in the session's isolated browser, taking screenshots
   * that land in the transcript (runs/sessionBrowser.ts). Ignored for
   * plan mode.
   */
  verifyInBrowser?: boolean;
  /** The base branch for the worktree; null = the repository's suggested one. */
  baseRef?: string | null;
  /**
   * W5b, Jira issues only: the folder the person chose in the preview (a
   * `SessionFolder.handle`), when the Jira project has no remembered
   * folder yet or they picked *Change*. Ignored for a native ticket, whose
   * project's linked repository decides.
   */
  folder?: string | null;
}

/** Which system a ticket lives in (W5b). */
export type TicketSystem = 'waypoint' | 'jira';

/** The brief and the facts the preview dialog shows before Start. */
export interface BriefPreview {
  ticketId: string;
  /** `ROAD-116`. */
  identifier: string;
  title: string;
  intent: RunIntent;
  /** The text the session will be given as its first prompt; editable in the dialog. */
  brief: string;
  /**
   * The repository the session will take a worktree of: the project's
   * linked repository for a native ticket; for a Jira issue the folder
   * remembered for its project, or the one the request chose — null when
   * neither exists yet, and the dialog asks (W5b §1.2).
   */
  repo: SessionFolder | null;
  /** Empty when `repo` is null. */
  branches: RunBranches;
  /** W5b: where the ticket lives. */
  ticketSystem: TicketSystem;
  /** W5b: a Jira issue's URL; null for a native ticket. */
  ticketUrl: string | null;
  /** W5b: the Jira project the folder is (or will be) remembered for; null for a native ticket. */
  jiraProjectKey: string | null;
  /** W5b: true when `repo` came from the remembered mapping, so the dialog offers *Change*. */
  repoRemembered: boolean;
  /** The base branch the brief was built for. */
  baseRef: string | null;
  /** The branch the worktree will be on (`agent/ROAD-116`, deduplicated by W2's rule at provisioning). */
  branchHint: string;
  /** Plan mode (reads only) or a writing session. */
  mode: 'plan' | 'write';
  /** A writing session's default for the auto-approve switch (§2.5). */
  autoApproveDefault: boolean;
  /**
   * Fix only: the approved root-cause comment the brief was seeded from,
   * when the ticket's latest Investigate produced one (§1.9).
   */
  seededFromRunId: string | null;
  /**
   * A writing run already live on this ticket (§2.2: one writer per
   * ticket at a time). The dialog says so and offers to open it; Start
   * is refused for a writing session while this is set.
   */
  liveWriterRunId: string | null;
}

/** What the renderer sends to `runs:dispatch`: the previewed brief, possibly edited. */
export interface DispatchRunInput {
  ticketId: string;
  intent: RunIntent;
  /** The brief as the person left it — stored on the run as its first message. */
  brief: string;
  /** *Something else…*: whether the session may edit files. Investigate is always plan; Fix always writes. */
  mayChangeFiles?: boolean;
  /** Writing sessions only; ignored (false) for plan mode. */
  autoApprove: boolean;
  /** A local branch of the repository, from the preview's `branches`. */
  baseRef: string;
  ownerMemberId: string;
  providerId: SupportedProviderId;
  /** The Copilot conversation the verb was used from, when it was; notes go back there. */
  copilotConversationId?: string | null;
  /** W5b, Jira issues only: the folder chosen in the preview, remembered for the Jira project on Start. */
  folder?: string | null;
}

/** What `runs:resolve-ticket` answers: a typed key's ticket, in either system (W5b). */
export interface ResolvedTicket {
  provider: 'native' | 'jira';
  /** `wi-…` or `tref-…` — what a brief preview names. */
  id: string;
  identifier: string;
  title: string;
  /** Native: the project id. Jira: the project key. */
  projectId: string;
  url: string | null;
}

/** What `runs:jira-ticket-ref` answers: a Jira issue's ledger handle (W5b). */
export interface JiraTicketRef {
  /** `tref-…`. */
  ticketId: string;
  /** `ENG-4`. */
  identifier: string;
  title: string;
  url: string | null;
}

/** Push payload of `runs:focus`. */
export interface RunFocus {
  runId: string;
}

/** What `runs:open-pr` answers. */
export type OpenPrResult =
  | { kind: 'opened'; url: string }
  /** Never-lock: the branch had a PR still open; new commits were pushed to it. */
  | { kind: 'updated'; url: string }
  | { kind: 'pushed-only'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; stage: 'push' | 'pr'; message: string };

/**
 * A folder the person may start a session in, as main describes it. The
 * `handle` is what the renderer hands back; the path is for display only.
 */
export interface SessionFolder {
  handle: string;
  /** Absolute, canonical. Shown, never sent back. */
  path: string;
  /** `path` with the home directory as `~`. */
  displayPath: string;
  /** The last path segment. */
  name: string;
  /** A git repository (a `.git` directory or file) or a plain folder. */
  kind: 'repo' | 'folder';
  /** The project whose linked repository this is, if any. */
  projectId: string | null;
  projectName: string | null;
  /** The auto-approve choice the last session here was started with. */
  lastAutoApprove: boolean | null;
  /** When a session was last started here; null for a linked repo never used. */
  lastUsedAt: string | null;
}

export type FolderChoice =
  { canceled: true } | { canceled: false; folder: SessionFolder };

/** What the renderer sends to `runs:start`. It names a folder handle, never a path. */
export interface StartRunInput {
  /** A `SessionFolder.handle` from `runs:choose-folder` or `runs:recent-folders`. */
  folder: string;
  /** The current member (data/currentUser.ts) — ROAD-8 replaces this with the session's. */
  ownerMemberId: string;
  providerId: SupportedProviderId;
  isolation: RunIsolation;
  autoApprove: boolean;
  /** Worktree runs only: a local branch of the folder's repository (`runs:list-branches`). */
  baseRef?: string | null;
  /** Queued as the session's first prompt; its first line names the run. */
  firstMessage?: string | null;
}

/** Why a message sits in the run's outbox rather than with the daemon (agent_run_pending_prompts.reason). */
export type PendingPromptReason =
  | 'starting'
  | 'finishing'
  | 'folder-missing'
  | 'repository-missing'
  | 'spawn-failed'
  | 'owner-offline'
  /** An earlier row in this run's outbox is still resolving (found in
   * review: a live/just-resumed send blocked behind one used to be
   * mislabeled `starting`, which is false once the session is already
   * up). */
  | 'blocked-by-earlier'
  /**
   * `runs:close` already removed this run's worktree and branch (B4,
   * PR #88 review) — unlike every other reason here, nothing clears
   * this on its own; there is no worktree left to recreate on purpose.
   * The person has to start a new session.
   */
  | 'closed';
export type PendingPromptState =
  'queued' | 'sending' | 'delivered' | 'unresolved' | 'dropped';
export interface PendingPrompt {
  id: string;
  runId: string;
  seq: number;
  byMemberId: string;
  text: string;
  reason: PendingPromptReason;
  state: PendingPromptState;
  autoAttempts: number;
  lastError: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export type ResumeRunOutcome =
  /** The provider restored the previous conversation. */
  | 'loaded'
  /**
   * The provider could not restore it: the daemon started a fresh session
   * in the same worktree and Waypoint sent it the branch state as its
   * first message.
   */
  | 'replaced-by-new'
  /**
   * The run was live already — nothing to resume; the caller sends to
   * the live session (never-lock: never a refusal).
   */
  | 'already-live'
  /**
   * A Stop landed between reopenRun and startSession: the person
   * overrode the resume. The status is wherever the Stop left it.
   */
  | 'cancelled-mid-resume'
  /**
   * The run's worktree could not be reached and could not be recreated —
   * its repository is not linked, or its plain folder is gone, or the
   * recreation itself failed (`reason` says which). Not a refusal: a
   * send that meets this is accepted into the run's outbox and delivered
   * when the obstacle clears (sendPrompt.ts).
   */
  | 'cannot-reach-worktree'
  /**
   * The daemon refused to start the session (auth, spawn). The run is
   * back on the status it came from; a send that meets this goes to the
   * outbox with reason `spawn-failed`.
   */
  | 'spawn-failed';

export interface ResumeRunResult {
  outcome: ResumeRunOutcome;
  /** The ledger's status after the action. */
  status: string;
  /** loaded/replaced-by-new only: the run's worktree was gone (or never made) and had to be recreated. */
  worktreeRecreated?: boolean;
  /** worktreeRecreated only: the run's own branch still existed and was reused (commits intact) vs. a fresh branch of the same name cut from baseRef. */
  branchReused?: boolean;
  /** cannot-reach-worktree / spawn-failed only: the outbox reason a send should be accepted under, and the daemon's own sentence. */
  reason?: PendingPromptReason;
  message?: string;
}

/** What `runs:warm` did (never-lock §2.5): daemon only, never the ledger. */
export type WarmRunResult =
  | { kind: 'already-live' }
  | { kind: 'skipped'; why: 'starting' | 'worktree-unusable' | 'no-cwd' }
  | { kind: 'warmed'; loaded: boolean }
  | { kind: 'failed'; message: string };

/**
 * Never-lock (2026-09-20): every send lands somewhere. None of these is a
 * refusal — the text always leaves the box; a `pending` row shows where
 * it went. The only send that hands the text back is `cancelled-mid-
 * resume`, the person's own Stop overriding their own message.
 */
export type SendPromptOutcome =
  /** The run was live and idle; handed straight to the daemon. */
  | 'sent'
  /** The run was live and working; the daemon queued it for the next turn. */
  | 'queued'
  /** A finished run whose session was still alive: reopened and handed over in one step. */
  | 'continued'
  /** The run was not live; resumed (or its worktree recreated), then handed over. */
  | 'resumed-and-sent'
  /** Accepted into the run's outbox; delivered when `reason` clears. */
  | 'outboxed'
  /** A Stop landed mid-resume; the text is the caller's to put back in the box. */
  | 'cancelled-mid-resume';

export interface SendRunPromptResult {
  outcome: SendPromptOutcome;
  /** The ledger's status after the action. */
  status: string;
  /** resumed-and-sent only: whether the provider restored the prior conversation. */
  resume?: ResumeRunOutcome;
  /** resumed-and-sent only: the run's worktree was gone (or never made) and had to be recreated. */
  worktreeRecreated?: boolean;
  /** worktreeRecreated only: whether the run's own branch was reused (commits intact) vs. a fresh one cut from baseRef. */
  branchReused?: boolean;
  /** outboxed only: the row, and why. */
  pending?: PendingPrompt;
}

export interface RunBranches {
  /** Local branch names, sorted. */
  branches: string[];
  /**
   * The branch to preselect: what `origin/HEAD` points at when that is a
   * local branch, else `main`, else `master`, else the first — null when
   * the repository has no local branch at all.
   */
  suggested: string | null;
}

export interface RunChanged {
  runId: string;
  /** The ledger's status after the write. */
  status: string;
}

export type StopRunOutcome =
  /** The ledger says cancelled and the daemon confirmed the session is gone. */
  | 'stopped'
  /**
   * The ledger says cancelled but the daemon did not confirm the kill (no
   * connection, or it refused): the agent may still be running until the
   * next boot reconcile kills it. The panel says so.
   */
  | 'ledger-only'
  /** The run had already ended (done, failed, cancelled): nothing to do. */
  | 'already-ended'
  /** A run waiting on review cannot be cancelled — only its proposals decide it. */
  | 'not-stoppable';

export interface StopRunResult {
  outcome: StopRunOutcome;
  /** The ledger's row after the action. */
  status: string;
}

/**
 * What "Close run" would remove (customer feedback round 1, Fix 8): the
 * worktree always; the branch unless a pull request still needs it. The
 * commit count is what the confirm names when those commits were never
 * pushed and would be lost with the branch.
 */
export interface CloseRunPreview {
  branch: string;
  worktreePath: string;
  /** Commits on the branch past its base that no remote has; null when git could not say. */
  unpushedCommits: number | null;
  /**
   * Working-tree files with no commit at all — tracked or not — that
   * `runs:close` would delete with the worktree; null when git could not
   * say (B1, PR #88 review). `CLOSABLE` includes `failed`, `cancelled`
   * and `interrupted`, where uncommitted work is the norm: an agent
   * mid-edit when the turn errors leaves nothing committed, and
   * `unpushedCommits` alone said nothing about that.
   */
  uncommittedFiles: number | null;
  /** The run opened (or updated) a pull request, so the branch is kept. */
  hasPullRequest: boolean;
  branchWillBeDeleted: boolean;
}

/**
 * What git says about a run's worktree right now (customer feedback round
 * 1, finding A: ROAD-61 showed a live branch line and an enabled Open PR
 * from the ledger's row while its parent repository was gone). Read once
 * when the detail opens; `unknown` when the check could not run, in which
 * case the stored facts stand.
 */
export type WorktreeHealth =
  | { kind: 'ok'; branch: string | null }
  | { kind: 'orphaned'; reason: string }
  | { kind: 'unknown' };

export interface CloseRunResult {
  worktreeRemoved: true;
  branchDeleted: boolean;
  /** Why the branch was kept, when it was. */
  branchKeptBecause: 'pull-request' | null;
}

export type RunDiffFileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface RunDiffFile {
  path: string;
  status: RunDiffFileStatus;
  additions: number;
  deletions: number;
}

export interface RunDiff {
  /** What the worktree was compared against: the merge-base with the run's base ref, or HEAD when there is none. */
  comparedTo: string;
  files: RunDiffFile[];
  /** A unified diff of every file above, untracked files included. */
  patch: string;
  /** True when `patch` was cut at MAX_DIFF_PATCH_CHARS. */
  truncated: boolean;
}

/** A patch longer than this is cut; the file list is always complete. */
export const MAX_DIFF_PATCH_CHARS = 400_000;

/**
 * A live model's snapshot as the daemon answers it (`@emdash/wire`
 * `LiveSnapshot`), and an update (`LiveUpdate`): `delta` is a list of
 * Immer patches applied to the previous state; `baseSequence` must equal
 * the sequence the client holds, and `generation` must match the
 * snapshot's, else the client re-snapshots. Observed live in W2's probes.
 */
export interface LiveSnapshot<T = unknown> {
  generation: number;
  sequence: number;
  timestamp: number;
  data: T;
}
export interface LiveUpdate {
  generation: number;
  baseSequence: number;
  sequence: number;
  timestamp: number;
  delta: unknown;
  mutationIds?: string[];
}

export interface TopicSubscription<T = unknown> {
  subscriptionId: string;
  snapshot: LiveSnapshot<T>;
}
export type TopicClosedReason =
  | { kind: 'disconnected' }
  | { kind: 'topic-error'; code: WireErrorCode; message: string }
  | { kind: 'unsubscribed' };

/** Our runs' conversation ids — the daemon's conversationId IS the run id (ROAD-55). */
const RUN_CONVERSATION = /^run-[A-Za-z0-9]{1,64}$/;
/**
 * Keyless models the renderer may follow. `acp.sessions.list` is not one:
 * the Wire client holds one attachment per topic, and main's own live
 * ledger follower (runs/liveLedgerFollower.ts) owns that one — the
 * renderer learns about the session list through the ledger, which the
 * follower keeps in step, and RUNS_IPC.changed.
 */
const ALLOWED_KEYLESS_TOPICS = new Set(['workspaceRegistry.records.list']);
/**
 * Per-session states of `acp.session` the renderer may follow — the five
 * the panel reads (transcript, plan, pending permissions, usage, and
 * `config`: the provider's mode / model / effort options, for the
 * composer's selectors). The daemon also publishes
 * agents/draft/terminals/mcpServers; nothing in the renderer follows them,
 * so they are not reachable (least privilege, security round 1). Add here
 * when a panel feature needs one.
 */
const ALLOWED_SESSION_STATES = new Set([
  'state',
  'usage',
  'plan',
  'activeTurn',
  'config',
]);

/**
 * Whether the renderer may subscribe to `topic`. Judged by rebuilding: a
 * topic is allowed when it is exactly what `liveTopic()` would produce for
 * an allowed state id and a key of the one shape we hand out
 * (`{conversationId: <run id>}`) — so this and the facade that builds
 * topics share one encoding and cannot drift apart (review round 2; the
 * first draft was a hand-written regex beside `liveTopic`).
 */
export function isAllowedTopic(topic: string): boolean {
  if (ALLOWED_KEYLESS_TOPICS.has(topic)) return true;
  const parts = splitTopic(topic);
  if (!parts || parts.key === undefined) return false;
  const match = /^acp\.session\.([A-Za-z]+)$/.exec(parts.stateId);
  if (!match || !ALLOWED_SESSION_STATES.has(match[1])) return false;
  const key = parts.key as { conversationId?: unknown } | null;
  if (!key || typeof key !== 'object' || Object.keys(key).length !== 1)
    return false;
  if (
    typeof key.conversationId !== 'string' ||
    !RUN_CONVERSATION.test(key.conversationId)
  )
    return false;
  return (
    topic === liveTopic(parts.stateId, { conversationId: key.conversationId })
  );
}
/** `input` is an object whose `conversationId` is one of our runs. */
function isRunInput(input: unknown): input is { conversationId: string } {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { conversationId?: unknown }).conversationId ===
      'string' &&
    RUN_CONVERSATION.test((input as { conversationId: string }).conversationId)
  );
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Procedures the renderer may call, and the check each one's input must
 * pass. Every one is scoped to a run-shaped conversation id, and each
 * check names exactly the fields the panel sends (W3): a prompt is text
 * only — attachments would let the renderer name files for the daemon to
 * read, which W3 has no reason to allow — and a permission answer is one
 * request id and one option id, the daemon's own decision shape.
 */
export const ALLOWED_PROCEDURES: Record<string, (input: unknown) => boolean> = {
  'acp.getHistory': (input) => isRunInput(input),
  'acp.sendPrompt': (input) => {
    if (!isRunInput(input)) return false;
    const { prompt, placement, ...rest } = input as {
      conversationId: string;
      prompt?: unknown;
      placement?: unknown;
    };
    if (Object.keys(rest).length !== 1) return false;
    if (typeof prompt !== 'object' || prompt === null) return false;
    const { text, ...promptRest } = prompt as { text?: unknown };
    if (!isNonEmptyString(text) || Object.keys(promptRest).length !== 0)
      return false;
    return (
      placement === undefined || placement === 'auto' || placement === 'queue'
    );
  },
  'acp.resolvePermission': (input) => {
    if (!isRunInput(input)) return false;
    const { requestId, optionId, ...rest } = input as {
      conversationId: string;
      requestId?: unknown;
      optionId?: unknown;
    };
    return (
      Object.keys(rest).length === 1 &&
      isNonEmptyString(requestId) &&
      isNonEmptyString(optionId)
    );
  },
  'acp.cancelTurn': (input) =>
    isRunInput(input) && Object.keys(input).length === 1,
  // The composer's selectors: a mode (permission policy) or a model /
  // effort the session's own `config` state advertised. One id each; the
  // daemon forwards it to the agent, which refuses one it does not offer.
  'acp.setModeOption': (input) => {
    if (!isRunInput(input)) return false;
    const { value, ...rest } = input as {
      conversationId: string;
      value?: unknown;
    };
    return Object.keys(rest).length === 1 && isNonEmptyString(value);
  },
  'acp.setModelOption': (input) => {
    if (!isRunInput(input)) return false;
    const { dimension, value, ...rest } = input as {
      conversationId: string;
      dimension?: unknown;
      value?: unknown;
    };
    return (
      Object.keys(rest).length === 1 &&
      (dimension === 'model' || dimension === 'effort') &&
      isNonEmptyString(value)
    );
  },
};
