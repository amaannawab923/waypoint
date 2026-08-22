import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Closing the modal (Escape, backdrop click, the × button, or a footer
  // action) otherwise drops focus to <body> once the portal unmounts —
  // round-3 QA flagged that as a real loss-of-place for keyboard and
  // screen-reader users. Kept on its own effect keyed only on `open`, not
  // `onClose`, since callers commonly pass a fresh inline handler every
  // render — depending on it here would recapture/restore focus on every
  // unrelated re-render while the modal is open.
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[78vh] w-full flex-col rounded-[var(--radius-lg)] border border-border bg-surface shadow-2xl"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-display text-base font-medium">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        {/* Body scrolls on its own; header and footer stay pinned so the
            primary action never scrolls out of view with no visual cue —
            round-3 QA found the Cancel/Dispatch buttons could disappear
            below the fold with nothing hinting more content existed. */}
        <div className="thin-scroll min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
