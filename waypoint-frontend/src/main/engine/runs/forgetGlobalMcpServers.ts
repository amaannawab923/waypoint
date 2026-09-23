import type { Unsubscribe } from '../types';
import type { EngineSupervisor } from '../supervisor';
import { createDaemonRunsApi } from './daemonApi';
import { SESSION_BROWSER_SERVER_NAME } from './sessionBrowser';
import { ULTRAFAST_SERVER_NAME } from './ultrafast/registration';

/** The two names Waypoint used to write into the provider's own config. */
export const FORMERLY_REGISTERED_SERVER_NAMES = [
  SESSION_BROWSER_SERVER_NAME,
  ULTRAFAST_SERVER_NAME,
] as const;

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
 * session, in any directory, keeps listing and spawning both for as long
 * as those lines sit in that file. Upgrading has to clean up after the
 * version that made the mess; the person should not have to run
 * `claude mcp remove` by hand to finish a fix they already installed.
 *
 * Runs once per daemon connection, the same cadence the registrations
 * used, because that is when a client exists to ask. It is an upsert's
 * inverse and is harmless to repeat: a name that is not there is already
 * in the state this wants.
 *
 * Deleting an entry does NOT stop a server that is already running — a
 * live session keeps whatever it was spawned with until that process
 * exits (registration.ts's own F28 finding). Those drain on their own;
 * this only stops new sessions picking them up.
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
      const removed: string[] = [];
      for (const name of FORMERLY_REGISTERED_SERVER_NAMES) {
        try {
          await api.removeMcpServer(name);
          removed.push(name);
        } catch (error) {
          // A name that was never registered is the ordinary case on a
          // fresh install, and the daemon may answer either way for it;
          // either is the state we want, so this is not worth a warning
          // per connection.
          deps.logger.info(
            'engine: nothing to forget for a formerly registered MCP server',
            {
              name,
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
