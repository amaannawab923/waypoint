import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { IconAlert, IconPlus } from '@/components/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import type { SessionGroups } from '@/lib/sessionsStore';
import type { AgentRun } from '@/types/agentRuns';
import { SessionRow } from './SessionRow';

const GROUP_LABELS: Record<keyof SessionGroups, string> = {
  waiting: 'Waiting on you',
  active: 'Active',
  done: 'Done',
};

/**
 * The 300 px session list (W3, docs/design/w3-sessions-rail.md §1.4): the
 * three groups in their fixed order, each row a SessionRow. One listbox
 * with a roving cursor — ↑/↓ move it, Enter (or Space) opens the run under
 * it, Home/End jump — so the whole list is reachable without a mouse
 * (ROAD-65's "keyboard reachability from the start").
 */
export function SessionList({
  groups,
  selectedRunId,
  onOpen,
  onNew,
  width = 300,
}: {
  groups: SessionGroups;
  selectedRunId: string | null;
  onOpen: (runId: string) => void;
  /** The header's "+" (W4): opens the New session dialog. */
  onNew: () => void;
  /** Fixed at 300 beside the rail; the narrow layout hands it the whole width. */
  width?: number | '100%';
}) {
  const ordered = useMemo<AgentRun[]>(
    () => [...groups.waiting, ...groups.active, ...groups.done],
    [groups],
  );
  const [cursor, setCursor] = useState<string | null>(selectedRunId);
  const boxRef = useRef<HTMLDivElement>(null);

  // The cursor follows the selection (a route change, a click) and never
  // points at a row that is gone.
  useEffect(() => {
    if (selectedRunId) setCursor(selectedRunId);
  }, [selectedRunId]);
  useEffect(() => {
    if (cursor && !ordered.some((run) => run.id === cursor))
      setCursor(ordered[0]?.id ?? null);
  }, [cursor, ordered]);

  const move = (delta: number) => {
    if (ordered.length === 0) return;
    const index = ordered.findIndex((run) => run.id === cursor);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : ordered.length - 1
        : Math.min(ordered.length - 1, Math.max(0, index + delta));
    const { id } = ordered[next];
    setCursor(id);
    // jsdom has no scrollIntoView; a browser always does.
    const row = boxRef.current?.querySelector<HTMLElement>(
      `[data-run-id="${id}"]`,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        move(-ordered.length);
        break;
      case 'End':
        e.preventDefault();
        move(ordered.length);
        break;
      case 'Enter':
      case ' ':
        if (cursor) {
          e.preventDefault();
          onOpen(cursor);
        }
        break;
      default:
    }
  };

  return (
    <div
      data-session-list
      className="flex h-full shrink-0 flex-col border-r border-border bg-bg"
      style={{ width }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-2">
        <h2 className="font-display text-xs font-semibold text-text">
          My sessions
        </h2>
        <Tooltip label="New session · n">
          <button
            type="button"
            aria-label="New session"
            onClick={onNew}
            className="flex size-5 items-center justify-center rounded-[5px] border border-border-strong text-text-secondary hover:bg-surface-2 hover:text-text"
          >
            <IconPlus size={11} />
          </button>
        </Tooltip>
      </div>
      <div
        ref={boxRef}
        role="listbox"
        aria-label="Sessions"
        aria-activedescendant={cursor ? `session-row-${cursor}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="thin-scroll min-h-0 flex-1 overflow-y-auto pb-2 outline-none focus-visible:ring-1 focus-visible:ring-border-strong focus-visible:ring-inset"
      >
        {(['waiting', 'active', 'done'] as const).map((key) => {
          const runs = groups[key];
          if (runs.length === 0) return null;
          return (
            <div key={key} role="group" aria-label={GROUP_LABELS[key]}>
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 font-mono text-[9px] tracking-[0.07em] text-text-muted uppercase">
                {key === 'waiting' && <IconAlert size={9} />}
                {GROUP_LABELS[key]} · {runs.length}
              </div>
              {runs.map((run) => (
                <SessionRow
                  key={run.id}
                  run={run}
                  selected={run.id === selectedRunId}
                  focused={run.id === cursor && run.id !== selectedRunId}
                  onOpen={onOpen}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
