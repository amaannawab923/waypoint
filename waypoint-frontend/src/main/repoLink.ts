import { dialog, ipcMain, type BrowserWindow } from 'electron';

/**
 * Native folder picker behind one invoke/handle channel (Copilot V3's
 * "link a repo" flow — project settings → Codebase, and the in-chat card).
 * Lives here rather than under copilot/ because nothing about it is
 * Copilot-specific: it hands back whatever directory the user picked, and
 * any later feature that needs a local folder reuses this same channel.
 *
 * Deliberately does NO filesystem validation. The backend
 * (projects.service.ts's validateRepoPath) is the single source of truth
 * for "is this actually a usable git checkout", so there's one
 * implementation of that rule instead of two that can drift. The cost is
 * one network round-trip before the user sees "that isn't a git repo"
 * rather than instant local feedback — acceptable for a flow that runs
 * roughly once per project.
 */
export function registerRepoLinkIpc(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle('repo:choose-folder', async () => {
    const win = getWindow();
    // Two real overloads, not a cast: parenting the sheet to the window is
    // what makes it modal on macOS, and there genuinely may be no window
    // (the picker is then a free-floating dialog rather than an error).
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true as const };
    }
    return { canceled: false as const, path: result.filePaths[0] };
  });
}
