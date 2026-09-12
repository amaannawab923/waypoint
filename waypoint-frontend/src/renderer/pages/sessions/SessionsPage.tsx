import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { IconBot, IconPlus, IconXCircle } from '@/components/icons';
import { NewSessionDialog } from '@/components/sessions/NewSessionDialog';
import { SessionDetail } from '@/components/sessions/SessionDetail';
import { SessionList } from '@/components/sessions/SessionList';
import { useMySessions, useSessionRun } from '@/lib/sessionsStore';
import type { EngineStatus } from '@/types/engine';

/** Below this window width the list and the detail take turns (§1.7). */
export const NARROW_MAX_PX = 1099;

function useNarrow(): boolean {
  const query = `(max-width: ${NARROW_MAX_PX}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

/** "The engine isn't running" and "no sessions yet" are different claims; only one is shown, and only when true. */
function engineSentence(engine: EngineStatus | undefined): string | null {
  if (!engine) return null;
  switch (engine.kind) {
    case 'running':
    case 'starting':
    case 'stopping':
      return null;
    case 'not-installed':
      return 'The agent engine is not installed.';
    case 'stopped':
      return 'The agent engine is not running.';
    case 'failed':
      return `The agent engine failed: ${engine.message}`;
    default:
      return null;
  }
}

/** Opens the New session dialog (W4, docs/design/w4-start-session.md §1.1). */
function NewSessionButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="xs" variant="primary" onClick={onClick}>
      <IconPlus size={12} />
      New session
    </Button>
  );
}

/** The `n` key means New session only here, and never while typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    el?.tagName === 'INPUT' ||
    el?.tagName === 'TEXTAREA' ||
    el?.tagName === 'SELECT' ||
    !!el?.isContentEditable ||
    !!el?.closest?.('[data-shortcut-guard]')
  );
}

/**
 * My sessions (W3, ROAD-58): the 300 px list of the user's runs beside the
 * open run's detail — inside the rail the shell folds the sidebar to
 * (docs/design/w3-sessions-rail.md §1). Under 1100 px the two take turns:
 * the list fills the width until a run is opened, the detail takes over
 * with a back chevron, `Esc` returns to the list. Routes: `/sessions` and
 * `/sessions/:runId`.
 */
export default function SessionsPage() {
  const { runId } = useParams<{ runId?: string }>();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const { groups, runs, loaded, loading, error, engine, refresh } =
    useMySessions();
  // Asks the store to re-read when the id is one it has not seen — the
  // ticket page's "Open session →" can land here inside the poll window
  // (found in review: "No such session" flashed until the next read).
  const selected = useSessionRun(runId);
  const open = useCallback(
    (id: string) => navigate(`/sessions/${encodeURIComponent(id)}`),
    [navigate],
  );
  const back = useCallback(() => navigate('/sessions'), [navigate]);
  const [newOpen, setNewOpen] = useState(false);
  const openNew = useCallback(() => setNewOpen(true), []);
  const closeNew = useCallback(() => setNewOpen(false), []);

  // `n` opens the dialog — page-local, with the same typing guard the
  // global shortcuts use (ROAD-111's first half); modifiers excluded so
  // ⌘N stays whatever the OS makes of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (newOpen || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setNewOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newOpen]);

  // Narrow, with a session open: Esc goes back to the list (§1.7). Left to
  // the list/detail otherwise — Esc has other owners (drawers, the composer).
  useEffect(() => {
    if (!narrow || !runId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== 'Escape') return;
      if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, runId, back]);

  const showList = !narrow || !runId;
  const showDetail = !narrow || !!runId;
  const engineDown = engineSentence(engine);

  let listBody: ReactNode = null;
  if (error && runs.length === 0) {
    listBody = (
      <EmptyState
        icon={<IconXCircle size={28} />}
        title="Sessions could not be read"
        description={error}
        action={
          <Button size="xs" onClick={() => refresh()}>
            Try again
          </Button>
        }
      />
    );
  } else if (loaded && runs.length === 0) {
    listBody = (
      <EmptyState
        icon={<IconBot size={28} />}
        title={
          engineDown ? 'The agent engine is not running' : 'No sessions yet'
        }
        description={
          engineDown
            ? `${engineDown} Start it from This machine to run agents here.`
            : 'Sessions you start on this machine, and runs Copilot dispatches from a ticket, show up here.'
        }
        action={
          engineDown ? (
            <Button size="xs" onClick={() => navigate('/machine')}>
              Open This machine
            </Button>
          ) : (
            <NewSessionButton onClick={openNew} />
          )
        }
      />
    );
  }

  return (
    <div data-sessions-page className="flex h-full min-h-0">
      {showList &&
        (listBody ? (
          <div
            className="flex h-full shrink-0 flex-col border-r border-border"
            style={{ width: narrow ? '100%' : 300 }}
          >
            {listBody}
          </div>
        ) : (
          <SessionList
            groups={groups}
            selectedRunId={runId ?? null}
            onOpen={open}
            onNew={openNew}
            width={narrow ? '100%' : 300}
          />
        ))}
      {showDetail &&
        (selected ? (
          <SessionDetail
            key={selected.id}
            run={selected}
            narrow={narrow}
            onBack={back}
          />
        ) : runId && loaded && !loading ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <EmptyState
              icon={<IconXCircle size={28} />}
              title="No such session"
              description={`There is no run ${runId} in your sessions.`}
              action={
                <Button size="xs" onClick={back}>
                  Back to sessions
                </Button>
              }
            />
          </div>
        ) : runId ? (
          <div className="flex min-w-0 flex-1 items-center justify-center text-xs text-text-muted">
            Loading…
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <EmptyState
              icon={<IconBot size={28} />}
              title="Select a session, or start one"
              description="Pick anything on the left, or start a new run on a linked repo — you'll watch it live from right here."
              action={<NewSessionButton onClick={openNew} />}
            />
          </div>
        ))}
      <NewSessionDialog open={newOpen} onClose={closeNew} engine={engine} />
    </div>
  );
}
