import * as fs from 'fs';
import type { EngineSupervisor } from '../../supervisor';
import type { Unsubscribe } from '../../types';
import { createDaemonRunsApi, type DaemonMcpServer } from '../daemonApi';
import { readStoredTypesafeApiKey } from './auth';
import {
  findUv,
  isProvisioned,
  provisionPythonEnv,
  resolveUltrafastPaths,
  runCommand,
  type UltrafastPaths,
} from './pythonEnv';
import { resolveUltrafastScriptPaths } from './scriptPaths';

/**
 * Registers `waypoint-ultrafast` — the browser_task MCP server (Ultrafast
 * browser tasks) — the same way sessionBrowser.ts registers
 * `waypoint-browser`: once per daemon connection, through the daemon's own
 * `agentConfig.saveMcpServer`, so every session that provider starts
 * afterwards lists the tool. Unlike that server, this one is gated: it is
 * ONLY registered once three things are all true —
 *
 *   1. a TypeSafe key is saved (auth.ts) — no key, nothing a session could
 *      call would ever work, so there is no reason to advertise the tool;
 *   2. `uv` is on this machine (pythonEnv.ts's findUv) — the one host
 *      dependency this feature cannot provision for itself;
 *   3. the pinned Python environment is provisioned — attempted lazily,
 *      in the background, on the first connection that has a key and uv;
 *      a session started while that is still running simply does not see
 *      the tool yet, and the next connection tries again.
 *
 * A gate that fails is a log line, never a thrown error: same posture as
 * sessionBrowser.ts's own "a session without a browser still runs; the
 * brief tells the agent to say so".
 */
export const ULTRAFAST_SERVER_NAME = 'waypoint-ultrafast';

export interface UltrafastRegistrationDeps {
  supervisor: EngineSupervisor;
  /** `app.getAppPath()`. */
  appPath: string;
  /** `process.resourcesPath` — where electron-builder's extraResources land, packaged. */
  resourcesPath: string;
  /** `app.getPath('userData')`. */
  userData: string;
  /** `process.execPath` — this app's own binary, run as node. */
  execPath?: string;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

function buildServer(
  execPath: string,
  mcpServerEntry: string,
  env: Record<string, string>,
): DaemonMcpServer {
  return {
    name: ULTRAFAST_SERVER_NAME,
    transport: 'stdio',
    command: execPath,
    args: [mcpServerEntry],
    // ELECTRON_RUN_AS_NODE: same reasoning as sessionBrowser.ts's own
    // server — this app's binary run as a plain node process, never an
    // Electron app instance of its own.
    env: { ELECTRON_RUN_AS_NODE: '1', ...env },
    providers: ['claude'],
  };
}

function buildServerEnv(
  key: string,
  paths: UltrafastPaths,
  scripts: { runnerPath: string },
): Record<string, string> {
  return {
    ULTRAFAST_TYPESAFE_API_KEY: key,
    ULTRAFAST_VENV_PYTHON: paths.venvPython,
    ULTRAFAST_RUNNER_PATH: scripts.runnerPath,
    ULTRAFAST_BH_HOME: paths.bhHome,
    ULTRAFAST_EVIDENCE_ROOT: paths.evidenceRoot,
  };
}

export function registerUltrafastBrowser(
  deps: UltrafastRegistrationDeps,
): Unsubscribe {
  let registeredSince: number | null = null;
  const execPath = deps.execPath ?? process.execPath;
  const scripts = resolveUltrafastScriptPaths(deps.appPath, deps.resourcesPath);
  const paths = resolveUltrafastPaths(deps.userData);

  const register = (since: number) => {
    if (registeredSince === since) return;
    const client = deps.supervisor.client();
    if (!client) return;

    const key = readStoredTypesafeApiKey();
    if (!key) return; // no key: nothing to say, this is the ordinary unconfigured state

    const uvPath = findUv();
    if (!uvPath) {
      deps.logger.warn(
        'engine: ultrafast browser tasks not registered; uv is not available on this machine (https://docs.astral.sh/uv/)',
      );
      return;
    }
    if (!fs.existsSync(scripts.mcpServerEntry)) {
      deps.logger.warn(
        'engine: ultrafast browser tasks not registered; its MCP server script is not installed',
        { entry: scripts.mcpServerEntry },
      );
      return;
    }
    if (!fs.existsSync(scripts.runnerPath)) {
      deps.logger.warn(
        'engine: ultrafast browser tasks not registered; its runner script is not installed',
        { entry: scripts.runnerPath },
      );
      return;
    }

    registeredSince = since;
    const attempt = async () => {
      if (!isProvisioned(paths)) {
        deps.logger.info(
          'engine: provisioning ultrafast browser tasks in the background',
        );
        const result = await provisionPythonEnv({
          paths,
          uvPath,
          run: runCommand,
          logger: deps.logger,
        });
        if (!result.ok) {
          registeredSince = null;
          deps.logger.warn(
            'engine: ultrafast browser tasks not registered; provisioning its Python environment failed',
            { message: result.message },
          );
          return;
        }
      }

      try {
        fs.mkdirSync(paths.evidenceRoot, { recursive: true });
        await createDaemonRunsApi(client).saveMcpServer(
          buildServer(
            execPath,
            scripts.mcpServerEntry,
            buildServerEnv(key, paths, scripts),
          ),
        );
        deps.logger.info('engine: ultrafast browser tasks registered', {
          name: ULTRAFAST_SERVER_NAME,
        });
      } catch (error) {
        registeredSince = null;
        deps.logger.warn(
          'engine: ultrafast browser tasks not registered; sessions run without it until the next connection',
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

/** For the settings page's status line and `ultrafast:test` — whether the
 *  daemon would even attempt registration right now, without actually
 *  doing it. Pure and synchronous; never touches the daemon. */
export function ultrafastAvailability(deps: {
  appPath: string;
  resourcesPath: string;
  userData: string;
}): {
  keyConfigured: boolean;
  uvAvailable: boolean;
  provisioned: boolean;
  scriptsInstalled: boolean;
} {
  const scripts = resolveUltrafastScriptPaths(deps.appPath, deps.resourcesPath);
  const paths = resolveUltrafastPaths(deps.userData);
  return {
    keyConfigured: readStoredTypesafeApiKey() !== null,
    uvAvailable: findUv() !== null,
    provisioned: isProvisioned(paths),
    scriptsInstalled:
      fs.existsSync(scripts.mcpServerEntry) &&
      fs.existsSync(scripts.runnerPath),
  };
}

export { resolveUltrafastPaths };
