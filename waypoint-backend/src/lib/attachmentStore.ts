import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ValidationError } from '../middleware/errors.js';

// ROAD-162 attachments: everything about a stored file that is NOT a
// database row. Kept out of the service so the pure parts (filename
// sanitizing, MIME normalizing, header building, path resolution) are unit
// testable without a database or a request.

/**
 * Where uploaded bytes live.
 *
 * Same shape as secretBox.ts's keyFilePath() — an env override first, then
 * a fixed directory under the home directory — and deliberately the same
 * `~/.waypoint` parent, so an operator has one place to back up, mount as
 * a volume (see docker-compose.yml's container filesystem caveat in
 * secretBox.ts), or wipe. Never anywhere under the repo: files a user
 * uploads must not be reachable by an over-broad `git add` or end up in a
 * Docker build context.
 *
 * Read on every call rather than cached, so a test (or a process that
 * rewrites its own env on startup) gets the directory it just set.
 */
export function attachmentsRoot(): string {
  return process.env.WAYPOINT_ATTACHMENTS_DIR || path.join(homedir(), '.waypoint', 'attachments');
}

// The on-disk name is derived from the generated id and NOTHING else (see
// the schema comment on attachments.filename). Ids come from newId(), whose
// alphabet is lowercase letters, digits, and the prefix hyphen — this is a
// defence-in-depth assertion that a value which somehow reached here from
// anywhere but newId() still can't carry a separator, a `..`, a NUL, or a
// drive letter into path.resolve.
const STORED_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STORED_FILE_SUFFIX = '.bin';

/**
 * The absolute path for one attachment's bytes.
 *
 * Two independent checks, both kept even though the id is server-generated:
 * the id pattern above, and a resolve-then-compare that proves the result
 * is still the one file directly inside the root we intended. Path
 * traversal here would be a read/unlink primitive over the whole
 * filesystem, so "the id can't be hostile" is not a good enough reason to
 * skip the check that makes it true.
 */
export function attachmentFilePath(id: string): string {
  if (!STORED_ID_PATTERN.test(id)) {
    throw new ValidationError('attachment id is not a valid storage key');
  }
  const root = path.resolve(attachmentsRoot());
  const expected = path.join(root, `${id}${STORED_FILE_SUFFIX}`);
  const resolved = path.resolve(root, `${id}${STORED_FILE_SUFFIX}`);
  if (resolved !== expected || !resolved.startsWith(root + path.sep)) {
    throw new ValidationError('attachment path escaped the storage root');
  }
  return resolved;
}

/** Writes one attachment's bytes, creating the root on first use.
 * `wx` (create-only), not a plain write: an id collision must fail loudly
 * rather than silently overwrite somebody else's file. 0o600 for the same
 * reason secretBox.ts writes its key that way — uploaded content is the
 * user's, not the machine's. */
export async function writeAttachmentFile(id: string, bytes: Buffer): Promise<void> {
  const filePath = attachmentFilePath(id);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
}

/** Opens one attachment for streaming. Resolves the byte size first so the
 * caller can set Content-Length and turn a missing file into a clean error
 * BEFORE any header is sent — a stream error after `res.writeHead` can only
 * destroy a half-written response. */
export async function openAttachmentFile(id: string): Promise<{ stream: ReadStream; sizeBytes: number }> {
  const filePath = attachmentFilePath(id);
  const stats = await stat(filePath);
  return { stream: createReadStream(filePath), sizeBytes: stats.size };
}

/** Best-effort removal. A file that is already gone is the desired end
 * state, not an error — this runs after the row is deleted, and a throw
 * here would report failure for an operation that actually succeeded. */
export async function deleteAttachmentFile(id: string): Promise<void> {
  try {
    await unlink(attachmentFilePath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    console.error(`Failed to unlink attachment file for ${id}:`, err);
  }
}

export const DEFAULT_FILENAME = 'attachment';
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

// Long enough for any real filename, short enough that a megabyte of
// header text can't land in a text column or a response header.
const MAX_FILENAME_LENGTH = 200;

/**
 * Turns a client-supplied name into something safe to STORE AND DISPLAY.
 * It is never a path (attachmentFilePath above is the only thing that
 * builds one, from the id), so this is about two things:
 *
 *   - nothing that reads like a directory traversal survives, so a name is
 *     never mistaken for a location by this code or by whatever a client
 *     does with it on the way to a Save dialog;
 *   - no control characters — CR/LF above all, which would otherwise be a
 *     response-splitting vector in Content-Disposition, and NUL, which
 *     truncates a C-string path in whatever tool a user pipes it through.
 *
 * Falls back to a fixed default rather than throwing: a hostile-looking
 * name is a reason to ignore the name, not to reject an upload the person
 * legitimately made.
 */
export function sanitizeFilename(raw: string): string {
  // Both separators, not just the platform's: a Windows client's
  // `..\\..\\secrets.txt` must lose its directories on a Linux server too.
  const base = raw.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const withoutControl = base.replace(/[\u0000-\u001f\u007f]/g, '');
  const withoutQuotes = withoutControl.replace(/"/g, '');
  const trimmed = withoutQuotes.trim();
  // `.` and `..` survive the basename step intact and are the one residue
  // that still names a directory rather than a file.
  if (trimmed === '' || /^\.+$/.test(trimmed)) return DEFAULT_FILENAME;
  return trimmed.length > MAX_FILENAME_LENGTH ? trimmed.slice(0, MAX_FILENAME_LENGTH) : trimmed;
}

/**
 * Decodes the percent-encoded `x-waypoint-filename` header. Percent
 * encoding is what lets a non-ASCII name (or one containing a character
 * HTTP forbids in a header value) survive the trip at all.
 *
 * A malformed escape falls back to the raw header text rather than
 * failing the upload — either way the result goes through
 * sanitizeFilename, so the safety of the outcome does not depend on the
 * decode having succeeded.
 */
export function decodeFilenameHeader(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_FILENAME;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return sanitizeFilename(decoded);
}

// One RFC 2045 token: the type and the subtype are each checked against
// this before either is trusted into a response header.
const MIME_TOKEN_PATTERN = /^[a-z0-9][a-z0-9!#$&^_+.-]{0,126}$/;

/**
 * Normalizes `content-type` down to a bare `type/subtype`, or the generic
 * octet-stream when it is absent or unrecognizable. Parameters (`; charset=`,
 * `; boundary=`) are dropped rather than stored: they are the part of the
 * header an attacker has the most room in, and nothing here needs them.
 */
export function normalizeMimeType(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_MIME_TYPE;
  const essence = raw.split(';')[0].trim().toLowerCase();
  const slash = essence.indexOf('/');
  if (slash <= 0) return DEFAULT_MIME_TYPE;
  const type = essence.slice(0, slash);
  const subtype = essence.slice(slash + 1);
  if (!MIME_TOKEN_PATTERN.test(type) || !MIME_TOKEN_PATTERN.test(subtype)) return DEFAULT_MIME_TYPE;
  return `${type}/${subtype}`;
}

/**
 * The ONLY types this API will render in the browser rather than hand
 * straight to a download. An allowlist, not a denylist: a stored file is
 * served from the API's own origin, so anything the browser treats as
 * active content there (text/html, image/svg+xml — an SVG is a document
 * with scripts, not a picture — application/xml, anything ending in
 * +xml, any javascript type) would run with access to this origin.
 *
 * Deliberately absent, and worth naming so nobody "fixes" the omission:
 *   - image/svg+xml — scriptable, the classic stored-XSS upload.
 *   - text/html, application/xhtml+xml, text/xml, application/xml.
 *   - text/csv — Safari has historically rendered it, and a CSV is a
 *     spreadsheet-injection vector once saved anyway; a download is the
 *     honest outcome.
 * application/pdf stays IN: every browser that renders one does it in its
 * own sandboxed viewer, and inline preview is most of the point of
 * attaching one.
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'application/pdf',
  'text/plain',
]);

export function isInlineSafeMimeType(mimeType: string): boolean {
  return INLINE_SAFE_MIME_TYPES.has(mimeType);
}

/** The value to send as Content-Type. text/plain gets an explicit charset
 * so a browser never has to guess one from the bytes (the guess is where
 * the exotic-encoding XSS tricks live); everything else is served exactly
 * as normalized, alongside a nosniff header the route sets. */
export function responseContentType(mimeType: string): string {
  return mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : mimeType;
}

// encodeURIComponent leaves ! ' ( ) * ~ alone, and of those ' ( ) * are not
// RFC 5987 attr-chars — a name containing one would produce a technically
// malformed ext-value. Percent-encode them too, so the header is
// well-formed for EVERY input rather than for most of them.
function encodeExtValue(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Content-Disposition for the download route (and for the inline route
 * whenever the type isn't inline-safe).
 *
 * Only the RFC 5987 `filename*` form, never a bare quoted `filename=`:
 * the percent-encoded ext-value cannot contain a quote, a semicolon, or a
 * CR/LF no matter what the name held, which makes header forgery
 * structurally impossible rather than dependent on sanitizeFilename having
 * caught everything.
 */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeExtValue(filename)}`;
}
