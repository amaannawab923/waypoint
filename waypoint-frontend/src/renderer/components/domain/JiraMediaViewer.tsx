import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import {
  fitScale,
  jiraMediaUrl,
  mediaKindOf,
  mediaSubtitle,
  nextZoom,
} from '@/lib/jiraMedia';
import type { JiraAttachment } from '@/types/jira';

/**
 * Full-screen viewer for an issue's attachments, matching what Jira's own
 * media viewer does (observed on a live issue, 2026-09-25): a dark overlay,
 * the filename and `image · 435 B` top-left, download and close top-right,
 * chevrons stepping through every viewable attachment, zoom controls
 * bottom-centre and the zoom percentage bottom-right.
 *
 * Images open FITTED, not at 100%. Jira opens a 3840x2160 capture at 41%,
 * and a viewer that started everything at full size would differ from it on
 * the very first thing anyone tries.
 */
export interface JiraMediaViewerProps {
  /** Every viewable attachment, in the order the strip shows them. */
  items: JiraAttachment[];
  /** Index into `items` to open at. */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Saves the file through main's existing download path. */
  onDownload: (attachment: JiraAttachment) => void;
}

export function JiraMediaViewer({
  items,
  index,
  onIndexChange,
  onClose,
  onDownload,
}: JiraMediaViewerProps) {
  const current = items[index];
  const [zoom, setZoom] = useState<number | null>(null); // null = fit
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  // A new file starts fitted again, and forgets the last one's failure.
  useEffect(() => {
    setZoom(null);
    setNatural({ width: 0, height: 0 });
    setFailed(false);
  }, [current?.id]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitted = fitScale(natural, stage);
  const scale = zoom ?? fitted;

  const step = useCallback(
    (delta: 1 | -1) => {
      if (!items.length) return;
      onIndexChange((index + delta + items.length) % items.length);
    },
    [index, items.length, onIndexChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // The ticket drawer this is rendered inside has its own Escape
        // handler on `document`, gated on focus being within the drawer —
        // which it is, since the viewer lives in that subtree. Without
        // stopping the event here, one Escape closed the viewer AND the
        // drawer behind it. `preventDefault` alone does not do that;
        // stopping immediate propagation on the capture phase does.
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

  // `aria-modal` is a claim about what is reachable, so it has to be made
  // true: focus moves in on open, is kept inside while open, and goes back
  // to whatever opened the viewer on close. The drawer next door already
  // does this; without it Tab walked straight out into the page behind.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, video, audio, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // Recovery first, and this is what makes the trap hold rather than
      // merely handle the states it enumerates: the focusable set changes
      // under the user — the zoom footer only exists for a loaded image,
      // Download only when the attachment has an id — so stepping to a
      // video, or an image failing to load, can unmount the very button
      // that had focus. Focus then falls to <body>, which matches neither
      // end, every branch below is skipped, and Tab walks into the drawer
      // behind. Pulling focus back whenever it is outside the panel is
      // self-healing whatever unmounted.
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
  const kind = mediaKindOf(current);
  const src = current.id ? jiraMediaUrl(current.id) : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${current.fileName}, attachment ${index + 1} of ${items.length}`}
      // Near-solid, not translucent: at 98% the app behind still read
      // through and the image sat on top of the ticket page (seen live).
      ref={panelRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-[rgb(23,25,28)] outline-none"
      // A click on the backdrop closes, the way Jira's does — but a click
      // inside the media must not, or dragging a zoomed image off its edge
      // would dismiss the viewer.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 py-3 text-white">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">
            {current.fileName}
          </div>
          <div className="truncate text-[11.5px] text-white/60">
            {mediaSubtitle(current)}
          </div>
        </div>
        {current.id && (
          <button
            type="button"
            aria-label={`Download ${current.fileName}`}
            title="Download"
            className="rounded p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => onDownload(current)}
          >
            <Download size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label="Close viewer"
          title="Close"
          className="rounded p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto">
        {items.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous attachment"
              className="absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white shadow-lg ring-1 ring-white/20 hover:bg-black/75"
              onClick={() => step(-1)}
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next attachment"
              className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white shadow-lg ring-1 ring-white/20 hover:bg-black/75"
              onClick={() => step(1)}
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </>
        )}

        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          {failed ? (
            // Jira shows a red placeholder for a file it cannot render —
            // a 435 B transparent PNG does it there too. Saying so is
            // parity, not a shortfall.
            <p className="text-[12.5px] text-white/70">
              This file could not be previewed. Download it to open it.
            </p>
          ) : kind === 'image' ? (
            <img
              src={src}
              alt={current.fileName}
              onLoad={(e) =>
                setNatural({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
              style={
                natural.width
                  ? {
                      width: natural.width * scale,
                      height: natural.height * scale,
                      maxWidth: 'none',
                    }
                  : undefined
              }
            />
          ) : kind === 'video' ? (
            // controls + preload="metadata": the protocol answers range
            // requests, so scrubbing works without pulling the whole file.
            <video
              src={src}
              controls
              preload="metadata"
              onError={() => setFailed(true)}
              className="max-h-full max-w-full"
            />
          ) : kind === 'audio' ? (
            <audio src={src} controls onError={() => setFailed(true)} />
          ) : null}
        </div>
      </div>

      {kind === 'image' && !failed && (
        <footer className="flex shrink-0 items-center px-4 py-3 text-white">
          <div className="flex flex-1 items-center justify-center gap-2">
            <button
              type="button"
              aria-label="Zoom out"
              className="rounded-full bg-white/10 p-1.5 text-white/80 hover:bg-white/20 hover:text-white"
              onClick={() => setZoom(nextZoom(scale, -1))}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              className="rounded-full bg-white/10 p-1.5 text-white/80 hover:bg-white/20 hover:text-white"
              onClick={() => setZoom(nextZoom(scale, 1))}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          <span
            className="w-16 text-right text-[11.5px] tabular-nums text-white/70"
            // The figure Jira shows bottom-right; 41% for a 4K capture is
            // how you tell at a glance that it opened fitted.
            data-testid="jira-media-zoom"
          >
            {Math.round(scale * 100)} %
          </span>
        </footer>
      )}
    </div>
  );
}
