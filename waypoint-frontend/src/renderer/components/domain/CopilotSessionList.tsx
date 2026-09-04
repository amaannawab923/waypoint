import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { GripVertical, MoreHorizontal, Trash2 } from 'lucide-react';
import { IconEdit, IconPin, IconPlus } from '@/components/icons';
import {
  formatRelativeTime,
  groupKeyForSession,
  groupSessions,
  lastMessagePreview,
  type CopilotSession,
  type CopilotSessionGroupKey,
} from '@/lib/copilotSessions';

interface MenuState {
  sessionId: string;
  x: number;
  y: number;
}

interface CopilotSessionListProps {
  sessions: CopilotSession[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (
    sourceId: string,
    targetId: string,
    group: CopilotSessionGroupKey,
  ) => void;
}

/**
 * Right-click ANYWHERE on a row opens the same options menu the "⋯" button
 * does — a real custom contextmenu handler (matching the approved mockup),
 * not the browser's own default menu.
 */
function SessionContextMenu({
  session,
  x,
  y,
  onClose,
  onRename,
  onTogglePin,
  onDelete,
}: {
  session: CopilotSession;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    // Clamped to the viewport the same way the approved mockup does, so a
    // row near the panel's bottom/right edge doesn't open a menu that runs
    // off-screen.
    const rect = menuRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 180;
    const height = rect?.height ?? 120;
    setPosition({
      left: Math.min(x, window.innerWidth - width - 12),
      top: Math.min(y, window.innerHeight - height - 12),
    });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: position.left, top: position.top }}
      className="fixed z-50 min-w-[168px] rounded-[var(--radius-sm)] border border-border bg-surface p-1.5 text-sm shadow-lg"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-text hover:bg-surface-2"
      >
        <IconEdit size={14} />
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onTogglePin}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-text hover:bg-surface-2"
      >
        <IconPin
          size={14}
          className={session.pinned ? 'fill-current' : undefined}
        />
        {session.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      <hr className="my-1 border-border" />
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-danger hover:bg-danger-bg"
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>,
    document.body,
  );
}

function SessionRow({
  session,
  isEditing,
  isConfirmingDelete,
  isDragging,
  isDropTarget,
  onOpen,
  onCommitRename,
  onCancelRename,
  onTogglePin,
  onOpenMenu,
  onCancelDelete,
  onConfirmDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  session: CopilotSession;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onOpen: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onTogglePin: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  if (isConfirmingDelete) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] py-2 pr-2 pl-3 text-xs">
        <span className="text-text-secondary">Delete “{session.title}”?</span>
        <span className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onCancelDelete}
            className="cursor-pointer rounded-[var(--radius-sm)] border border-border-strong bg-surface px-2.5 py-1 font-medium text-text hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirmDelete}
            className="cursor-pointer rounded-[var(--radius-sm)] border border-danger bg-danger px-2.5 py-1 font-medium text-white hover:brightness-110"
          >
            Delete
          </button>
        </span>
      </div>
    );
  }

  const preview = lastMessagePreview(session);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={() => {
        if (!isEditing) onOpen();
      }}
      onKeyDown={(e) => {
        if (!isEditing && (e.key === 'Enter' || e.key === ' ')) onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(e.clientX, e.clientY);
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={clsx(
        'group relative flex cursor-pointer items-start gap-1.5 rounded-[var(--radius-sm)] py-2 pr-2 pl-1 select-none hover:bg-surface-2',
        isDragging && 'opacity-40',
        isDropTarget && 'border-t-2 border-t-accent',
      )}
    >
      <span className="flex h-8 w-3.5 shrink-0 cursor-grab items-center justify-center text-text-muted opacity-0 group-hover:opacity-100">
        <GripVertical size={12} />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              defaultValue={session.title}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename(e.currentTarget.value);
                if (e.key === 'Escape') onCancelRename();
              }}
              onBlur={(e) => onCommitRename(e.currentTarget.value)}
              className="w-full rounded border border-accent bg-surface px-1 py-0.5 text-[13.5px] font-medium text-text outline-none"
            />
          ) : (
            <span className="truncate text-[13.5px] font-medium text-text">
              {session.title}
            </span>
          )}
          {!isEditing && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">
              {formatRelativeTime(session.updatedAt)}
            </span>
          )}
        </div>
        {!isEditing && (
          <div className="truncate text-xs text-text-muted">
            {/* preview is only available once a session's messages have
                been fetched (see useCopilotConversations.ts's openSession)
                — the list endpoint doesn't include them, so a session that
                simply hasn't been opened yet reads identically to a
                genuinely empty new one. "Tap to open" covers both honestly,
                instead of "No messages yet" claiming knowledge this row
                doesn't actually have for an unopened session with real
                history. */}
            {preview ?? 'Tap to open'}
          </div>
        )}
      </div>

      <div
        className={clsx(
          'flex shrink-0 items-start opacity-0 group-hover:opacity-100',
          session.pinned && 'opacity-100',
        )}
      >
        <button
          type="button"
          aria-label={session.pinned ? 'Unpin' : 'Pin'}
          title={session.pinned ? 'Unpin' : 'Pin'}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className={clsx(
            'inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] hover:bg-surface-3',
            session.pinned ? 'text-text' : 'text-text-secondary',
          )}
        >
          <IconPin
            size={14}
            className={session.pinned ? 'fill-current' : undefined}
          />
        </button>
        <button
          type="button"
          aria-label="More options"
          title="More"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.right, rect.bottom + 4);
          }}
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-surface-3"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * The session-list view of the Copilot panel: a "New session" CTA, a Pinned
 * group (when any session is pinned), then Today / Yesterday / Last 7 days /
 * Older buckets by recency. Split out of CopilotPanel.tsx once the list
 * gained its own rename/pin/delete/drag-reorder/context-menu interactions —
 * CopilotPanel.tsx owns session data and the chat view; this owns only how
 * that data is browsed and organized.
 */
export function CopilotSessionList({
  sessions,
  onOpen,
  onCreate,
  onRename,
  onTogglePin,
  onDelete,
  onReorder,
}: CopilotSessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const groups = groupSessions(sessions);
  const draggingSession = sessions.find((s) => s.id === dragId) ?? null;
  const menuSession = menu
    ? (sessions.find((s) => s.id === menu.sessionId) ?? null)
    : null;

  function commitRename(id: string, value: string) {
    const trimmed = value.trim();
    if (trimmed) onRename(id, trimmed);
    setEditingId(null);
  }

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3.5">
      <button
        type="button"
        onClick={onCreate}
        className="mx-1 mt-1 mb-1 flex w-[calc(100%-8px)] cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-dashed border-border-strong px-2.5 py-2 text-sm text-text-secondary hover:border-text-muted hover:bg-surface-2 hover:text-text"
      >
        <IconPlus size={14} />
        New session
      </button>

      {sessions.length === 0 && (
        <p className="mt-8 text-center text-sm text-text-muted">
          No sessions yet — start one above.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.key}>
          <div className="flex items-center gap-1.5 px-1.5 pt-3.5 pb-1.5 font-mono text-[10.5px] tracking-wider text-text-muted uppercase first:pt-1">
            {group.key === 'pinned' && (
              <IconPin size={11} className="fill-current" />
            )}
            {group.label}
          </div>
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isEditing={editingId === session.id}
              isConfirmingDelete={confirmingId === session.id}
              isDragging={dragId === session.id}
              isDropTarget={dropTargetId === session.id}
              onOpen={() => onOpen(session.id)}
              onCommitRename={(title) => commitRename(session.id, title)}
              onCancelRename={() => setEditingId(null)}
              onTogglePin={() => onTogglePin(session.id)}
              onOpenMenu={(x, y) => setMenu({ sessionId: session.id, x, y })}
              onCancelDelete={() => setConfirmingId(null)}
              onConfirmDelete={() => {
                onDelete(session.id);
                setConfirmingId(null);
              }}
              onDragStart={() => setDragId(session.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropTargetId(null);
              }}
              onDragOver={(e) => {
                // Cross-group drags are a no-op (see copilotSessions.ts's
                // reorderSessionsWithinGroup) — not showing a drop
                // indicator for one keeps the affordance honest about what
                // will actually happen on drop.
                if (!draggingSession || draggingSession.id === session.id)
                  return;
                if (groupKeyForSession(draggingSession) !== group.key) return;
                e.preventDefault();
                setDropTargetId(session.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                // Not relying solely on onDragOver's preventDefault to gate
                // this (that only stops a *real* browser from firing drop
                // at all) — checked again explicitly here so a cross-group
                // drop is a guaranteed no-op regardless of how the drop was
                // triggered.
                if (
                  dragId &&
                  draggingSession &&
                  groupKeyForSession(draggingSession) === group.key
                ) {
                  onReorder(dragId, session.id, group.key);
                }
                setDragId(null);
                setDropTargetId(null);
              }}
            />
          ))}
        </div>
      ))}

      {menu && menuSession && (
        <SessionContextMenu
          session={menuSession}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setMenu(null);
            setEditingId(menuSession.id);
          }}
          onTogglePin={() => {
            setMenu(null);
            onTogglePin(menuSession.id);
          }}
          onDelete={() => {
            setMenu(null);
            setConfirmingId(menuSession.id);
          }}
        />
      )}
    </div>
  );
}
