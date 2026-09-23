import type { SessionMcpServer } from './daemonApi';
import { sessionBrowserSessionServer } from './sessionBrowser';
import { ultrafastSessionServer } from './ultrafast/registration';

/**
 * The MCP servers a session THIS app dispatches gets, passed on
 * `acp.start` rather than written to the person's `~/.claude.json`.
 *
 * Why it moved. Both servers used to be registered through the daemon's
 * `agentConfig.saveMcpServer`, which persists into the provider's own
 * global config — the only place a session could read servers from
 * before emdash's `acp.start` took a per-session list. That made them
 * machine-wide: every Claude Code session the person opened, in any
 * directory, for any unrelated task, listed both servers and spawned
 * both processes at startup. Measured on a real machine, 2026-09-23: 13
 * live sessions, 5 stray `ultrafast-mcp.js` processes and 2 session
 * browsers, none of them started by Waypoint, each one an Electron
 * binary the person saw appear in their Dock. It also meant an
 * unrelated session was spawned knowing the path to their TypeSafe key.
 *
 * Passing them per session makes "who gets this tool" match "who
 * Waypoint dispatched", which is what it always meant.
 *
 * Both entries are null until their own gates pass — the browser until
 * its vendored server is on disk, ultrafast until there is a key, uv, a
 * provisioned venv and its scripts. A session simply starts without the
 * tool, exactly as it did when registration failed; the brief already
 * tells the agent to say so rather than claim a verification it could
 * not run.
 */
export function waypointSessionMcpServers(): SessionMcpServer[] {
  const servers = [sessionBrowserSessionServer(), ultrafastSessionServer()];
  return servers.filter(
    (server): server is SessionMcpServer => server !== null,
  );
}

/**
 * `{ mcpServers }` when there are any, `{}` when there are none — so a
 * session with none sends exactly the request it always did, rather than
 * an empty array.
 */
export function waypointSessionMcpServersPatch(): {
  mcpServers?: SessionMcpServer[];
} {
  const mcpServers = waypointSessionMcpServers();
  return mcpServers.length ? { mcpServers } : {};
}
