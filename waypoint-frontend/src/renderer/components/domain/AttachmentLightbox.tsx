import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { attachmentDownloadUrl, attachmentUrl } from '@/data/api';
import type { Attachment } from '@/types/entities';
import { formatBytes } from './attachmentHelpers';

export interface AttachmentLightboxProps {
  /** The full navigable set — every image in the same comment's attachment
   *  list, in display order. Not just the one that was clicked. */
  items: Attachment[];
  /** Index into `items` to open at. */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen modal image viewer, opened from AttachmentList. Built fresh
 * rather than on top of `components/ui/Modal.tsx`: Modal's centered
 * header/body/footer chrome (capped at 78vh, a title bar with a fixed
 * layout) is the right shape for a form or a confirmation, not a full-bleed
 * image — the same reason the Jira surface's own equivalent
 * (JiraMediaViewer.tsx) doesn't build on it either. The focus-trap and
 * Escape-scoping approach below mirrors JiraMediaViewer's, which already
 * solved the "don't also close an ancestor drawer" and "Tab must not
 * escape while a control it was on unmounts" problems this needs too.
 */
export function AttachmentLightbox({ items, index, onIndexChange, onClose }: AttachmentLightboxProps) {
  const current = items[index];
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFailed(false);
  }, [current?.id]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (items.length === 0) return;
      onIndexChange((index + delta + items.length) % items.length);
    },
    [index, items.length, onIndexChange],
  );

  // Escape closes THIS viewer only. Capture phase + stopImmediatePropagation
  // so a single Escape press doesn't also reach an ancestor's own
  // document-level Escape listener (a ticket drawer, a modal this opened
  // from inside) and close that too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        step(1);
      } else if (e.key === 'ArrowLeft') {
        step(-1);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, step]);

  // Focus moves into the dialog on open and returns to whatever opened it
  // (the thumbnail button in AttachmentList) on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // Tab trap. Self-healing against the focused control disappearing out
  // from under it (e.g. stepping to an attachment whose Download link has a
  // different href/key, or a broken image removing whatever was focused) —
  // if focus ever ends up outside the panel, pull it back to the first
  // focusable element instead of only handling the two ends it already
  // expects.
  useEffect(() => {
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab, true);
    return () => document.removeEventListener('keydown', onTab, true);
  }, []);

  if (!current) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${current.filename}, image ${index + 1} of ${items.length}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-[rgb(23,25,28)] outline-none motion-safe:transition-opacity motion-safe:duration-150"
      onMouseDown={(e) => {
        // Backdrop click closes; a click on the image or the chrome must
        // not, or dragging a selection across the image would dismiss it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 py-3 text-white">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{current.filename}</div>
          <div className="truncate text-[11.5px] text-white/60">
            {/* Visible position for sighted users; the aria-live span below
                announces the same thing to a screen reader on every arrow
                press, independent of whether focus itself moved. */}
            {formatBytes(current.sizeBytes)} · {index + 1} of {items.length}
          </div>
        </div>
        <a
          href={attachmentDownloadUrl(current)}
          aria-label={`Download ${current.filename}`}
          title="Download"
          className="rounded p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Download size={16} aria-hidden="true" />
        </a>
        <button
          type="button"
          aria-label="Close viewer"
          title="Close"
          onClick={onClose}
          className="rounded p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <span className="sr-only" role="status" aria-live="polite">
        Image {index + 1} of {items.length}: {current.filename}
      </span>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {items.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => step(-1)}
              className="absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white shadow-lg ring-1 ring-white/20 hover:bg-black/75"
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => step(1)}
              className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white shadow-lg ring-1 ring-white/20 hover:bg-black/75"
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </>
        )}
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          {failed ? (
            <p className="text-[12.5px] text-white/70">
              This image couldn&apos;t be loaded. Download it to view it.
            </p>
          ) : (
            <img
              src={attachmentUrl(current)}
              alt={current.filename}
              onError={() => setFailed(true)}
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
