/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { app, BrowserWindow, shell, ipcMain, protocol, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import {
  registerCopilotIpc,
  killAllCopilotProcesses,
} from './copilot/copilotRunner';
import { registerCopilotAuthIpc } from './copilot/copilotAuth';
import {
  registerCopilotConnectIpc,
  killAllCopilotConnectProcesses,
} from './copilot/copilotConnect';
import { registerCopilotDetectIpc } from './copilot/copilotDetect';
import { registerJiraIpc } from './jira/jiraIpc';
import { registerRepoLinkIpc } from './repoLink';

// Opt-in remote debugging for scripted/agent-driven QA (docs/qa-electron.md)
// — off unless ELECTRON_QA_DEBUG_PORT is set, so normal dev/prod runs are
// unaffected. Passing --remote-debugging-port as an extra CLI arg does NOT
// work here: electronmon forwards it into this process's own process.argv
// rather than Chromium's native switch parser ever seeing it (confirmed
// live — the port never actually opens, with no error). appendSwitch()
// before app.whenReady() is the documented, correct way to enable it
// (electronjs.org/docs/latest/api/command-line-switches).
const qaDebugPort = process.env.ELECTRON_QA_DEBUG_PORT;
if (qaDebugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', qaDebugPort);
}

// The packaged app loads the renderer from disk with no server behind it —
// a bare `file://` load can't support createBrowserRouter (a hard
// refresh/deep-link at e.g. /projects/proj-launch/tickets has no file at
// that path to find). This registers a custom `app://` scheme that serves
// the built renderer directory and falls back to index.html for any path
// that isn't a real file on disk, mirroring what webpack-dev-server's
// historyApiFallback already does for free in dev. Must run before
// `app.whenReady()` — Electron only allows registering scheme privileges
// once, at module load time.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function registerAppProtocol() {
  const rendererDist = path.join(__dirname, '../renderer');
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    let filePath = path.normalize(
      path.join(rendererDist, decodeURIComponent(pathname)),
    );
    // Path-traversal guard, and the actual SPA-fallback: any request that
    // doesn't resolve to a real file under rendererDist — including every
    // client-side route like /projects/proj-launch/tickets — serves
    // index.html instead, exactly like a server's `try_files` rewrite would.
    if (
      !filePath.startsWith(rendererDist) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      filePath = path.join(rendererDist, 'index.html');
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

// A getter, not the window itself: registerCopilotIpc runs once at module
// load (mainWindow is still null then), but a Copilot run started later —
// after a close/reopen, `mainWindow` is reassigned — needs the *current*
// window at send time, not whichever one existed at registration time.
registerCopilotIpc(() => mainWindow);
registerCopilotAuthIpc();
registerCopilotConnectIpc(() => mainWindow);
registerCopilotDetectIpc();
// Every Jira channel is still request/response — none of them pushes to a
// window the way the Copilot stream does. The getter is for the attachment
// channels' native save/open dialogs, which parent to the window to be modal
// on macOS; a getter rather than the window itself for the same reason as the
// two above, that `mainWindow` is null at this point and is a different object
// after a close and reopen.
registerJiraIpc(() => mainWindow);
registerRepoLinkIpc(() => mainWindow);

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

// electron-debug's auto-opened native DevTools inspector holds an
// exclusive CDP connection to the renderer target — a remote debugging
// client (Playwright, a raw CDP script, an MCP driver) attaching to that
// same target fails immediately with "Debugging connection was closed:
// WebSocket disconnected" (confirmed live). Skip the auto-open whenever
// QA debugging is what this run is actually for.
if (isDebug && !qaDebugPort) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // On macOS, closing the window doesn't quit the app (see
    // window-all-closed below), so before-quit's cleanup alone would leave
    // a still-running `claude setup-token` PTY orphaned — with its output
    // now going nowhere anyway, since the window it would have streamed to
    // is gone. The regular chat-run process is deliberately NOT killed
    // here: unlike this one-shot connect flow, it's meant to keep running
    // and persist its result even if the window closes mid-reply.
    killAllCopilotConnectProcesses();
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser — but only if it's actually a browser
  // that should be opening them. edata.url is whatever the renderer's DOM
  // asked to open (window.open, target="_blank" on an <a>, etc.), and
  // nothing upstream of this handler validates it: a ticket comment or
  // link field (see waypoint-backend's addCommentSchema/addTicketLinkSchema)
  // could in principle carry a javascript: URL or a file: URL pointing at
  // an arbitrary local path, and shell.openExternal would hand either
  // straight to the OS with no guardrail — script execution in one case,
  // opening an arbitrary local file in the other. Mirrors the scheme-check
  // pattern already used by copilotConnect.ts's own openExternal IPC
  // handler (https: + a fixed host allowlist there, since that one only
  // ever needs to open one specific OAuth URL); here the host can't be
  // fixed the same way — legitimate links point at arbitrary external
  // sites — so only the scheme is restricted.
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    let parsed: URL;
    try {
      parsed = new URL(edata.url);
    } catch {
      return { action: 'deny' };
    }
    if (parsed.protocol !== 'https:') {
      return { action: 'deny' };
    }
    shell.openExternal(edata.url).catch((err) => {
      log.error('Failed to open external URL', err);
    });
    return { action: 'deny' };
  });

  // Deny in-window navigation to anything the renderer didn't already ship
  // with — without this, a malicious link (e.g. from the same unsanitized-
  // comment vector) could navigate the actual app window itself (not just
  // a new window/tab, which setWindowOpenHandler above already covers) to
  // an arbitrary destination, including a local file:// URL. The packaged
  // app only ever navigates within its own app:// origin (see
  // registerAppProtocol above) or, in dev, the local webpack-dev-server
  // origin — anything else is a navigation this window has no legitimate
  // reason to make.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!mainWindow) return;
    // Fail closed: an unparseable URL or a same-origin check that can't be
    // evaluated is treated as "not obviously safe" rather than let through.
    try {
      const target = new URL(url);
      const current = new URL(mainWindow.webContents.getURL());
      if (target.origin !== current.origin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Kill any in-flight `claude` subprocess rather than leaving it orphaned —
// this also covers electronmon's dev-time main-process restarts, which
// otherwise had no hook to clean up a run that was still streaming.
app.on('before-quit', () => {
  killAllCopilotProcesses();
  killAllCopilotConnectProcesses();
});

app
  .whenReady()
  .then(() => {
    // Matches resolveHtmlPath's own dev/production branch in util.ts — the
    // app:// scheme only needs to exist wherever loadURL actually points
    // at it.
    if (process.env.NODE_ENV !== 'development') registerAppProtocol();
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
