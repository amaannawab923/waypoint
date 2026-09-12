import path from 'path';
import { ENGINE_PIN, MAX_UNIX_SOCKET_PATH, type EnginePaths } from './types';

/**
 * The shape `resolveEnginePaths` actually needs off a pin — widened from
 * `typeof ENGINE_PIN` (whose fields are literal string types from its own
 * `as const`) so a caller testing a future version bump can pass a plain
 * `string` version rather than being forced to satisfy today's exact pinned
 * literals.
 */
export type EnginePin = {
  version: string;
  launcherRelPath: string;
};

/**
 * Where the engine lives on disk (ROAD-51) — see `EnginePaths`' own comment
 * in `types.ts` for the full reasoning; this is the one function that turns
 * it into real paths. Pure and synchronous: nothing here touches the
 * filesystem, so it is safe to call before the supervisor has verified
 * anything actually exists at these locations.
 *
 * Everything nests under `<userData>/engine/`, never `~/.emdash/` (that's
 * emdash's own daemon layout — see `apps/workspace-server/docs/daemon.md`,
 * `~/.emdash/workspace-server/run/workspace.sock` and siblings). A developer
 * who happens to also run emdash's own daemon on this machine must never have
 * the two processes fight over one socket or one state database, and nesting
 * under Waypoint's own `userData` is what guarantees that.
 *
 * `HOME` is deliberately not touched here or by the supervisor that spawns
 * this process — restated briefly from `types.ts` §2: isolating it would
 * also hide `~/.claude/` from the `claude` CLI this daemon spawns, breaking
 * that CLI's own login. The one thing that genuinely needs isolating (the
 * MCP-server list `~/.claude.json` feeds the Claude plugin) only matters once
 * a session actually starts, so it moves to W5 (ROAD-74, the loopback proxy)
 * instead of being invented here.
 *
 * `runDir`'s basename is load-bearing and must stay literally `run`: emdash's
 * own `workspaceServerRuntimePaths` (`apps/workspace-server/src/runtime/paths.ts:18-22`)
 * derives the daemon's OWN state directory by stripping a trailing `run`
 * segment off the socket's directory and appending `state` — so as long as
 * `socketPath` sits inside a directory named `run`, the daemon computes
 * exactly the `stateDir` documented below, with no separate environment
 * variable to pass. This was verified, not assumed: `apps/workspace-server/
 * src/config.ts:5,17-38` shows the daemon reads only `command`, `mode`,
 * `socketPath`, and `appVersion` (under the `EMDASH_WS_` prefix) — nothing
 * there names a state directory, so there is no `EMDASH_WS_STATE_DIR`-style
 * variable to invent or pass; the socket path is the only lever that exists.
 */
export function resolveEnginePaths(
  userData: string,
  pin: EnginePin = ENGINE_PIN,
): EnginePaths {
  const engineRoot = path.join(userData, 'engine');
  const installDir = path.join(engineRoot, pin.version);
  const runDir = path.join(engineRoot, 'run');
  const socketPath = path.join(runDir, 'workspace.sock');

  // Observed live: a 150-character socket path made the daemon's own
  // `start` fail with `connect EINVAL` — `sun_path` is 104 bytes on macOS
  // (types.ts, MAX_UNIX_SOCKET_PATH). A typical userData path
  // (`~/Library/Application Support/waypoint-frontend/engine/run/…`) is
  // ~85 bytes for a short username, so this only trips on a long one or a
  // relocated userData — but when it does, "EINVAL" from `start` is the
  // least helpful message possible, so it is refused here with the limit
  // named. Counted in UTF-8 bytes plus the terminating NUL, as the kernel
  // does.
  const socketBytes = Buffer.byteLength(socketPath, 'utf8') + 1;
  if (socketBytes > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `Engine socket path is ${socketBytes} bytes; macOS allows ${MAX_UNIX_SOCKET_PATH}. ` +
        `Path: ${socketPath}. Move Waypoint's data directory somewhere shorter.`,
    );
  }

  return {
    installDir,
    launcherPath: path.join(installDir, pin.launcherRelPath),
    runDir,
    socketPath,
    stateDir: path.join(engineRoot, 'state'),
    logPath: path.join(engineRoot, 'engine.log'),
    // Beside the engine, not inside it: an agent runs in a worktree, and a
    // worktree two directories from the launcher main spawns is two
    // directories too close (review round 2). userData/worktrees/<run id>.
    worktreesDir: path.join(userData, 'worktrees'),
  };
}
