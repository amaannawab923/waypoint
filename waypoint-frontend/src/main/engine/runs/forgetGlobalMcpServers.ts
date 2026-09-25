import type { EngineSupervisor } from '../supervisor';
import type { Unsubscribe } from '../types';
import { createDaemonRunsApi, type DaemonMcpServer } from './daemonApi';
import { SESSION_BROWSER_SERVER_NAME } from './sessionBrowser';
import { ULTRAFAST_SERVER_NAME } from './ultrafast/registration';

/** The two names Waypoint used to write into the provider's own config. */
export const FORMERLY_REGISTERED_SERVER_NAMES = [
  SESSION_BROWSER_SERVER_NAME,
  ULTRAFAST_SERVER_NAME,
] as const;

/**
 * The entry scripts Waypoint's own servers are spawned with. A name match
 * alone is not enough to delete someone else's config line — see
 * `wasWrittenByWaypoint`.
 */
const OUR_ENTRY_SCRIPTS = ['chrome-devtools-mcp.js', 'ultrafast-mcp.js'];

/**
 * Whether this config entry is one Waypoint wrote, rather than one that
 * merely shares the name.
 *
 * Deleting by name alone would remove a server the person registered
 * themselves under `waypoint-browser` — silently, on every daemon
 * connection, with no way to make it stick. Every entry Waypoint ever
 * wrote ran one of two known scripts (sessionBrowser.ts's vendored
 * chrome-devtools-mcp, ultrafast/registration.ts's shim), so that is what
 * is matched on.
 */
export function wasWrittenByWaypoint(server: DaemonMcpServer): boolean {
  const args = Array.isArray(server.args) ? server.args : [];
  return args.some((arg) =>
    OUR_ENTRY_SCRIPTS.some((script) => arg.endsWith(script)),
  );
}

export interface ForgetGlobalMcpServersDeps {
  supervisor: EngineSupervisor;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Deletes the entries older builds wrote into the person's `~/.claude.json`.
 *
 * Until 2026-09-24 both of Waypoint's MCP servers were registered there
 * through `agentConfig.saveMcpServer`. They are session-scoped now
 * (sessionMcpServers.ts) and nothing re-adds them — but nothing removes
 * them either, so on a machine that ran an older build every Claude Code
 * session, in any directory, keeps listing and spawning both. Upgrading
 * has to clean up after the version that made the mess.
 *
 * It LISTS before removing, and that ordering is the whole design:
 *
 *  - The daemon's remove resolves ok() for a name that is not there
 *    (`removeFromPath` early-returns), so calling it proves nothing and a
 *    log written from its success would claim a removal on every machine
 *    forever, including ones that never had the entries.
 *  - Listing is a READ. A machine with nothing to clean up does no write
 *    at all, which matters because `~/.claude.json` is a file this app
 *    does not own and the Claude CLI writes constantly; the write lock is
 *    per-process, so every avoided write is an avoided last-writer-wins
 *    race. That is also why no separate "already done" marker is kept:
 *    once the entries are gone this is a read that finds nothing and
 *    stops, which is the state a marker would have recorded anyway.
 *  - It lets the delete be conditional on the entry actually being ours
 *    (`wasWrittenByWaypoint`).
 *
 * Runs once per daemon connection, the cadence the registrations used,
 * because that is when there is a client to ask.
 *
 * This does not stop a server that is already running. A live session
 * keeps whatever it was spawned with until that process exits; those
 * drain on their own.
 */
export function forgetGlobalMcpServers(
  deps: ForgetGlobalMcpServersDeps,
): Unsubscribe {
  let doneSince: number | null = null;

  const forget = (since: number) => {
    if (doneSince === since) return;
    const client = deps.supervisor.client();
    if (!client) return;
    doneSince = since;
    const api = createDaemonRunsApi(client);
    const attempt = async () => {
      let servers: DaemonMcpServer[];
      try {
        servers = await api.listMcpForAgent('claude');
      } catch (error) {
        // Nothing was deleted, so nothing is inconsistent; the next
        // connection tries again.
        doneSince = null;
        deps.logger.warn(
          'engine: could not read the provider config to clean up old MCP entries',
          { message: error instanceof Error ? error.message : String(error) },
        );
        return;
      }

      const stale = servers.filter(
        (server) =>
          (FORMERLY_REGISTERED_SERVER_NAMES as readonly string[]).includes(
            server.name,
          ) && wasWrittenByWaypoint(server),
      );
      if (stale.length === 0) return; // the ordinary case: nothing to say

      const removed: string[] = [];
      for (const server of stale) {
        try {
          await api.removeMcpServer(server.name);
          removed.push(server.name);
        } catch (error) {
          deps.logger.warn(
            'engine: could not remove an MCP entry an older build wrote',
            {
              name: server.name,
              message: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      if (removed.length) {
        deps.logger.info(
          "engine: removed Waypoint's own MCP servers from the provider's global config; sessions get them per session now",
          { removed },
        );
      }
    };
    attempt().catch(() => {});
  };

  const status = deps.supervisor.getStatus();
  if (status.kind === 'running') forget(status.since);
  return deps.supervisor.onStatusChange((next) => {
    if (next.kind === 'running') forget(next.since);
  });
}
