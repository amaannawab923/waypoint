/**
 * ROAD-162 (attachments). Small, dependency-free formatting helpers shared
 * by AttachmentTray, AttachmentList, and AttachmentLightbox. Kept separate
 * from `lib/jiraMedia.ts` deliberately: that file's `sizeLabel`/`mediaKindOf`
 * work off `JiraAttachment`, a different shape that already carries a
 * server-formatted size string and a richer `mimeType`-free `fileName`
 * heuristic. Our own `Attachment` (from `@/types/entities`) only has
 * `sizeBytes` and `mimeType`, so it needs its own formatter rather than
 * bending that one to fit.
 */

export type AttachmentKind = 'image' | 'video' | 'audio' | 'other';

export function attachmentKindOf(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}

/** `0 B` for a genuine 0-byte file — not `NaN undefined` or a blank string,
 * both of which real uploads have produced (an empty screenshot clipboard
 * entry, a placeholder file some editor tools create). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '— B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/** Short label for a file-type badge/icon when there's no image preview to
 * show — the extension, uppercased, or "FILE" for a name with none (a
 * genuinely common case: a paste from some tools, a Dockerfile, a README
 * with no suffix). Deliberately from the FILENAME, not the mime type: a
 * mime type like `application/octet-stream` (what an unrecognized upload
 * commonly reports) says nothing useful, while a name almost always does. */
export function fileExtensionLabel(filename: string): string {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return 'FILE';
  const ext = trimmed.slice(lastDot + 1);
  if (!/^[A-Za-z0-9]{1,6}$/.test(ext)) return 'FILE';
  return ext.toUpperCase();
}
