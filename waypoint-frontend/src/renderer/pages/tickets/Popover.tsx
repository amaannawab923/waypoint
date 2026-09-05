import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';

/**
 * Small local dropdown helper shared by the tickets toolbar (Display,
 * Filters). Not a app-wide primitive — kept local to this page directory
 * since no shared Popover exists in src/components/ui.
 *
 * It now has a second caller outside this directory: My Jira's own toolbar
 * (pages/jira/MyJiraToolbar.tsx), which reaches across for it rather than
 * growing a third near-identical dropdown. That makes the "kept local"
 * justification above half-true — two page directories is not local. It is
 * left where it is on purpose for now, because moving it to components/ui/
 * is a promotion to a shared primitive and two callers is thin evidence for
 * one. A THIRD caller is the point at which that stops being true: move it
 * to components/ui/Popover.tsx then, rather than adding another cross-page
 * import to this one.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
}: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={clsx(
            'thin-scroll absolute z-40 mt-1.5 max-h-[70vh] overflow-y-auto rounded-[var(--radius)] border border-border bg-surface p-2 shadow-2xl',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
