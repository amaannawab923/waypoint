import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import { SESSION_INTENT_LABEL, type AgentSession, type SessionIntent } from './types';

const INTENT_ORDER: SessionIntent[] = ['rca', 'comment', 'follow-up', 'full-coding'];

interface TicketOption {
  id: string;
  identifier: string;
  title: string;
  projectId: string;
  projectName: string;
}

export function NewSessionModal({
  open,
  onClose,
  tickets,
  onDispatch,
  findActiveSession,
  onJumpToSession,
}: {
  open: boolean;
  onClose: () => void;
  tickets: TicketOption[];
  onDispatch: (input: { ticketId: string; intent: SessionIntent; customInstruction?: string }) => void;
  /** An already-active session on the given ticket, if one exists — used to
   * warn before silently spawning an indistinguishable duplicate. */
  findActiveSession: (ticketId: string) => AgentSession | null;
  onJumpToSession: (sessionId: string) => void;
}) {
  const [ticketId, setTicketId] = useState('');
  const [intent, setIntent] = useState<SessionIntent | null>(null);
  const [customText, setCustomText] = useState('');

  // `tickets` arrives pre-sorted by project name — grouping the already-
  // sorted list preserves that order rather than re-sorting project names
  // in insertion order. Round-2 QA: 19 tickets across two projects in one
  // flat, ungrouped list was hard to scan.
  const groupedTickets = useMemo(() => {
    const groups: { projectName: string; tickets: TicketOption[] }[] = [];
    for (const ticket of tickets) {
      const last = groups[groups.length - 1];
      if (last && last.projectName === ticket.projectName) last.tickets.push(ticket);
      else groups.push({ projectName: ticket.projectName, tickets: [ticket] });
    }
    return groups;
  }, [tickets]);

  // Tickets load async (real work-items API) — default to the first one
  // once they arrive, but don't fight a selection the user already made.
  useEffect(() => {
    if (ticketId || tickets.length === 0) return;
    setTicketId(tickets[0].id);
  }, [tickets, ticketId]);

  function reset() {
    setTicketId(tickets[0]?.id ?? '');
    setIntent(null);
    setCustomText('');
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleDispatch() {
    if (!ticketId) return;
    if (intent === 'custom') {
      if (!customText.trim()) return;
      onDispatch({ ticketId, intent: 'custom', customInstruction: customText.trim() });
    } else if (intent) {
      onDispatch({ ticketId, intent });
    } else {
      return;
    }
    reset();
  }

  const canDispatch = Boolean(ticketId) && (intent === 'custom' ? customText.trim().length > 0 : intent !== null);
  const activeSession = ticketId ? findActiveSession(ticketId) : null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New session"
      width={440}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!canDispatch} onClick={handleDispatch}>
            Dispatch
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">Ticket</label>
          <select
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          >
            {tickets.length === 0 && <option value="">Loading tickets…</option>}
            {groupedTickets.map((group) => (
              <optgroup key={group.projectName} label={group.projectName}>
                {group.tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.identifier} — {t.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {activeSession && (
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-warning-bg bg-warning-bg px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-xs text-text">
              <AgentStatusBadge status={activeSession.status} />
              <span className="truncate">
                Ethan already has an active session on this ticket ({SESSION_INTENT_LABEL[activeSession.intent]}).
              </span>
            </div>
            <button
              type="button"
              onClick={() => onJumpToSession(activeSession.id)}
              className="shrink-0 text-xs font-medium text-accent-soft-text underline hover:no-underline"
            >
              View it
            </button>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">What should Ethan do?</label>
          <div className="flex flex-col gap-1.5">
            {INTENT_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setIntent(key)}
                className={clsx(
                  'flex items-center rounded-[var(--radius-sm)] border px-3 py-2 text-left text-sm transition-colors',
                  intent === key
                    ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                    : 'border-border-strong text-text hover:bg-surface-2',
                )}
              >
                {SESSION_INTENT_LABEL[key]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setIntent('custom')}
              className={clsx(
                'flex items-center rounded-[var(--radius-sm)] border px-3 py-2 text-left text-sm transition-colors',
                intent === 'custom'
                  ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                  : 'border-border-strong text-text hover:bg-surface-2',
              )}
            >
              Something else…
            </button>
          </div>
        </div>

        {intent === 'custom' && (
          <textarea
            autoFocus
            rows={3}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Tell Ethan exactly what you need done on this ticket…"
            className="thin-scroll rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        )}

        <p className="text-xs text-text-muted">
          Only visible to you — nothing about this session appears on the ticket for anyone else.
        </p>
      </div>
    </Modal>
  );
}
