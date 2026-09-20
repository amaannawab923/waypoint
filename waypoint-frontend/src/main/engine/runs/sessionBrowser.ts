import * as fs from 'node:fs';
import * as path from 'node:path';
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
 * How it runs: the server is a dependency of this app (package.json pins
 * chrome-devtools-mcp exactly) and is started by THIS app's own binary as
 * node — `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — never by an
 * `npx` from the person's PATH. Found on the first live run: the daemon's
 * PATH resolved `npx` to a Node 18 the server refuses, and the session
 * silently fell back to whatever other browser MCP the person happened to
 * have. Electron's node is 22, present wherever Waypoint is, and the same
 * in dev and packaged (packaging still has to unpack the module from the
 * asar — a build-config step, not a runtime one).
 */
export const SESSION_BROWSER_SERVER_NAME = 'waypoint-browser';

/**
 * The server's stdio entry. It is a `release/app` dependency (beside the
 * Agent SDK — runtime-only, never bundled: as a root dependency the
 * renderer DLL build tried to webpack it and CI failed), so it lives at
 * `<app>/release/app/node_modules/…` in development and at
 * `<app>/node_modules/…` once packaged (release/app becomes the app
 * root). Built from a path, not `require.resolve`: webpack rewrites that
 * to a cwd-relative `./node_modules/…` inside the main bundle (seen
 * live), and the daemon spawns from its own cwd. `appPath` is
 * `app.getAppPath()`.
 */
export function sessionBrowserEntryCandidates(appPath: string): string[] {
  const rel = [
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js',
  ];
  // Packaged: app.getAppPath() is `…/Resources/app.asar`, and the server
  // is asarUnpacked (package.json) — a SEPARATE node process cannot read
  // inside an archive, so the real files live beside it under
  // `app.asar.unpacked`. That path first; the archive path is never a
  // valid spawn target.
  const unpacked = /\.asar$/.test(appPath)
    ? [path.join(`${appPath}.unpacked`, 'node_modules', ...rel)]
    : [];
  return [
    ...unpacked,
    path.join(appPath, 'node_modules', ...rel),
    path.join(appPath, 'release', 'app', 'node_modules', ...rel),
  ];
}

/** The first candidate that exists, else the first (for the warning). */
export function sessionBrowserEntry(appPath: string): string {
  const candidates = sessionBrowserEntryCandidates(appPath);
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

export function sessionBrowserServer(
  execPath: string,
  entry: string,
): DaemonMcpServer {
  return {
    name: SESSION_BROWSER_SERVER_NAME,
    transport: 'stdio',
    command: execPath,
    // `--isolated`: a throwaway profile the server creates and discards, so
    // no session sees another's state or anyone's login. `--headless`: N
    // sessions must not raise N windows; the screenshots are the evidence.
    args: [entry, '--isolated', '--headless'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    providers: ['claude'],
  };
}

export interface SessionBrowserDeps {
  supervisor: EngineSupervisor;
  /** `app.getAppPath()`; where the vendored server lives. */
  appPath: string;
  /** `process.execPath` — this app's binary, run as node. */
  execPath?: string;
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
  const entry = sessionBrowserEntry(deps.appPath);
  const server = sessionBrowserServer(deps.execPath ?? process.execPath, entry);

  const register = (since: number) => {
    if (registeredSince === since) return;
    const client = deps.supervisor.client();
    if (!client) return;
    registeredSince = since;
    const attempt = async () => {
      // A registration naming a file that is not there would leave every
      // session with a server that fails to start — worse than none, since
      // the brief tells the agent to expect it. Checked per connection,
      // not once at build time.
      if (!fs.existsSync(entry)) {
        deps.logger.warn(
          'engine: session browser not registered; its server is not installed',
          { entry },
        );
        return;
      }
      try {
        await createDaemonRunsApi(client).saveMcpServer(server);
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
