import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the two plain scripts this feature spawns actually live on disk —
 * `scripts/ultrafast-mcp.js` (the MCP server) and `scripts/ultrafast/runner.py`
 * (the jev-ultrafast driver it spawns per task). Neither is bundled by
 * webpack (both are plain, hand-written CommonJS/Python, spawned as
 * separate processes, exactly the reasoning sessionBrowser.ts gives for
 * vendoring chrome-devtools-mcp rather than importing it) — so, like that
 * server, they are shipped through electron-builder's `extraResources`
 * (package.json `build.extraResources`) rather than through app.asar, and
 * resolved at `process.resourcesPath` once packaged.
 *
 * Two candidates per file, dev then packaged, and the first that exists on
 * disk wins — the same defensive pattern sessionBrowser.ts's
 * `sessionBrowserEntry` uses, because this app's dev-mode `app.getAppPath()`
 * (`release/app`, an electron-react-boilerplate layout) and its packaged
 * one (`…/Resources/app.asar`) disagree about where the frontend project
 * root actually is, and asserting one over the other has already broken
 * live once for a sibling feature (sessionBrowser.ts's own comment on the
 * `npx` PATH resolution bug). Checked at call time, not cached: a call
 * before packaging finished would otherwise warn forever.
 */
export interface UltrafastScriptPaths {
  mcpServerEntry: string;
  runnerPath: string;
}

function candidates(
  appPath: string,
  resourcesPath: string,
  rel: string[],
): string[] {
  return [
    // Packaged: electron-builder's extraResources land beside app.asar,
    // under `Contents/Resources/<rel>`.
    path.join(resourcesPath, ...rel),
    // Dev: the frontend project root, two levels up from `app.getAppPath()`
    // (`release/app`) in this repo's electron-react-boilerplate layout —
    // and, defensively, `appPath` itself, in case a future build changes
    // what dev's app path names.
    path.join(appPath, '..', '..', ...rel),
    path.join(appPath, ...rel),
  ];
}

function firstExisting(
  paths: string[],
  existsSync: (p: string) => boolean,
): string {
  return paths.find((p) => existsSync(p)) ?? paths[0];
}

export function resolveUltrafastScriptPaths(
  appPath: string,
  resourcesPath: string,
  existsSync: (p: string) => boolean = fs.existsSync,
): UltrafastScriptPaths {
  return {
    mcpServerEntry: firstExisting(
      candidates(appPath, resourcesPath, ['scripts', 'ultrafast-mcp.js']),
      existsSync,
    ),
    runnerPath: firstExisting(
      candidates(appPath, resourcesPath, ['scripts', 'ultrafast', 'runner.py']),
      existsSync,
    ),
  };
}
