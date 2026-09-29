import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { AlertCircle, File as FileIcon, RotateCcw, X } from 'lucide-react';
import { attachmentUrl } from '@/data/api';
import type { Attachment } from '@/types/entities';
import { AttachmentActionChip } from './AttachmentActionChip';
import { attachmentKindOf, fileExtensionLabel, formatBytes } from './attachmentHelpers';

export type UploadItemStatus = 'uploading' | 'done' | 'error' | 'aborted';

/** One pending/completed upload in a composer's attachment tray. Owned by
 * whoever calls `uploadAttachment` (TicketDetailPage.tsx) — this component
 * is purely presentational over this shape. `key` is a client-side id
 * (stable across retries of the SAME logical upload), not the server's
 * Attachment id, since that doesn't exist until the upload succeeds. */
export interface UploadItem {
  key: string;
  file: File;
  /** Present once the upload has succeeded. */
  attachment?: Attachment;
  /** 0–1. Ignored once `status` is no longer 'uploading'. */
  progress: number;
  status: UploadItemStatus;
  /** Human-readable failure reason, shown inline when `status === 'error'`. */
  error?: string;
}

export interface AttachmentTrayProps {
  items: UploadItem[];
  /** Re-attempt a failed or aborted upload. */
  onRetry: (key: string) => void;
  /** Cancel an in-progress upload, or remove a finished/failed one from the
   *  tray. Same callback for both — see the per-item action button, whose
   *  icon and label already say which one it is doing. */
  onRemove: (key: string) => void;
}

function statusText(item: UploadItem): string {
  switch (item.status) {
    case 'uploading':
      return `Uploading ${Math.round(item.progress * 100)}%`;
    case 'done':
      return 'Uploaded';
    case 'error':
      return item.error ? `Upload failed: ${item.error}` : 'Upload failed';
    case 'aborted':
      return 'Upload canceled';
    default:
      return '';
  }
}

function TrayThumbnail({ item }: { item: UploadItem }) {
  const kind = attachmentKindOf(item.file.type);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  // Local preview only while there's no server copy yet — revoked the
  // moment `item.attachment` shows up (the upload finished) as well as on
  // unmount, so a rejected/removed screenshot paste doesn't hold its blob
  // URL alive for the rest of the session.
  useEffect(() => {
    if (kind !== 'image' || item.attachment) {
      setLocalUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(item.file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.file, kind, !!item.attachment]);

  const [broken, setBroken] = useState(false);

  if (kind !== 'image' || broken) {
    return (
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-2 text-[9px] font-bold text-text-muted"
        aria-hidden="true"
      >
        {fileExtensionLabel(item.file.name)}
      </div>
    );
  }

  const src = item.attachment ? attachmentUrl(item.attachment.id) : localUrl;
  if (!src) {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-2" aria-hidden="true">
        <FileIcon size={16} className="text-text-muted" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className="size-10 shrink-0 rounded-[var(--radius-sm)] bg-surface-2 object-cover"
    />
  );
}

function TrayItem({
  item,
  onRetry,
  onRemove,
}: {
  item: UploadItem;
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const isFailed = item.status === 'error' || item.status === 'aborted';
  const sizeBytes = item.attachment?.sizeBytes ?? item.file.size;

  return (
    <li
      className={clsx(
        'flex w-72 flex-col gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1.5',
        isFailed ? 'border-danger/40 bg-danger-bg/40' : 'border-border bg-surface',
      )}
    >
      <div className="flex items-center gap-2">
        <TrayThumbnail item={item} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text" title={item.file.name}>
            {item.file.name}
          </span>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-text-muted">
            <span>{formatBytes(sizeBytes)}</span>
            {item.status === 'uploading' && (
              <>
                <span aria-hidden="true">·</span>
                <span>{Math.round(item.progress * 100)}%</span>
              </>
            )}
          </div>
          {item.status === 'uploading' && (
            <div
              role="progressbar"
              aria-label={`Uploading ${item.file.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(item.progress * 100)}
              className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-200"
                style={{ width: `${Math.min(100, Math.max(0, item.progress * 100))}%` }}
              />
            </div>
          )}
          {isFailed && (
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-danger">
              <AlertCircle size={11} className="shrink-0" aria-hidden="true" />
              <span className="truncate" title={item.error}>
                {item.status === 'aborted' ? 'Canceled' : (item.error ?? 'Upload failed')}
              </span>
            </div>
          )}
          {/* Terse, not a running percentage — a screen reader user hears
              this once per state change (queued → uploading is silent,
              uploading → done/failed/canceled announces), not once per
              progress tick. */}
          <span className="sr-only" role="status" aria-live="polite">
            {item.status === 'done' || isFailed ? statusText(item) : ''}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {isFailed && (
          <AttachmentActionChip
            icon={RotateCcw}
            label="Retry"
            ariaLabel={`Retry uploading ${item.file.name}`}
            onClick={() => onRetry(item.key)}
          />
        )}
        <AttachmentActionChip
          icon={X}
          label={item.status === 'uploading' ? 'Cancel' : 'Remove'}
          ariaLabel={
            item.status === 'uploading' ? `Cancel uploading ${item.file.name}` : `Remove ${item.file.name}`
          }
          onClick={() => onRemove(item.key)}
          danger
        />
      </div>
    </li>
  );
}

/**
 * The composer's pending-upload strip, shown under MarkdownEditor while
 * files are being attached to a draft comment. Purely presentational: the
 * caller owns the upload loop (calling `uploadAttachment`, tracking
 * progress/aborts, retrying) and hands this component the resulting list.
 *
 * Every state is visible without a hover: progress, error text, and every
 * action (cancel/retry/remove) render inline, not behind opacity-0.
 */
export function AttachmentTray({ items, onRetry, onRemove }: AttachmentTrayProps) {
  if (items.length === 0) return null;

  return (
    <ul
      aria-label="Attachments"
      className="thin-scroll mt-2 flex max-h-48 flex-wrap gap-2 overflow-y-auto"
    >
      {items.map((item) => (
        <TrayItem key={item.key} item={item} onRetry={onRetry} onRemove={onRemove} />
      ))}
    </ul>
  );
}
