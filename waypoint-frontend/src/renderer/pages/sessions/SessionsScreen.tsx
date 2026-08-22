import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, ChevronLeft, Plus, Search, Send, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar } from '@/components/ui/Avatar';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { IconButton } from '@/components/ui/Button';
import { useAsync } from '@/lib/useAsync';
import { listAllWorkItems } from '@/mock/api';
import { NewSessionModal } from './NewSessionModal';
import { MOCK_SESSIONS } from './mockSessions';
import { ACTIVE_STATUSES, SESSION_INTENT_LABEL, type AgentSession, type SessionIntent } from './types';

const LAST_SESSION_KEY = 'waypoint:lastSessionId';

// A couple of canned acknowledgements so replying inside a session feels
// like a real back-and-forth in this mock, without any real agent behind
// it — see lib/featureFlags.ts.
const MOCK_REPLIES = [
  "Got it — factoring that in now.",
  "Makes sense, updating my approach.",
  "Thanks, that unblocks me — picking this back up.",
];

function nextMockReply(): string {
  return MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
}

function MessageComposer({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState('');

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
  }

  return (
    <div className="flex items-end gap-2 border-t border-border px-8 py-4">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Reply to Ethan…"
        className="thin-scroll max-h-32 min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <IconButton label="Send" onClick={submit} disabled={!value.trim()} className="mb-0.5 disabled:opacity-40">
        <Send size={16} />
      </IconButton>
    </div>
  );
}

/**
 * A genuine full-viewport takeover, not a panel inside AppShell — see
 * router.tsx, where /sessions is a sibling of the AppShell-wrapped tree, not
 * nested under it. The normal sidebar/topbar never render here; "Back to
 * Waypoint" is the only way in or out.
 */
export default function SessionsScreen() {
  const navigate = useNavigate();
  const { data: workItems } = useAsync(() => listAllWorkItems(), []);
  const [sessions, setSessions] = useState<AgentSession[]>(MOCK_SESSIONS);
  const [selectedId, setSelectedId] = useState<string>(
    () => localStorage.getItem(LAST_SESSION_KEY) ?? MOCK_SESSIONS[0]?.id ?? '',
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Only matters below the lg breakpoint — see the rail/detail classNames below.
  const [mobileView, setMobileView] = useState<'rail' | 'detail'>('detail');

  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.workItemIdentifier.toLowerCase().includes(q) || s.workItemTitle.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const tickets = useMemo(
    () => (workItems ?? []).map((w) => ({ id: w.id, identifier: w.identifier, title: w.title })),
    [workItems],
  );

  // Selecting a session that no longer exists (e.g. it was dismissed in
  // another tab) falls back to the first one rather than showing nothing.
  useEffect(() => {
    if (selected || sessions.length === 0) return;
    setSelectedId(sessions[0].id);
  }, [selected, sessions]);

  function selectSession(id: string) {
    setSelectedId(id);
    localStorage.setItem(LAST_SESSION_KEY, id);
    setMobileView('detail');
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unread: false } : s)));
  }

  function handleReply(text: string) {
    if (!selected) return;
    const now = new Date().toISOString();
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== selected.id) return s;
        return {
          ...s,
          updatedAt: now,
          messages: [...s.messages, { id: `m-${Date.now()}`, role: 'user', text, createdAt: now }],
        };
      }),
    );
    // Simulate a reply — a blocked session unblocks once you answer it,
    // matching the exact case QA flagged (LAUNCH-7 waiting on a decision).
    window.setTimeout(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== selected.id) return s;
          const replyAt = new Date().toISOString();
          return {
            ...s,
            status: s.status === 'blocked' ? 'running' : s.status,
            updatedAt: replyAt,
            messages: [...s.messages, { id: `m-${Date.now()}-r`, role: 'agent', text: nextMockReply(), createdAt: replyAt }],
          };
        }),
      );
    }, 1200);
  }

  function dismissSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  function handleDispatch(input: { ticketId: string; intent: SessionIntent; customInstruction?: string }) {
    const ticket = tickets.find((t) => t.id === input.ticketId);
    if (!ticket) return;
    const now = new Date().toISOString();
    const instructionText =
      input.intent === 'custom' ? (input.customInstruction ?? '') : SESSION_INTENT_LABEL[input.intent];
    const session: AgentSession = {
      id: `session-${Date.now()}`,
      workItemId: ticket.id,
      workItemIdentifier: ticket.identifier,
      workItemTitle: ticket.title,
      projectId: 'proj-launch',
      projectName: 'Product Launch',
      agentId: 'agent-ethan',
      agentName: 'Ethan',
      agentAvatarColor: '#2f6fa8',
      intent: input.intent,
      customInstruction: input.customInstruction,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      unread: false,
      messages: [{ id: 'm1', role: 'user', text: instructionText, createdAt: now }],
    };
    setSessions((prev) => [session, ...prev]);
    selectSession(session.id);
    setNewSessionOpen(false);
  }

  const activeSessionForNewDispatch = (ticketId: string) =>
    sessions.find((s) => s.workItemId === ticketId && ACTIVE_STATUSES.includes(s.status)) ?? null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* Session rail */}
      <div
        className={clsx(
          'w-full shrink-0 flex-col border-r border-border lg:flex lg:w-[300px]',
          mobileView === 'rail' ? 'flex' : 'hidden',
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3.5">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text"
          >
            <ArrowLeft size={15} />
            Back to Waypoint
          </button>
        </div>

        <button
          type="button"
          onClick={() => setNewSessionOpen(true)}
          className="mx-3 mt-3 flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-border-strong px-3 text-sm text-text-secondary hover:border-accent hover:text-text"
        >
          <Plus size={14} />
          New session
        </button>

        <div className="mx-3 mt-2 flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-2.5">
          <Search size={13} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
          />
        </div>

        <div className="thin-scroll mt-2 flex-1 overflow-y-auto px-2 pb-3">
          {filteredSessions.length === 0 && (
            <p className="mt-6 px-2 text-center text-sm text-text-muted">No sessions match "{query}".</p>
          )}
          {filteredSessions.map((session) => (
            // A <div role="button">, not a real <button> — the dismiss
            // control inside it is a real <button>, and <button> cannot
            // nest inside <button> (invalid HTML, breaks click targeting
            // and screen readers — see States.tsx's own history with this
            // exact mistake). onKeyDown below gives it the same Enter/Space
            // activation a real button gets natively.
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => selectSession(session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectSession(session.id);
                }
              }}
              className={clsx(
                'group mt-1 flex w-full cursor-pointer flex-col gap-1.5 rounded-[var(--radius-sm)] px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                session.id === selectedId ? 'bg-accent-soft-bg' : 'hover:bg-surface-2',
              )}
            >
              <div className="flex items-center gap-2">
                {session.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                <Avatar name={session.agentName} color={session.agentAvatarColor} shape="square" size={18} />
                <span
                  className={clsx(
                    'min-w-0 flex-1 truncate text-xs',
                    session.unread ? 'font-semibold text-text' : 'font-medium text-text-muted',
                  )}
                >
                  {session.workItemIdentifier}
                </span>
                <AgentStatusBadge status={session.status} />
                <button
                  type="button"
                  onClick={(e) => dismissSession(session.id, e)}
                  aria-label="Dismiss session"
                  className="ml-1 flex size-4 shrink-0 items-center justify-center rounded text-text-muted opacity-0 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
              <p className={clsx('truncate text-sm', session.unread ? 'font-medium text-text' : 'text-text')}>
                {session.workItemTitle}
              </p>
              <p className="text-xs text-text-muted">
                {SESSION_INTENT_LABEL[session.intent]} · {formatDistanceToNow(new Date(session.updatedAt))} ago
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Selected session detail */}
      <div className={clsx('min-w-0 flex-1 flex-col lg:flex', mobileView === 'detail' ? 'flex' : 'hidden')}>
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-8 py-5">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMobileView('rail')}
                  aria-label="Back to sessions"
                  className="-ml-1 flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-surface-2 hover:text-text lg:hidden"
                >
                  <ChevronLeft size={16} />
                </button>
                <Avatar name={selected.agentName} color={selected.agentAvatarColor} shape="square" size={32} />
                <div>
                  <h1 className="font-display text-base font-medium text-text">
                    {selected.agentName}{' '}
                    <span className="font-normal text-text-muted">on {selected.workItemIdentifier}</span>
                  </h1>
                  <p className="text-sm text-text-secondary">{selected.workItemTitle}</p>
                </div>
              </div>
              <AgentStatusBadge status={selected.status} />
            </div>

            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-8 py-6">
              <div className="mx-auto flex max-w-2xl flex-col gap-5">
                {selected.messages.map((message) => (
                  <div
                    key={message.id}
                    className={clsx('flex flex-col gap-1.5', message.role === 'user' ? 'items-end' : 'items-start')}
                  >
                    <div
                      className={clsx(
                        'max-w-[85%] rounded-[var(--radius)] px-4 py-3 text-sm leading-relaxed',
                        message.role === 'user'
                          ? 'bg-accent text-on-accent'
                          : 'border border-border bg-surface text-text',
                      )}
                    >
                      {message.text}
                    </div>
                    <span className="px-1 text-xs text-text-muted">
                      {formatDistanceToNow(new Date(message.createdAt))} ago
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mx-auto w-full max-w-2xl">
              <MessageComposer onSend={handleReply} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            No sessions yet — start one with "New session."
          </div>
        )}
      </div>

      <NewSessionModal
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        tickets={tickets}
        onDispatch={handleDispatch}
        findActiveSession={activeSessionForNewDispatch}
        onJumpToSession={(id) => {
          selectSession(id);
          setNewSessionOpen(false);
        }}
      />
    </div>
  );
}
