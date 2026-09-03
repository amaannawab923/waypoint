import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { isUsableRepoDirectory } from './repoPathStatus';

const execFileAsync = promisify(execFile);

export interface ChooseFolderOptions {
  defaultPath?: string;
  title?: string;
  // macOS-only (showOpenDialog ignores it elsewhere) — passed through
  // unconditionally, a harmless no-op on other platforms.
  message?: string;
}

export type ChooseFolderResult =
  | { canceled: true }
  | { canceled: false; path: string; looksLikeGitRepo: boolean };

export interface RepoDescribeResult {
  name: string;
  // Home-dir-collapsed here rather than in the renderer, which has no
  // os.homedir() to collapse against.
  displayPath: string;
  branch: string | null;
  // ISO 8601 (git's %cI); the renderer formats it relatively.
  lastCommitAt: string | null;
  trackedFileCount: number | null;
}

// Each git call fails independently and degrades to null rather than failing
// the whole describe. A repo with no commits yet (no HEAD) and a detached
// HEAD are both real states a freshly-init'd or tag-cloned checkout can be
// in, and none of them should block showing a recognizable confirmation —
// showing SOMETHING recognizable is the entire point of describing a repo.
//
// - maxBuffer: Node's 1MB default overflows on `ls-files` in a large
//   monorepo, which would silently drop the tracked-file chip on exactly the
//   repos where it's most informative. 16MB comfortably covers a file list
//   even in the thousands.
// - core.fsmonitor=false / GIT_CONFIG_NOSYSTEM: repoPath is always a
//   user-chosen folder (never untrusted input over the wire), so this is
//   defense in depth rather than a response to a live risk — but git reading
//   a checkout's own config can still run an fsmonitor hook or a system-wide
//   config the user never chose, and both are free to close off.
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        timeout: 2000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function collapseHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Local repo introspection behind invoke/handle channels: the native folder
 * picker, a "does this path still resolve" check, and a read-only git
 * description of a checkout. Lives here rather than under copilot/ because
 * nothing about it is Copilot-specific — any later feature needing a local
 * folder reuses these same channels.
 *
 * The backend (projects.service.ts's validateRepoPath) remains the single
 * source of truth for "is this actually a usable git checkout". The
 * `looksLikeGitRepo` hint below is speed, not a second implementation of
 * that rule: the renderer sends the PATCH either way and the backend's
 * answer is the only one that decides anything.
 */
export function registerRepoLinkIpc(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(
    'repo:choose-folder',
    async (
      _event,
      opts: ChooseFolderOptions = {},
    ): Promise<ChooseFolderResult> => {
      const win = getWindow();
      const dialogOpts = {
        properties: ['openDirectory' as const],
        defaultPath: opts.defaultPath,
        title: opts.title,
        message: opts.message,
      };
      // Two real overloads, not a cast: parenting the sheet to the window is
      // what makes it modal on macOS, and there genuinely may be no window
      // (the picker is then a free-floating dialog rather than an error).
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const };
      }
      const picked = result.filePaths[0];
      return {
        canceled: false as const,
        path: picked,
        // existsSync, not a directory check: a worktree's .git is a pointer
        // FILE, and the backend's own rule accepts both shapes.
        looksLikeGitRepo:
          isUsableRepoDirectory(picked) &&
          fs.existsSync(path.join(picked, '.git')),
      };
    },
  );

  // A single fs.stat, nothing more — the renderer calls this on project load
  // and on window focus, never on a timer. Read-only and side-effect-free,
  // so it is safe to call as often as the UI wants.
  ipcMain.handle(
    'repo:check-path',
    async (_event, repoPath: string): Promise<{ exists: boolean }> => {
      return { exists: isUsableRepoDirectory(repoPath) };
    },
  );

  // Its own channel rather than extra fields on choose-folder's response:
  // describing a path has to be callable independently of picking one. The
  // settings page re-describes an already-linked path on mount, and a
  // one-click suggestion never opens the dialog at all.
  //
  // execFile, never spawn with shell: true — repoPath is passed as the `cwd`
  // option and is never concatenated into a command string, so there is no
  // shell interpolation of it anywhere.
  ipcMain.handle(
    'repo:describe',
    async (_event, repoPath: string): Promise<RepoDescribeResult> => {
      const [branch, lastCommitAt, trackedFiles] = await Promise.all([
        tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
        tryGit(repoPath, ['log', '-1', '--format=%cI']),
        tryGit(repoPath, ['ls-files']),
      ]);
      return {
        name: path.basename(repoPath),
        displayPath: collapseHome(repoPath),
        branch,
        lastCommitAt,
        trackedFileCount: trackedFiles
          ? trackedFiles.split('\n').filter(Boolean).length
          : null,
      };
    },
  );
}
