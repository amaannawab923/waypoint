import { useState } from 'react';
import {
  Download,
  File as FileIcon,
  FileAudio,
  FileVideo,
  ImageOff,
  Trash2,
} from 'lucide-react';
import { attachmentDownloadUrl, attachmentUrl } from '@/data/api';
import type { Attachment } from '@/types/entities';
import { AttachmentActionChip } from './AttachmentActionChip';
import { AttachmentLightbox } from './AttachmentLightbox';
import { attachmentKindOf, fileExtensionLabel, formatBytes } from './attachmentHelpers';

export interface AttachmentListProps {
  attachments: Attachment[];
  /** Whether the CURRENT VIEWER may delete these attachments — a single
   *  flag for the whole list (every attachment here belongs to one
   *  comment, so it's "am I this comment's author", not per-file). Read
   *  by the caller, who knows who's signed in; this component never
   *  inspects identity itself. */
  canDelete: boolean;
  onDelete?: (attachment: Attachment) => void;
}

function fileIconFor(mimeType: string) {
  const kind = attachmentKindOf(mimeType);
  if (kind === 'video') return FileVideo;
  if (kind === 'audio') return FileAudio;
  return FileIcon;
}

function ImageThumb({ attachment }: { attachment: Attachment }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex h-24 w-full items-center justify-center bg-surface-3">
        <ImageOff size={18} className="text-text-muted" aria-hidden="true" />
      </div>
    );
  }
  return (
    <img
      src={attachmentUrl(attachment)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className="h-24 w-full bg-surface-3 object-cover"
    />
  );
}

/**
 * Attachments displayed under a POSTED comment. Images render as a small
 * grid of always-labelled thumbnail cards (click opens the lightbox);
 * everything else renders as a row with a file-type icon. Download and
 * (when `canDelete`) delete are always visible on every item — never
 * behind hover, matching this surface's own "controls are visible, or
 * they don't exist" rule.
 */
export function AttachmentList({ attachments, canDelete, onDelete }: AttachmentListProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (attachments.length === 0) return null;

  const images = attachments.filter((a) => attachmentKindOf(a.mimeType) === 'image');
  const others = attachments.filter((a) => attachmentKindOf(a.mimeType) !== 'image');

  return (
    <div className="mt-2 flex flex-col gap-2">
      {images.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {images.map((a) => {
            const index = images.indexOf(a);
            return (
              <li key={a.id} className="overflow-hidden rounded-[var(--radius-sm)] border border-border bg-bg-inset">
                <button
                  type="button"
                  aria-label={`Open ${a.filename}`}
                  className="block w-full cursor-pointer text-left"
                  onClick={() => setLightboxIndex(index)}
                >
                  <ImageThumb attachment={a} />
                </button>
                <div className="px-1.5 py-1">
                  <div className="truncate text-[11px] text-text-secondary" title={a.filename}>
                    {a.filename}
                  </div>
                  <div className="text-[10px] text-text-muted">{formatBytes(a.sizeBytes)}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <AttachmentActionChip
                      icon={Download}
                      label="Download"
                      ariaLabel={`Download ${a.filename}`}
                      href={attachmentDownloadUrl(a)}
                    />
                    {canDelete && (
                      <AttachmentActionChip
                        icon={Trash2}
                        label="Delete"
                        ariaLabel={`Delete ${a.filename}`}
                        onClick={() => onDelete?.(a)}
                        danger
                      />
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {others.length > 0 && (
        <ul className="flex flex-col gap-1">
          {others.map((a) => {
            const Icon = fileIconFor(a.mimeType);
            return (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2 py-1.5"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-3">
                  <Icon size={14} className="text-text-muted" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-text" title={a.filename}>
                    {a.filename}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    {fileExtensionLabel(a.filename)} · {formatBytes(a.sizeBytes)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <AttachmentActionChip
                    icon={Download}
                    label="Download"
                    ariaLabel={`Download ${a.filename}`}
                    href={attachmentDownloadUrl(a)}
                  />
                  {canDelete && (
                    <AttachmentActionChip
                      icon={Trash2}
                      label="Delete"
                      ariaLabel={`Delete ${a.filename}`}
                      onClick={() => onDelete?.(a)}
                      danger
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {lightboxIndex !== null && (
        <AttachmentLightbox
          items={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
