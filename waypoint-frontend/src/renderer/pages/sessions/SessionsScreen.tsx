import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Plus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar } from '@/components/ui/Avatar';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { NewSessionModal } from './NewSessionModal';
import { MOCK_SESSIONS } from './mockSessions';
import { SESSION_INTENT_LABEL, type AgentSession, type SessionIntent } from './types';

// A fixed ticket picker for the New Session flow — this is a mock frontend,
// not wired to the real work-items API yet (see lib/featureFlags.ts).
const MOCK_TICKETS = MOCK_SESSIONS.map((s) => ({
  id: s.workItemId,
  identifier: s.workItemIdentifier,
  title: s.workItemTitle,
}));

/**
 * A genuine full-viewport takeover, not a panel inside AppShell — see
 * router.tsx, where /sessions is a sibling of the AppShell-wrapped tree, not
 * nested under it. The normal sidebar/topbar never render here; "Back to
 * Waypoint" is the only way in or out.
 */
export default function SessionsScreen() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AgentSession[]>(MOCK_SESSIONS);
  const [selectedId, setSelectedId] = useState<string>(MOCK_SESSIONS[0]?.id ?? '');
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);

  function handleDispatch(input: { ticketId: string; intent: SessionIntent; customInstruction?: string }) {
    const ticket = MOCK_TICKETS.find((t) => t.id === input.ticketId);
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
      messages: [{ id: 'm1', role: 'user', text: instructionText, createdAt: now }],
    };
    setSessions((prev) => [session, ...prev]);
    setSelectedId(session.id);
    setNewSessionOpen(false);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* Session rail */}
      <div className="flex w-[300px] shrink-0 flex-col border-r border-border">
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

        <div className="thin-scroll mt-2 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setSelectedId(session.id)}
              className={clsx(
                'mt-1 flex w-full flex-col gap-1.5 rounded-[var(--radius-sm)] px-3 py-2.5 text-left transition-colors',
                session.id === selectedId ? 'bg-accent-soft-bg' : 'hover:bg-surface-2',
              )}
            >
              <div className="flex items-center gap-2">
                <Avatar name={session.agentName} color={session.agentAvatarColor} shape="square" size={18} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-muted">
                  {session.workItemIdentifier}
                </span>
                <AgentStatusBadge status={session.status} />
              </div>
              <p className="truncate text-sm text-text">{session.workItemTitle}</p>
              <p className="text-xs text-text-muted">
                {SESSION_INTENT_LABEL[session.intent]} · {formatDistanceToNow(new Date(session.updatedAt))} ago
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Selected session detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-8 py-5">
              <div className="flex items-center gap-3">
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
        tickets={MOCK_TICKETS}
        onDispatch={handleDispatch}
      />
    </div>
  );
}
