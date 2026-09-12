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
  /** emdash commit the archive was built from. */
  sourceCommit: '9b102a5f3',
  target: 'darwin-arm64',
  sha256: '1fa9056e65fcc000c9aaec1c397ec85a97d41a9adedbfdd3b18f5af5dc02b9a6',
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
  /**
   * Push: RunChanged — main wrote a run's ledger row from what the daemon
   * reported (runs/liveLedgerFollower.ts). The renderer re-reads the
   * ledger; the payload is a hint, not the row.
   */
  changed: 'runs:changed',
} as const;

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
 * Per-session states of `acp.session` the renderer may follow — the four
 * the panel reads (transcript, plan, pending permissions, usage). The
 * daemon also publishes config/agents/draft/terminals/mcpServers; nothing
 * in the renderer follows them, so they are not reachable (least
 * privilege, security round 1). Add here when a panel feature needs one.
 */
const ALLOWED_SESSION_STATES = new Set([
  'state',
  'usage',
  'plan',
  'activeTurn',
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
};
