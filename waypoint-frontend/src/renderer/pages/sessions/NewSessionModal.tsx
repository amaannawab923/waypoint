import { useState } from 'react';
import { clsx } from 'clsx';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SESSION_INTENT_LABEL, type SessionIntent } from './types';

const INTENT_ORDER: SessionIntent[] = ['rca', 'comment', 'follow-up', 'full-coding'];

interface TicketOption {
  id: string;
  identifier: string;
  title: string;
}

export function NewSessionModal({
  open,
  onClose,
  tickets,
  onDispatch,
}: {
  open: boolean;
  onClose: () => void;
  tickets: TicketOption[];
  onDispatch: (input: { ticketId: string; intent: SessionIntent; customInstruction?: string }) => void;
}) {
  const [ticketId, setTicketId] = useState(tickets[0]?.id ?? '');
  const [intent, setIntent] = useState<SessionIntent | null>(null);
  const [customText, setCustomText] = useState('');

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
            {tickets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.identifier} — {t.title}
              </option>
            ))}
          </select>
        </div>

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
