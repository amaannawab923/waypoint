import { FileWarning, Play } from 'lucide-react';
import { useState } from 'react';
import {
  isViewable,
  jiraThumbnailUrl,
  mediaKindOf,
  type JiraMediaKind,
} from '@/lib/jiraMedia';
import type { JiraAttachment } from '@/types/jira';

/**
 * The attachment cards Jira shows above the comment box, matched to what
 * Jira actually renders (observed on a live issue, 2026-09-25): a real
 * poster frame filling the card, a solid dark circle with a white play
 * triangle centred on it for anything playable, then the filename and
 * size.
 *
 * The poster comes from Jira's own thumbnail endpoint for EVERY type, not
 * just video. A video has no other still to show, and an image has no
 * business decoding its 4K original to fill a 72-pixel box.
 */
export interface JiraAttachmentStripProps {
  attachments: JiraAttachment[];
  onOpen: (attachment: JiraAttachment) => void;
  onDownload: (attachment: JiraAttachment) => void;
  downloadingId: string | null;
}

function Poster({
  attachment,
  kind,
}: {
  attachment: JiraAttachment;
  kind: JiraMediaKind;
}) {
  const [broken, setBroken] = useState(false);
  const playable = kind === 'video' || kind === 'audio';

  // `other` is everything the viewer refuses to preview — a zip, and
  // deliberately SVG (jiraMedia.ts). Asking Jira for a poster for one of
  // those would put bytes of an unknown kind into an <img> for no gain:
  // there is nothing to play and nothing to open.
  if (!attachment.id || broken || kind === 'other') {
    return (
      <div className="flex h-[92px] w-full items-center justify-center bg-surface-3">
        {playable ? (
          <PlayBadge />
        ) : (
          <FileWarning
            aria-hidden="true"
            size={18}
            className="text-text-muted"
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-[92px] w-full bg-surface-3">
      <img
        src={jiraThumbnailUrl(attachment.id)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
      {playable && (
        <span className="absolute inset-0 flex items-center justify-center">
          <PlayBadge />
        </span>
      )}
    </div>
  );
}

/** Jira's play affordance: a solid dark disc with a white triangle. */
function PlayBadge() {
  return (
    <span className="flex size-10 items-center justify-center rounded-full bg-[rgb(23,25,28)]/90 shadow-sm">
      <Play
        aria-hidden="true"
        size={16}
        className="ml-0.5 fill-white text-white"
      />
    </span>
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
    <ul className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {attachments.map((a) => {
        const kind = mediaKindOf(a);
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
                className="block w-full cursor-pointer text-left"
                aria-label={
                  kind === 'video' || kind === 'audio'
                    ? `Play ${a.fileName}`
                    : `Open ${a.fileName}`
                }
                onClick={() => onOpen(a)}
              >
                <Poster attachment={a} kind={kind} />
              </button>
            ) : (
              <Poster attachment={a} kind={kind} />
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
                    // Kept as the full phrase rather than trimmed to fit
                    // the card: "in Jira" alone does not say what the
                    // person is meant to do there.
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
