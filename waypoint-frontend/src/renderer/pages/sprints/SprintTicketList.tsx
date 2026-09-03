import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Member, Ticket, TicketState } from '@/types/entities';
import { StateIcon, STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { PriorityIcon } from '@/components/domain/PriorityIcon';
import { AvatarStack } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { ListChecks, Plus, Search } from 'lucide-react';
import { updateTicket } from '@/data/api';

/**
 * Searchable picker for assigning an existing, not-yet-in-this-sprint project ticket to the
 * current sprint. Mirrors the modal-based picker pattern used elsewhere in the app (e.g.
 * src/pages/project-settings/Estimates.tsx's EstimatePickerModal).
 */
function AddTicketModal({
  open,
  onClose,
  candidates,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  candidates: Ticket[];
  onAdd: (item: Ticket) => void;
}) {
  const [query, setQuery] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (i) => i.title.toLowerCase().includes(q) || i.identifier.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  async function handlePick(item: Ticket) {
    if (addingId) return;
    setAddingId(item.id);
    try {
      await onAdd(item);
    } finally {
      setAddingId(null);
    }
  }

  function handleClose() {
    setQuery('');
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add ticket to sprint">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tickets…"
            className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="thin-scroll max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-text-muted">
              {candidates.length === 0 ? 'No unassigned tickets in this project.' : 'No matches.'}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={addingId === item.id}
                  onClick={() => handlePick(item)}
                  className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left text-sm text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  <PriorityIcon priority={item.priority} size={13} />
                  <span className="shrink-0 font-mono text-xs text-text-muted">{item.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Lightweight grouped-by-state ticket list for a single, already-known sprintId.
 * Intentionally simpler than the shared ListView — no filter/sort/group-by controls,
 * since this list only ever shows one fixed sprint's items.
 */
export function SprintTicketList({
  projectId,
  sprintId,
  items,
  allItems,
  states,
  members,
  onItemAdded,
}: {
  projectId: string;
  sprintId: string;
  /** Tickets already assigned to this sprint. */
  items: Ticket[];
  /** Every ticket in the project (unfiltered), used to build the "add ticket" candidate list. */
  allItems: Ticket[];
  states: TicketState[];
  members: Member[];
  /** Called after a ticket is assigned to this sprint so the caller can reload. */
  onItemAdded: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  const candidates = useMemo(() => allItems.filter((i) => i.sprintId !== sprintId), [allItems, sprintId]);

  async function handleAdd(item: Ticket) {
    await updateTicket(item.id, { sprintId });
    setAddOpen(false);
    onItemAdded();
  }

  const memberById = new Map(members.map((m) => [m.id, m]));
  const orderedStates = [...states].sort(
    (a, b) => STATE_GROUP_ORDER.indexOf(a.group) - STATE_GROUP_ORDER.indexOf(b.group) || a.sortOrder - b.sortOrder,
  );

  const groups = orderedStates
    .map((state) => ({ state, items: items.filter((i) => i.stateId === state.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Add ticket
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={28} />}
          title="No tickets in this sprint"
          description="Assign an existing ticket to this sprint, or add one from the tickets list."
          action={
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={14} />
              Add ticket
            </Button>
          }
        />
      ) : (
        groups.map(({ state, items: groupItems }) => (
          <div key={state.id}>
            <div className="mb-2 flex items-center gap-2 px-1">
              <StateIcon state={state} size={14} />
              <span className="text-sm font-medium text-text">{state.name}</span>
              <span className="font-mono text-xs text-text-muted">{groupItems.length}</span>
            </div>
            <div className="overflow-hidden rounded-[var(--radius)] border border-border">
              {groupItems.map((item, i) => {
                const people = item.assigneeIds
                  .map((id) => memberById.get(id))
                  .filter((m): m is Member => !!m)
                  .map((m) => ({ name: m.displayName, color: m.avatarColor }));
                return (
                  <Link
                    key={item.id}
                    to={`/projects/${projectId}/tickets/${item.identifier}`}
                    className={`flex items-center gap-3 bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2 ${i > 0 ? 'border-t border-border' : ''}`}
                  >
                    <span className="shrink-0 font-mono text-xs text-text-muted">{item.identifier}</span>
                    <PriorityIcon priority={item.priority} />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{item.title}</span>
                    {people.length > 0 && <AvatarStack people={people} size={20} />}
                  </Link>
                );
              })}
            </div>
          </div>
        ))
      )}

      <AddTicketModal open={addOpen} onClose={() => setAddOpen(false)} candidates={candidates} onAdd={handleAdd} />
    </div>
  );
}
