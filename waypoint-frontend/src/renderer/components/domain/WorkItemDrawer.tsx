import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { WorkItemDetailContent } from '@/pages/work-items/WorkItemDetailPage';

/**
 * Controlled "peek" panel: slides in from the right edge showing a work item's
 * full detail without navigating away. Mirrors Modal.tsx's portal/backdrop/
 * ESC-to-close convention, docked to the right instead of centered.
 *
 * This component is intentionally dumb — it does not track which item (if any)
 * is peeked; the caller mounts it with a `projectId`/`identifier` pair and
 * unmounts (or swaps) it to change what's shown.
 */
export function WorkItemDrawer({
  projectId,
  identifier,
  onClose,
}: {
  projectId: string;
  identifier: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // Mount closed, then flip to open on the next frame so the initial render
  // starts off-screen and the transition actually animates in.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleExpand() {
    // Clear the peek param (via replace, while still on the list route)
    // BEFORE navigating away, so the list's history entry is clean. If this
    // ran after navigate(), it would fire against the wrong route and the
    // list entry would keep peek=identifier — back from the full page would
    // land on "list with drawer open" instead of the plain list.
    onClose();
    navigate(`/projects/${projectId}/work-items/${identifier}`);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className="thin-scroll absolute inset-y-0 right-0 flex h-full w-full max-w-[720px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
        style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <WorkItemDetailContent
          projectId={projectId}
          identifier={identifier}
          variant="drawer"
          onClose={onClose}
          onExpand={handleExpand}
        />
      </div>
    </div>,
    document.body,
  );
}
