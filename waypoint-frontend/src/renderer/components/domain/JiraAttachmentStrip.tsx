import { FileWarning } from 'lucide-react';
import { useState } from 'react';
import { isViewable, jiraMediaUrl, mediaKindOf } from '@/lib/jiraMedia';
import type { JiraAttachment } from '@/types/jira';

/**
 * The attachment thumbnails Jira shows above the comment box: a preview, the
 * filename, and the size. A file with no preview (a zip, or an image the
 * renderer cannot decode) gets a marked placeholder — Jira does the same,
 * including for a 435 B transparent PNG, so that is parity rather than a
 * gap.
 */
export interface JiraAttachmentStripProps {
  attachments: JiraAttachment[];
  onOpen: (attachment: JiraAttachment) => void;
  onDownload: (attachment: JiraAttachment) => void;
  downloadingId: string | null;
}

function Thumb({ attachment }: { attachment: JiraAttachment }) {
  const [broken, setBroken] = useState(false);
  const previewable =
    isViewable(attachment) && mediaKindOf(attachment) === 'image';
  if (!previewable || broken || !attachment.id) {
    return (
      <div className="flex h-[72px] w-full items-center justify-center bg-surface-3">
        <FileWarning aria-hidden="true" size={18} className="text-text-muted" />
      </div>
    );
  }
  return (
    <img
      src={jiraMediaUrl(attachment.id)}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="h-[72px] w-full bg-surface-3 object-cover"
    />
  );
}

export function JiraAttachmentStrip({
  attachments,
  onOpen,
  onDownload,
  downloadingId,
}: JiraAttachmentStripProps) {
  if (attachments.length === 0) {
    return (
      <p className="mb-6 text-[12.5px] text-text-muted">
        Nothing attached yet.
      </p>
    );
  }

  return (
    <ul className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
      {attachments.map((a) => {
        const openable = isViewable(a);
        return (
          <li
            // Jira lets two attachments on one issue share a filename, so
            // the name alone was a real key collision.
            key={a.id ?? a.fileName}
            className="overflow-hidden rounded-[var(--radius-sm)] border border-border bg-bg-inset"
          >
            {openable ? (
              <button
                type="button"
                className="block w-full cursor-zoom-in text-left"
                aria-label={`Open ${a.fileName}`}
                onClick={() => onOpen(a)}
              >
                <Thumb attachment={a} />
              </button>
            ) : (
              <Thumb attachment={a} />
            )}
            <div className="px-2 py-1.5">
              <div
                className="truncate font-mono text-[11px] text-text-secondary"
                title={a.fileName}
              >
                {a.fileName}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="truncate text-[10.5px] text-text-muted">
                  {a.sizeLabel}
                </span>
                {a.id ? (
                  <button
                    type="button"
                    className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-secondary hover:bg-surface-2 hover:text-text disabled:opacity-60"
                    disabled={downloadingId !== null}
                    onClick={() => onDownload(a)}
                  >
                    {downloadingId === a.id ? 'Saving…' : 'Download'}
                  </button>
                ) : (
                  <span
                    // Kept as the full phrase rather than trimmed to fit the
                    // card: "in Jira" alone does not say what the person is
                    // meant to do there.
                    className="ml-auto truncate rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-muted"
                    title="Jira didn't return an id for this attachment."
                  >
                    download in Jira
                  </span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
