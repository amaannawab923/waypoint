import type { EngineSupervisor } from '../supervisor';
import type { Unsubscribe } from '../types';
import { createDaemonRunsApi, type DaemonMcpServer } from './daemonApi';

/**
 * A browser for sessions — the ISOLATED one, never the person's own.
 *
 * A session's fix exists only in its worktree, so the one place it can be
 * checked is the app the session starts itself; that needs a browser at
 * localhost, not anyone's signed-in identity. An isolated, headless
 * instance per session also scales the way sessions do (five Fix runs,
 * five throwaway browsers, nothing on the person's screen) — the reason
 * Copilot's "use my Chrome" (copilot/copilotBrowser.ts) is a different
 * feature with a different tool, and why a session wanting the person's
 * Chrome is treated as a sign its verification targets the wrong
 * environment.
 *
 * How it reaches a session: the pinned daemon lists a provider's MCP
 * servers from that provider's own config (`~/.claude.json` for claude —
 * `acp.start` takes no per-session list), so this registers one server
 * there through the daemon's own `agentConfig.saveMcpServer`, the way
 * emdash's MCP settings page does, once per connection. Accepted cost,
 * the gap engine/types.ts records under EnginePaths: the daemon reads the
 * person's real home, so their other Claude Code sessions list this
 * server too while it is registered — an isolated headless browser tool,
 * nothing that reaches their accounts.
 *
 * Packaging note (POC): `npx` resolves the server from the person's PATH,
 * which a GUI-launched packaged app may not have. The pinned engine ships
 * its own node; a shipped copy of the server run by that node is the
 * production shape — not attempted here.
 */
export const SESSION_BROWSER_SERVER_NAME = 'waypoint-browser';

/** Pinned: the exact tool surface the brief's verification text names. */
export const SESSION_BROWSER_PACKAGE = 'chrome-devtools-mcp@1.9.0';

/** Where a session saves screenshots, relative to its worktree; git-excluded by worktrees.ts. */
export const EVIDENCE_DIR = '.waypoint/evidence';

export function sessionBrowserServer(): DaemonMcpServer {
  return {
    name: SESSION_BROWSER_SERVER_NAME,
    transport: 'stdio',
    command: 'npx',
    // `--isolated`: a throwaway profile the server creates and discards, so
    // no session sees another's state or anyone's login. `--headless`: N
    // sessions must not raise N windows; the screenshots are the evidence.
    args: ['-y', SESSION_BROWSER_PACKAGE, '--isolated', '--headless'],
    providers: ['claude'],
  };
}

export interface SessionBrowserDeps {
  supervisor: EngineSupervisor;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Registers the server once per daemon connection (`running.since` is the
 * connection's identity, as bootReconcile.ts uses it). A failure is a
 * warning and a retry on the next connection — a session without a
 * browser still runs; the brief tells the agent to say so rather than
 * claim verification.
 */
export function registerSessionBrowser(deps: SessionBrowserDeps): Unsubscribe {
  let registeredSince: number | null = null;

  const register = (since: number) => {
    if (registeredSince === since) return;
    const client = deps.supervisor.client();
    if (!client) return;
    registeredSince = since;
    const attempt = async () => {
      try {
        await createDaemonRunsApi(client).saveMcpServer(sessionBrowserServer());
        deps.logger.info('engine: session browser registered', {
          name: SESSION_BROWSER_SERVER_NAME,
        });
      } catch (error) {
        registeredSince = null;
        deps.logger.warn(
          'engine: session browser not registered; sessions run without it until the next connection',
          { message: error instanceof Error ? error.message : String(error) },
        );
      }
    };
    attempt().catch(() => {});
  };

  const current = deps.supervisor.getStatus();
  if (current.kind === 'running') register(current.since);
  return deps.supervisor.onStatusChange((status) => {
    if (status.kind === 'running') register(status.since);
  });
}
