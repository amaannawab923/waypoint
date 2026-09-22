import * as fs from 'fs';
import * as os from 'os';
import { getStoredSubscriptionToken } from '../../../copilot/copilotAuth';
import { copilotClaudeConfigDir } from '../../../copilot/copilotConfigDir';
import type { EngineSupervisor } from '../../supervisor';
import type { Unsubscribe } from '../../types';
import { createDaemonRunsApi, type DaemonMcpServer } from '../daemonApi';
import {
  removeRuntimeSecretFile,
  resolveTypesafeApiKey,
  writeRuntimeSecretFile,
} from './auth';
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

/**
 * The env the MCP server runs with. Found on the first live Test
 * (2026-09-22): the ULTRAFAST_* values alone were not enough — the server
 * hosts the Claude text-model shim, and the Claude Code CLI the Agent SDK
 * spawns for it reads the person's login from the OS keychain, which needs
 * HOME and USER (a probe with HOME alone still said "Not logged in"). So
 * the host essentials ride along — HOME, USER, LOGNAME, TMPDIR, a PATH —
 * plus, when Copilot has a connected subscription token, the OAuth token
 * (as a file path — see below) and the same CLAUDE_CONFIG_DIR
 * copilotRunner's own buildEnv() sets, so the shim signs in exactly the
 * way Copilot does. Still not the whole process env: nothing else of the
 * host leaks into a process that talks to a third party.
 *
 * F1 (tech-lead review, 2026-09-22, BLOCKER): this env object is handed
 * to `createDaemonRunsApi(client).saveMcpServer` below, which the daemon
 * persists into the person's REAL `~/.claude.json` at 0644 — readable by
 * every session this app spawns for that provider, not just this one.
 * That's fine for a path or a flag; it used to also carry the TypeSafe
 * key AND Copilot's OAuth token as raw values, directly contradicting
 * this feature's own design doc ("Where the key lives": "never … in a
 * config file on disk"). Both now go through a 0600 file under this
 * app's own userData instead (pythonEnv.ts's UltrafastPaths.runtimeKeyFile
 * / runtimeOauthTokenFile) — this env carries only each file's PATH,
 * which is not a secret; ultrafast-mcp.js reads the real value from disk
 * at its own startup. The OAuth token specifically: dropping it and
 * relying on the ambient keychain login the way an unconnected machine
 * does was considered and rejected — this file's own comment above
 * already documents a live test (2026-09-22) where HOME/USER alone were
 * NOT enough and the probe kept saying "Not logged in" until the token
 * was added, which is exactly the scenario a Copilot-token-only login
 * (no local `claude login`) hits. Rather than re-assume that finding, it
 * still carries the OAuth token — just through the same file+path
 * mechanism as the TypeSafe key, never the value itself in this env.
 */
export function buildServerEnv(
  key: string,
  paths: UltrafastPaths,
  scripts: { runnerPath: string },
): Record<string, string> {
  writeRuntimeSecretFile(paths.runtimeKeyFile, key);
  const env: Record<string, string> = {
    ULTRAFAST_KEY_FILE: paths.runtimeKeyFile,
    ULTRAFAST_VENV_PYTHON: paths.venvPython,
    ULTRAFAST_RUNNER_PATH: scripts.runnerPath,
    ULTRAFAST_BH_HOME: paths.bhHome,
    ULTRAFAST_EVIDENCE_ROOT: paths.evidenceRoot,
    HOME: process.env.HOME ?? os.homedir(),
    USER: process.env.USER ?? os.userInfo().username,
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? os.userInfo().username,
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].forEach((name) => {
    const value = process.env[name];
    if (value) env[name] = value;
  });
  const subscriptionToken = getStoredSubscriptionToken();
  if (subscriptionToken) {
    writeRuntimeSecretFile(paths.runtimeOauthTokenFile, subscriptionToken);
    env.ULTRAFAST_OAUTH_TOKEN_FILE = paths.runtimeOauthTokenFile;
    env.CLAUDE_CONFIG_DIR = copilotClaudeConfigDir();
  } else {
    // No token connected right now — remove any stale file a PRIOR
    // connection left behind rather than leaving a disconnected Copilot
    // account's last token sitting on disk indefinitely.
    removeRuntimeSecretFile(paths.runtimeOauthTokenFile);
  }
  return env;
}

// F15 (tech-lead review, 2026-09-22): whether the daemon currently has
// this server registered with a working key — set true only after
// saveMcpServer resolves, false again on any failure or gate that isn't
// met. This is the single source of truth engineIpc.ts's own
// `ultrafastAvailable` reads before offering the browser_task tool in a
// brief; before this fix that decision was made from the four STATIC
// ultrafastAvailability() gates alone, which all stay true through the
// exact window between a key save (ipc.ts's saveKey handler used to only
// write the key and stop — it never registered) and whatever daemon
// reconnect would actually pick it up, during which a dispatched brief
// could promise a tool the session's daemon config does not yet have.
let isRegistered = false;

// The current registration attempt, callable from outside the closure
// registerUltrafastBrowser returns — ipc.ts's saveKey handler uses this
// (via reregisterUltrafastBrowser, below) to force a fresh attempt
// immediately after a key is saved, rather than waiting for the next
// daemon reconnect. Cleared when registerUltrafastBrowser's own
// unsubscribe runs, so a stale reference from an earlier
// registerUltrafastBrowser call (there is only ever one in production;
// tests create several) can't fire against deps that are no longer live.
let activeAttemptNow: (() => void) | null = null;

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

    const key = resolveTypesafeApiKey()?.key ?? null;
    if (!key) {
      isRegistered = false; // no key: nothing to say, this is the ordinary unconfigured state
      return;
    }

    const uvPath = findUv();
    if (!uvPath) {
      isRegistered = false;
      deps.logger.warn(
        'engine: ultrafast browser tasks not registered; uv is not available on this machine (https://docs.astral.sh/uv/)',
      );
      return;
    }
    if (!fs.existsSync(scripts.mcpServerEntry)) {
      isRegistered = false;
      deps.logger.warn(
        'engine: ultrafast browser tasks not registered; its MCP server script is not installed',
        { entry: scripts.mcpServerEntry },
      );
      return;
    }
    if (!fs.existsSync(scripts.runnerPath)) {
      isRegistered = false;
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
          isRegistered = false;
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
        isRegistered = true;
        deps.logger.info('engine: ultrafast browser tasks registered', {
          name: ULTRAFAST_SERVER_NAME,
        });
      } catch (error) {
        registeredSince = null;
        isRegistered = false;
        deps.logger.warn(
          'engine: ultrafast browser tasks not registered; sessions run without it until the next connection',
          { message: error instanceof Error ? error.message : String(error) },
        );
      }
    };
    attempt().catch(() => {});
  };

  const attemptNow = () => {
    const status = deps.supervisor.getStatus();
    if (status.kind === 'running') register(status.since);
  };
  activeAttemptNow = attemptNow;

  const current = deps.supervisor.getStatus();
  if (current.kind === 'running') register(current.since);
  const unsubscribe = deps.supervisor.onStatusChange((status) => {
    if (status.kind === 'running') register(status.since);
  });
  return () => {
    unsubscribe();
    if (activeAttemptNow === attemptNow) activeAttemptNow = null;
  };
}

/**
 * F15: forces a fresh registration attempt against whatever daemon
 * connection is live right now, bypassing the wait for the next
 * connection event — ipc.ts's saveKey handler calls this immediately
 * after a key is saved, so a Fix dispatched on the same connection sees
 * browser_task in its very first brief rather than the connection that
 * happened to be live when the key didn't exist yet. A no-op when the
 * daemon isn't connected (there is nothing to register against) or
 * before any `registerUltrafastBrowser` call has run (every real host —
 * only a test could reach this before boot finishes).
 */
export function reregisterUltrafastBrowser(): void {
  activeAttemptNow?.();
}

/**
 * F15: ipc.ts's clearKey handler calls this so a cleared key is
 * reflected in `isUltrafastRegistered()` immediately — there is no
 * daemon API to "unregister" an MCP server (`saveMcpServer` only ever
 * upserts; see daemonApi.ts's own DaemonMcpServer comment), so this only
 * flips the local flag. The server entry in the person's `~/.claude.json`
 * stays until the next successful registration overwrites it, but the
 * server itself will report "no key configured" the moment
 * configurationProblem() runs (its own runtime-key file was removed by
 * deleteStoredTypesafeApiKey at the same time) — the same degraded-but-
 * honest posture every other gate here holds to.
 */
export function unregisterUltrafastBrowser(): void {
  isRegistered = false;
}

/** F15: the single source of truth for whether a session's daemon config
 *  actually has `browser_task` right now — read by engineIpc.ts's own
 *  `ultrafastAvailable` before a brief offers the tool. */
export function isUltrafastRegistered(): boolean {
  return isRegistered;
}

/** Test-only: resets the module-level registration state between test
 *  runs, so one test file's daemon connection can't leave
 *  isUltrafastRegistered() true for another's. */
export function resetUltrafastRegistrationStateForTests(): void {
  isRegistered = false;
  activeAttemptNow = null;
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
    keyConfigured: resolveTypesafeApiKey() !== null,
    uvAvailable: findUv() !== null,
    provisioned: isProvisioned(paths),
    scriptsInstalled:
      fs.existsSync(scripts.mcpServerEntry) &&
      fs.existsSync(scripts.runnerPath),
  };
}

export { resolveUltrafastPaths };
