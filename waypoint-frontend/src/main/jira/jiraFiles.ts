import { app, dialog, shell, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as client from './jiraClient';
import type { JiraFailure, JiraResult } from './jiraTypes';

// Where the Jira feature meets the local machine: native file dialogs, the
// filesystem, and the OS file manager. Deliberately its own file, and
// deliberately the ONLY file under main/jira/ that imports `electron`'s
// `dialog`/`shell`/`app` or touches `fs`.
//
// That boundary is load-bearing, not tidiness. jiraClient.ts is testable by
// assigning a mock to `global.fetch` and nothing else — no Electron, no
// filesystem, no module registry surgery — and every test in
// jiraClient.test.ts is written that way. An `import { dialog } from
// 'electron'` anywhere in that file would drag the whole Electron module into
// its test environment and force every one of those tests to mock it. So the
// dialogs live here instead, where they are the subject rather than an
// accident.
//
// The other rule this file holds is the one the whole design rests on:
//
//   No filesystem path ever crosses IPC, in either direction.
//
// The renderer cannot name a file to upload and cannot name a place to save a
// download. It asks for "let the user pick something to attach" or "let the
// user save this attachment", and the entire picker → disk → network round
// trip happens inside one function here. There is consequently nothing to
// validate at the boundary: the native dialog *is* the authorization, and a
// path only ever exists between the dialog that produced it and the `fs` call
// that consumes it, both within a single call stack in the privileged process.

/** What a file gets called when nothing usable survives sanitizing. */
const FALLBACK_FILE_NAME = 'attachment';

/** Named rather than written inline: a literal NUL in source is invisible in
 * a diff, and putting one inside a regular expression is its own class of
 * mistake (eslint's no-control-regex exists for exactly that). A split/join
 * needs neither. */
const NUL = String.fromCharCode(0);

/**
 * A Jira filename reduced to something safe to hand a save dialog as its
 * default.
 *
 * Jira attachment filenames are attacker-influenced. Any user with permission
 * to attach a file to any issue the connected account can see chooses that
 * string, and it arrives here verbatim — so `../../../.ssh/authorized_keys`
 * is a name someone can genuinely give a file. That string is never used to
 * *write* anything (the user picks the destination in a native dialog, and
 * that dialog's answer is what gets written), but it is used to seed the
 * dialog's default path, and a default nobody reads closely is exactly the
 * kind of thing worth not aiming at someone's home directory.
 *
 * Three passes, in this order, because each cleans up after the one before:
 *
 *  1. NUL bytes go first. A NUL truncates a path in libc, so a name like
 *     `notes.txt\0.sh` can be two different strings depending on who reads it,
 *     and no later rule can undo that ambiguity once it has been split on.
 *  2. Backslashes become forward slashes before `path.basename`. On POSIX,
 *     `basename` does not treat `\` as a separator at all, so a
 *     Windows-shaped `..\..\windows\system32` survives it completely intact;
 *     normalizing first means one rule handles both spellings on either
 *     platform.
 *  3. `path.basename` strips every directory component — the actual work —
 *     and what remains is scrubbed of the characters that are separators or
 *     reserved on some filesystem but not the one this happens to run on.
 *
 * `.` and `..` are then rejected outright: both are real answers from
 * `basename` and neither is a filename.
 *
 * Pure and exported so it can be tested directly against those shapes, which
 * is the only way to know it holds — a dialog default is not something a test
 * can easily read back out.
 */
export function safeBaseName(rawFileName: string): string {
  if (typeof rawFileName !== 'string') return FALLBACK_FILE_NAME;

  const withoutNulls = rawFileName.split(NUL).join('');
  const base = path.basename(withoutNulls.replace(/\\/g, '/').trim());
  const scrubbed = base.replace(/[/\\:*?"<>|]/g, '_').trim();

  // "." and ".." are directory entries, not names — and are what `basename`
  // hands back for a path made of nothing but separators and dots.
  if (!scrubbed || /^\.+$/.test(scrubbed)) return FALLBACK_FILE_NAME;
  return scrubbed;
}

/** A local filesystem problem, in the user's terms rather than errno's. */
function fileFailure(message: string): JiraFailure {
  return { ok: false, reason: 'file_error', message };
}

function reasonOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'unknown error';
}

/**
 * The folder a save dialog should open in.
 *
 * `app.getPath('downloads')` is documented to throw when the OS has no such
 * directory, and a thrown error here would turn "your download is ready" into
 * an unhandled rejection. An undefined default is a perfectly good outcome —
 * the dialog then opens wherever the OS last left it — so the failure mode is
 * "no suggestion", not "no download".
 */
function downloadsDirectory(): string | null {
  try {
    return app.getPath('downloads');
  } catch {
    return null;
  }
}

/**
 * Fetches an attachment's bytes and lets the user choose where to keep them.
 *
 * The order is the design. The bytes are fetched *first* and the dialog is
 * opened second, so a download that Jira is going to refuse (a deleted
 * attachment, a revoked permission, a dead token) fails before the user has
 * been made to pick a filename for nothing. And the write happens *only*
 * after the dialog resolves, so nothing is ever written speculatively to a
 * location the user did not choose. One fetch, one dialog, one write, in that
 * order.
 *
 * A cancel is `{ ok: true, value: { canceled: true } }` and never a failure.
 * That distinction matters all the way up: the renderer's `unwrap()` throws on
 * any `ok: false` and every caller turns a throw into an error toast, so
 * modelling "the user changed their mind" as a failure would pop a red
 * message every time somebody pressed Escape.
 *
 * `shell.showItemInFolder` is this codebase's first use of `shell`, and it is
 * here because this app's toast system has no success channel — there is no
 * way to say "saved" except by showing the user the saved file. Revealing it
 * in Finder/Explorer is the confirmation, and it needs no new UI.
 */
export async function downloadAttachmentToDisk(
  win: BrowserWindow | null,
  attachmentId: string,
  suggestedFileName: string,
): Promise<JiraResult<{ canceled: boolean; savedPath?: string }>> {
  const fetched = await client.downloadAttachment(attachmentId);
  if (!fetched.ok) return fetched;

  const folder = downloadsDirectory();
  const fileName = safeBaseName(suggestedFileName);
  const options = {
    defaultPath: folder ? path.join(folder, fileName) : fileName,
  };
  // Two real overloads, not a cast — the same shape repoLink.ts uses:
  // parenting the sheet to the window is what makes it modal on macOS, and
  // there genuinely may be no window, in which case a free-floating dialog is
  // the right answer rather than an error.
  const chosen = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (chosen.canceled || !chosen.filePath) {
    return { ok: true, value: { canceled: true } };
  }

  try {
    await fs.promises.writeFile(chosen.filePath, fetched.value.bytes);
  } catch (err) {
    return fileFailure(`Couldn't save that file — ${reasonOf(err)}`);
  }

  shell.showItemInFolder(chosen.filePath);
  return { ok: true, value: { canceled: false, savedPath: chosen.filePath } };
}
