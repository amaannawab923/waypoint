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
} as const;
