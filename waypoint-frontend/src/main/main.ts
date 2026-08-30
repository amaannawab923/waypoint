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

// The packaged app loads the renderer from disk with no server behind it —
// a bare `file://` load can't support createBrowserRouter (a hard
// refresh/deep-link at e.g. /projects/proj-launch/work-items has no file at
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
    // client-side route like /projects/proj-launch/work-items — serves
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

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
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
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
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
