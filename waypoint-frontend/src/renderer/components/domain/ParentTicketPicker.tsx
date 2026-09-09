import { useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPanel } from '@/components/ui/useFloatingPanel';
import type { Ticket } from '@/types/entities';

const PANEL_WIDTH = 280;
const PANEL_HEIGHT_ESTIMATE = 280;

/**
 * The "set a parent" menu for CreateTicketModal's new "Parent" field
 * (finding 2a).
 *
 * Structurally modeled on JiraAssigneePicker.tsx — a search input above a
 * portaled, floating options panel, with positioning/click-away/Escape/focus
 * all coming from `useFloatingPanel`. It differs from that precedent in one
 * deliberate way: JiraAssigneePicker owns its own SERVER search (Jira has no
 * bulk "list every assignable user" endpoint worth paging through client
 * side); this picker's whole candidate set is a project's ticket list the
 * caller has almost certainly already fetched (`useTicketsView.ts` does,
 * for `subItemCountByParent`), so it takes that list as a `tickets` prop and
 * filters it in memory as the user types — no debounce, no network,
 * plainly a few hundred rows at most.
 *
 * Only PARENTLESS tickets are offered (`!t.parentId`) — this app's List/Board
 * nesting (finding 2e) and parent chip (finding 2c) are both written for one
 * level of nesting, so this deliberately avoids ever letting the picker
 * create a 3-level chain.
 */
export function ParentTicketPicker({
  tickets,
  value,
  excludeTicketId,
  triggerRef,
  onSelect,
  onClose,
}: {
  /** The project's full ticket list — unfiltered by parent status; this
   * component does the parentless filtering itself. */
  tickets: Ticket[];
  /** The currently selected parent ticket id, or null for "no parent" —
   * drives the "current" marker in the list. */
  value: string | null;
  /** Omit this ticket itself from the option list — relevant once this
   * picker is ever wired into changing an EXISTING ticket's parent, so it
   * can't offer to parent a ticket to itself. Unused by CreateTicketModal
   * (a not-yet-created ticket has no id to exclude). */
  excludeTicketId?: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect: (ticketId: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets
      .filter((t) => !t.parentId)
      .filter((t) => t.id !== excludeTicketId)
      .filter(
        (t) =>
          !q ||
          t.identifier.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q),
      );
  }, [tickets, query, excludeTicketId]);

  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: PANEL_WIDTH,
    estimatedHeight: PANEL_HEIGHT_ESTIMATE,
    label: 'Set parent ticket',
    remeasureOn: [options],
  });

  return createPortal(
    <div
      // Applied one by one, not spread — see JiraAssigneePicker's identical
      // comment: this codebase forbids prop spreading
      // (react/jsx-props-no-spreading).
      ref={panelProps.ref}
      tabIndex={panelProps.tabIndex}
      role={panelProps.role}
      aria-label={panelProps['aria-label']}
      data-shortcut-guard={panelProps['data-shortcut-guard']}
      style={panelProps.style}
      onClick={panelProps.onClick}
      className="fixed z-[60] w-[280px] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
    >
      <div className="px-3 pt-2.5 pb-1.5 text-[10.5px] font-bold tracking-wide text-text-muted uppercase">
        Set parent
      </div>

      <div className="px-3 pb-2">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tickets…"
          aria-label="Search tickets to set as parent"
          className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
        />
      </div>

      <div className="thin-scroll max-h-64 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm font-medium text-text-secondary hover:bg-surface-2"
        >
          No parent
          {value === null && (
            <span className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
              current
            </span>
          )}
        </button>

        {options.length === 0 && (
          <div className="px-3 py-3 text-xs text-text-muted">
            {query.trim()
              ? `No parentless tickets match "${query.trim()}".`
              : 'No parentless tickets in this project.'}
          </div>
        )}
        {options.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-2"
          >
            <span className="shrink-0 font-mono text-xs text-text-muted">{t.identifier}</span>
            <span className="shrink-0 text-text-muted">—</span>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {value === t.id && (
              <span className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
                current
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
