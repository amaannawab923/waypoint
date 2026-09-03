import * as fs from 'fs';

/**
 * The one definition of "usable as a repo cwd", shared by copilotRunner.ts's
 * resolveRepoRoot (the actual send-time decision) and repoLink.ts's
 * repo:check-path channel (the UI's linked/stale decision). Two
 * implementations of this one fact were exactly the bug the stale-link gap
 * describes: the in-chat card's gate and the runner's fallback already
 * disagreed once — repoPath non-null on one side, cwd silently downgraded to
 * os.tmpdir() on the other. One function, two callers, cannot drift again.
 *
 * Deliberately just existence + directory-ness, not a .git re-check. A repo
 * whose .git was renamed or removed since linking is still a fine cwd for
 * Read/Glob/Grep, and re-verifying git-repo-ness on every check is the same
 * "redundant I/O for no real safety gain" call resolveRepoRoot already made.
 *
 * A single statSync rather than existsSync-then-statSync: the two-call form
 * has a real TOCTOU gap (an unmounted drive, a deleted checkout) that one
 * call closes.
 */
export function isUsableRepoDirectory(repoPath: string): boolean {
  try {
    return fs.statSync(repoPath).isDirectory();
  } catch {
    return false;
  }
}
