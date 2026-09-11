import { app, ipcMain, type BrowserWindow } from 'electron';
import { ENGINE_IPC, type EngineHealth, type EngineStatus } from './types';
import { resolveEnginePaths } from './paths';
import { createEngineSupervisor, type EngineSupervisor } from './supervisor';
import { connectSocketTransport } from './transport';
import { createWireClient } from './wire';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installEngine, verifyInstalledEngine } from './installer';
import { runDaemonCommand } from './daemonCli';

// ROAD-48: the IPC surface over the engine supervisor.
//
// Every channel below is request/response (`ipcMain.handle`), matching
// jiraIpc.ts's own header note on why: none of these produce a stream, only
// a single settled answer per call. `statusChanged` is the one push
// channel, for the same reason the Copilot connect flow's own `send` helper
// (copilotConnect.ts) exists — a status transition can happen with no
// renderer call in flight to answer (the daemon dying on its own, say), so
// it has to be pushed rather than polled.
//
// Channel names are read from ENGINE_IPC (types.ts), never retyped here —
// the same rule jiraIpc.ts's own header states for its channels.
//
// This is also the one file in this task's scope that imports `./wire`,
// `./transport`, `./installer` and `./daemonCli` as VALUES — see
// `createDefaultEngineSupervisor` below. supervisor.ts itself stays fully
// dependency-injected and never imports any of them, so it can be
// unit-tested with fakes; this file is where the real implementations get
// wired together for the running app.

const logger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console.info(`[engine] ${message}`, meta ?? '');
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console.warn(`[engine] ${message}`, meta ?? '');
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console.error(`[engine] ${message}`, meta ?? '');
  },
};

/**
 * Builds the real, running-app supervisor: real paths under this install's
 * `userData`, the real socket transport and Wire client, the real installer
 * verification, and the real daemon CLI. Exported (rather than inlined into
 * `registerEngineIpc`'s default parameter) so a caller who genuinely wants
 * the production wiring without also registering IPC handlers — there is
 * none today, but the alternative of inlining it would make it untestable
 * even in principle — can still reach it directly.
 */
/**
 * Where the archive Waypoint ships actually is. `extraResources` copies
 * `engine/` beside `assets/` into the packaged app's Resources; in
 * development it is the repo's own `engine/` directory, populated by
 * `npm run engine:fetch` (which postinstall runs). Same split main.ts
 * already makes for `assets/` — see its RESOURCES_PATH.
 */
function bundledArchiveDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'engine')
    : path.join(app.getAppPath(), 'engine');
}

export function createDefaultEngineSupervisor(): EngineSupervisor {
  const paths = resolveEnginePaths(app.getPath('userData'));
  const installerDeps = { bundledArchiveDir: bundledArchiveDir() };
  return createEngineSupervisor({
    paths,
    runDaemonCommand,
    connectSocketTransport,
    createWireClient,
    verifyInstalledEngine,
    installEngine: () => installEngine(paths, installerDeps),
    removeStaleStartLock: async (lockPath) => {
      await fs.promises.rm(lockPath, { force: true });
    },
    appVersion: app.getVersion(),
    clock: Date.now,
    logger,
  });
}

/**
 * Registers every `engine:*` channel against `supervisor`.
 *
 * `supervisor` defaults to `createDefaultEngineSupervisor()` so main.ts's
 * own registration stays the single line
 * `registerEngineIpc(() => mainWindow)`, mirroring `registerRepoLinkIpc(()
 * => mainWindow)` exactly — this task owns exactly that one call and its
 * one import in main.ts, so the real wiring has to live here instead.
 * Every test in `engineIpc.test.ts` passes an explicit fake supervisor,
 * which is what makes this file testable without a real socket or process:
 * a default parameter is only ever evaluated when the argument is omitted,
 * so `createDefaultEngineSupervisor()` (and the `app.getPath` call inside
 * it) never runs in a test that supplies its own.
 */
export function registerEngineIpc(
  getWindow: () => BrowserWindow | null,
  supervisor: EngineSupervisor = createDefaultEngineSupervisor(),
): void {
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  supervisor.onStatusChange((status) => send(ENGINE_IPC.statusChanged, status));

  // → EngineStatus, never throws — a broken engine is a status, not an IPC
  // error (ENGINE_IPC.status's own comment in types.ts). getStatus() is
  // synchronous and answers from the supervisor's last real observation,
  // so this channel never itself touches the filesystem or the daemon.
  ipcMain.handle(ENGINE_IPC.status, (): EngineStatus => supervisor.getStatus());

  ipcMain.handle(ENGINE_IPC.install, (): Promise<EngineStatus> =>
    supervisor.install(),
  );
  ipcMain.handle(ENGINE_IPC.start, (): Promise<EngineStatus> =>
    supervisor.start(),
  );
  ipcMain.handle(ENGINE_IPC.stop, (): Promise<EngineStatus> =>
    supervisor.stop(),
  );
  ipcMain.handle(ENGINE_IPC.health, (): Promise<EngineHealth | null> =>
    supervisor.health(),
  );
}
