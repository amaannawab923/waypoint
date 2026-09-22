import { resolveUltrafastScriptPaths } from './scriptPaths';

describe('resolveUltrafastScriptPaths', () => {
  it('prefers the packaged extraResources location when it exists', () => {
    const resolved = resolveUltrafastScriptPaths(
      '/Applications/Waypoint.app/Contents/Resources/app.asar',
      '/Applications/Waypoint.app/Contents/Resources',
      (p) =>
        p ===
          '/Applications/Waypoint.app/Contents/Resources/scripts/ultrafast-mcp.js' ||
        p ===
          '/Applications/Waypoint.app/Contents/Resources/scripts/ultrafast/runner.py',
    );
    expect(resolved).toEqual({
      mcpServerEntry:
        '/Applications/Waypoint.app/Contents/Resources/scripts/ultrafast-mcp.js',
      runnerPath:
        '/Applications/Waypoint.app/Contents/Resources/scripts/ultrafast/runner.py',
    });
  });

  it('falls back to the dev project root two levels above app.getAppPath()', () => {
    const resolved = resolveUltrafastScriptPaths(
      '/Users/x/waypoint-electron/waypoint-frontend/release/app',
      '/Users/x/waypoint-electron/waypoint-frontend/release/app/node_modules/electron/dist/Electron.app/Contents/Resources',
      (p) =>
        p ===
          '/Users/x/waypoint-electron/waypoint-frontend/scripts/ultrafast-mcp.js' ||
        p ===
          '/Users/x/waypoint-electron/waypoint-frontend/scripts/ultrafast/runner.py',
    );
    expect(resolved.mcpServerEntry).toBe(
      '/Users/x/waypoint-electron/waypoint-frontend/scripts/ultrafast-mcp.js',
    );
    expect(resolved.runnerPath).toBe(
      '/Users/x/waypoint-electron/waypoint-frontend/scripts/ultrafast/runner.py',
    );
  });

  it('returns the first (packaged) candidate when nothing exists, for the warning to name', () => {
    const resolved = resolveUltrafastScriptPaths(
      '/app',
      '/resources',
      () => false,
    );
    expect(resolved.mcpServerEntry).toBe('/resources/scripts/ultrafast-mcp.js');
  });
});
