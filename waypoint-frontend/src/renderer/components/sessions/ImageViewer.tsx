import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { IconChevron, IconX } from '@/components/icons';

export interface ViewerImage {
  id: string;
  name: string;
  dataUrl: string;
}

/**
 * The lightbox for a run's screenshots. Opens on the image that was
 * clicked (chat-ui's `onViewImage` on a tool row) with every other image
 * in the transcript beside it, in the order they were taken: ← → and the
 * filmstrip move between them, Escape closes, a click on the backdrop
 * closes. Fit to the window, never scaled up past natural size.
 *
 * `images` is the run's full list at the moment of opening (collected
 * from the transcript by the caller); `initialId` is the one to start on.
 */
export function ImageViewer({
  images,
  initialId,
  onClose,
}: {
  images: readonly ViewerImage[];
  initialId: string | null;
  onClose: () => void;
}) {
  const open = initialId !== null && images.length > 0;
  const [index, setIndex] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Land on the clicked image each time the viewer opens.
  useEffect(() => {
    if (!open) return;
    const at = images.findIndex((i) => i.id === initialId);
    setIndex(at === -1 ? 0 : at);
  }, [open, initialId, images]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, images.length - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previousFocus.current?.focus?.();
    };
  }, [open, onClose, images.length]);

  if (!open) return null;
  const current = images[Math.min(index, images.length - 1)];
  const many = images.length > 1;
  const first = index === 0;
  const last = index >= images.length - 1;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${current.name}${many ? `, ${index + 1} of ${images.length}` : ''}`}
      data-image-viewer
      className="fixed inset-0 z-50 flex flex-col bg-black/85 text-white"
      onClick={onClose}
    >
      <div
        className="flex shrink-0 items-center justify-between px-4 py-2.5 text-[12px]"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate font-mono text-white/80">{current.name}</span>
        <div className="flex items-center gap-3">
          {many && (
            <span
              className="font-mono tabular-nums text-white/60"
              data-viewer-counter
            >
              {index + 1} / {images.length}
            </span>
          )}
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            <IconX size={14} />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14">
        {many && (
          <button
            type="button"
            aria-label="Previous image"
            disabled={first}
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.max(i - 1, 0));
            }}
            className={clsx(
              'absolute left-3 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white',
              first && 'invisible',
            )}
          >
            <IconChevron size={16} className="rotate-90" />
          </button>
        )}
        <img
          key={current.id}
          src={current.dataUrl}
          alt={current.name}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded-[var(--radius-sm)] object-contain shadow-2xl"
        />
        {many && (
          <button
            type="button"
            aria-label="Next image"
            disabled={last}
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.min(i + 1, images.length - 1));
            }}
            className={clsx(
              'absolute right-3 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white',
              last && 'invisible',
            )}
          >
            <IconChevron size={16} className="-rotate-90" />
          </button>
        )}
      </div>

      {many && (
        <div
          className="thin-scroll flex shrink-0 justify-center gap-2 overflow-x-auto px-4 py-3"
          onClick={(e) => e.stopPropagation()}
          data-viewer-filmstrip
        >
          {images.map((image, i) => (
            <button
              key={image.id}
              type="button"
              aria-label={`Show ${image.name}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => setIndex(i)}
              className={clsx(
                'h-14 w-[88px] shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-white/10 ring-2 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-white',
                i === index
                  ? 'ring-white'
                  : 'ring-transparent opacity-60 hover:opacity-100',
              )}
            >
              <img
                src={image.dataUrl}
                alt=""
                className="h-full w-full object-cover object-top"
              />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
