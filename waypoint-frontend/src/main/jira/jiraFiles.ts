import { app, dialog, shell, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as client from './jiraClient';
import type { JiraFailure, JiraResult, JiraWireTicket } from './jiraTypes';

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
// Including on the failure path, which is where it used to break: Node
// embeds the absolute path in every fs error message, and returning
// `err.message` verbatim disclosed the folder a user had just saved into or
// uploaded from. `reasonOf` below maps errno to a fixed sentence instead.
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
/**
 * C0/C1 control characters, bidirectional overrides and zero-width
 * characters — everything that changes how a name RENDERS without changing
 * what it is. `no-control-regex` is disabled because matching them is the
 * entire point: this is the expression that removes them.
 */
/* eslint-disable no-control-regex -- matching them is how they are removed */
const FORGEABLE_DISPLAY_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

/** Comfortably inside the 255-byte limit common to APFS, ext4 and NTFS,
 *  with room for the numeric suffix a save dialog may append. */
const MAX_FILE_NAME_LENGTH = 200;

export function safeBaseName(rawFileName: string): string {
  if (typeof rawFileName !== 'string') return FALLBACK_FILE_NAME;

  const withoutNulls = rawFileName.split(NUL).join('');
  const base = path.basename(withoutNulls.replace(/\\/g, '/').trim());
  const scrubbed = base
    .replace(/[/\\:*?"<>|]/g, '_')
    // Control, bidi-override and zero-width characters. Separators were the
    // only thing scrubbed before, which defeated traversal but left the
    // dialog's *display* forgeable — and the dialog is the authorization, so
    // it is only as good as what it shows. A Jira attachment filename is
    // chosen by anyone who can attach to an issue this account can see, and
    // `invoice\u202Egnp.exe` renders as "invoicexe.png" in a native save
    // sheet: the user confirms an image and an executable lands in
    // Downloads. Embedded \r/\n similarly push the real extension out of
    // view. None of these belong in a filename under any circumstances.
    .replace(FORGEABLE_DISPLAY_CHARS, '')
    .trim();

  // "." and ".." are directory entries, not names — and are what `basename`
  // hands back for a path made of nothing but separators and dots.
  if (!scrubbed || /^\.+$/.test(scrubbed)) return FALLBACK_FILE_NAME;

  // Windows reserved device names, with or without an extension. Writing to
  // one does not create a file; it talks to a device.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(scrubbed)) {
    return `_${scrubbed}`;
  }

  // A filename has a real limit (255 bytes on most filesystems) and a Jira
  // one has no limit at all. Truncate from the front so the extension — the
  // part that decides what opens the file — survives.
  if (scrubbed.length > MAX_FILE_NAME_LENGTH) {
    const extension = path.extname(scrubbed).slice(0, 16);
    const stem = scrubbed
      .slice(0, MAX_FILE_NAME_LENGTH - extension.length)
      .trimEnd();
    return `${stem}${extension}`;
  }
  return scrubbed;
}

/** A local filesystem problem, in the user's terms rather than errno's. */
function fileFailure(message: string): JiraFailure {
  return { ok: false, reason: 'file_error', message };
}

/**
 * Attachment transfers currently in flight, keyed by whatever would
 * genuinely collide if two ran at once.
 *
 * The only guard against a duplicate transfer before this was a
 * `downloading`/`uploading` boolean in `JiraTicketDetail.tsx`'s own React
 * state — and that component mounts twice at once, once in the drawer and
 * once on the full ticket page, each with fully independent state. Two
 * clicks landing milliseconds apart from those two mounts would run two
 * downloads of the same attachment (or two uploads to the same ticket)
 * concurrently: each buffers up to `MAX_TRANSFER_BYTES` whole into this
 * process's heap, and a second upload additionally stacks a second native
 * picker on top of the first. Neither renderer copy can see the other's
 * state; only a guard here, which both IPC calls pass through on their way
 * to the filesystem and the network, can.
 *
 * One `Set` rather than two, but never one bare id in it: a download and an
 * upload draw their keys from separate id spaces (an attachment id, a
 * ticket id) that could otherwise collide on the same string, so every key
 * carries a `download:`/`upload:` prefix naming which space it came from.
 * A download is keyed on the attachment id and an upload on the ticket id —
 * not a single "any Jira transfer" lock — so that downloading two
 * *different* attachments, or uploading to two *different* tickets, at the
 * same time is still allowed. Only a duplicate request for the exact same
 * thing is refused.
 */
const inFlightTransfers = new Set<string>();

/** Claims `key` for the duration of a transfer, or refuses if it is already
 * claimed. Pair with `endTransfer` in a `finally` so the claim is released
 * whether the transfer succeeds, fails, or is cancelled by the user — a
 * lock that outlived its transfer would permanently block every later one
 * for the same attachment or ticket. */
function beginTransfer(key: string): boolean {
  if (inFlightTransfers.has(key)) return false;
  inFlightTransfers.add(key);
  return true;
}

function endTransfer(key: string): void {
  inFlightTransfers.delete(key);
}

/** What a caller is told when it lost the race for `beginTransfer`. */
function transferInProgress(message: string): JiraFailure {
  return { ok: false, reason: 'transfer_in_progress', message };
}

/**
 * A local filesystem failure in terms the renderer can be told.
 *
 * Deliberately NOT `err.message`. Node embeds the full absolute path in
 * every fs error — `ENOENT: no such file or directory, stat
 * '/Users/max/clients/acme-acquisition/term-sheet.pdf'` — and that string
 * was being returned as a JiraFailure message, crossing IPC and rendering in
 * a toast. That silently falsified this file's own headline rule, which says
 * no filesystem path crosses IPC in either direction: the success path was
 * carefully narrowed to honor it, and the failure path walked straight
 * through. The errno alone says what went wrong; the path it went wrong on
 * is the user's business and the main process's log, not the renderer's.
 */
function reasonOf(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  switch (code) {
    case 'ENOENT':
      return "that file isn't there any more";
    case 'EACCES':
    case 'EPERM':
      return "this app isn't allowed to read or write there";
    case 'ENOSPC':
      return 'the disk is full';
    case 'EISDIR':
      return 'that path is a folder, not a file';
    case 'EBUSY':
      return 'that file is in use by another program';
    default:
      return code ? `the filesystem reported ${code}` : 'an unknown error';
  }
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
 *
 * Single-flight per attachment id, via `beginTransfer`/`endTransfer` above:
 * a second call for the same `attachmentId` while this one is still running
 * is refused with `transfer_in_progress` rather than started, so two
 * independently-mounted copies of `JiraTicketDetail.tsx` clicking "Download"
 * for the same attachment cannot end up buffering it twice.
 */
export async function downloadAttachmentToDisk(
  win: BrowserWindow | null,
  attachmentId: string,
  suggestedFileName: string,
): Promise<JiraResult<{ canceled: boolean; savedPath?: string }>> {
  const transferKey = `download:${attachmentId}`;
  if (!beginTransfer(transferKey)) {
    return transferInProgress(
      'That attachment is already downloading — wait for it to finish before downloading it again.',
    );
  }

  try {
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
    return {
      ok: true,
      value: { canceled: false, savedPath: chosen.filePath },
    };
  } finally {
    endTransfer(transferKey);
  }
}

/**
 * A minimal extension → mime type lookup.
 *
 * Node has no built-in mime sniffing and this repo has no mime library. One
 * field on one request is not worth a new dependency and its supply chain, so
 * this covers the handful of types people actually attach to a ticket and
 * answers `application/octet-stream` for everything else — which is not a
 * degraded fallback but the correct name for bytes of unknown kind. Jira
 * stores what it is told and shows the filename either way; the type mostly
 * decides whether the file previews inline.
 *
 * Extension-based rather than content-based on purpose. Sniffing magic bytes
 * would be more accurate and would also mean this app quietly disagreeing
 * with the user's own filename about what their file is.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export function mimeTypeForFileName(fileName: string): string {
  return (
    MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ??
    'application/octet-stream'
  );
}

/**
 * Lets the user pick a file and attaches it to an issue.
 *
 * The renderer asks for this by issue id and nothing else. It cannot name a
 * file, which is the entire point: the native picker is the authorization, so
 * there is no path to validate and no way for anything upstream to choose what
 * gets read off this machine. The path the dialog returns lives for the three
 * statements that stat it, read it and send it.
 *
 * `stat` before `readFile`, in that order, because the order is the guard. A
 * size cap enforced after the read has already done the thing it exists to
 * prevent — pulling an arbitrarily large file into the main process's heap.
 *
 * The local cap is a ceiling, not a prediction. Most sites' real attachment
 * limit is well below it (Jira Cloud's own default is 10MB), and that limit is
 * Jira's to enforce and explain: its own refusal names the site's actual
 * number, where a guess made here would be wrong in both directions. What this
 * check is for is the case Jira never gets to answer, because the file was too
 * big to hold in the first place.
 *
 * Single file per upload — `showOpenDialog` without `multiSelections` is
 * single-select, so this is the dialog's own default rather than something
 * enforced afterwards. See `uploadAttachment` for why multi-file is a later
 * expansion and not a quiet promise.
 *
 * A cancel is `{ ok: true, value: { canceled: true } }`, never a failure, for
 * the same reason as the download: the renderer turns every `ok: false` into
 * an error toast, and closing a file picker is not an error.
 *
 * Single-flight per ticket id, via `beginTransfer`/`endTransfer` above: a
 * second call for the same `ticketId` while this one is still running is
 * refused with `transfer_in_progress` before it ever opens a picker, so two
 * independently-mounted copies of `JiraTicketDetail.tsx` clicking "Attach a
 * file" for the same ticket cannot stack a second native dialog on top of
 * the first. Keyed on the ticket rather than the file, since no file is even
 * chosen until after the guard is claimed.
 */
export async function pickAndUploadAttachment(
  win: BrowserWindow | null,
  ticketId: string,
): Promise<JiraResult<{ canceled: boolean; ticket?: JiraWireTicket }>> {
  const transferKey = `upload:${ticketId}`;
  if (!beginTransfer(transferKey)) {
    return transferInProgress(
      'An upload to this ticket is already in progress — wait for it to finish before attaching another file.',
    );
  }

  try {
    // `['openFile']` with no `multiSelections`, which is what makes this
    // single-select — the same call repoLink.ts makes for a folder.
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
      : await dialog.showOpenDialog({ properties: ['openFile'] });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true, value: { canceled: true } };
    }
    const [filePath] = picked.filePaths;

    let size: number;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch (err) {
      return fileFailure(`Couldn't read that file — ${reasonOf(err)}`);
    }
    if (size > client.MAX_TRANSFER_BYTES) {
      return fileFailure(
        `That file is ${Math.round(size / (1024 * 1024))}MB, past the ${Math.round(
          client.MAX_TRANSFER_BYTES / (1024 * 1024),
        )}MB this app will upload. Your Jira site's own limit is likely lower still — attach it in Jira if it needs to go up.`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(filePath);
    } catch (err) {
      return fileFailure(`Couldn't read that file — ${reasonOf(err)}`);
    }

    // `path.basename`, not `safeBaseName`: this name came from the OS's own
    // picker rather than from a Jira payload, so it needs stripping of its
    // directory and nothing else — scrubbing it would mangle a legitimate
    // filename the user chose.
    const fileName = path.basename(filePath);
    const uploaded = await client.uploadAttachment(
      ticketId,
      fileName,
      bytes,
      mimeTypeForFileName(fileName),
    );
    if (!uploaded.ok) return uploaded;

    return { ok: true, value: { canceled: false, ticket: uploaded.value } };
  } finally {
    endTransfer(transferKey);
  }
}
