import { useId, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { IconChevron, IconGitBranch } from '@/components/icons';
import { useFloatingPanel } from '@/components/ui/useFloatingPanel';

/**
 * The branches Waypoint itself creates (worktrees.ts's `agent/<key>…`
 * and `session/<id>`), which a person picking a base branch almost never
 * wants: hidden by default behind "Show all branches" (customer feedback
 * round 1, Fix 8 — a flat 78-item select, most of it this litter).
 */
export const MACHINE_BRANCH = /^(agent|session)\//;

export function isMachineBranch(branch: string): boolean {
  return MACHINE_BRANCH.test(branch);
}

/** The branches to show for a query: a substring match, machine branches only when asked for. */
export function filterBranches(
  branches: ReadonlyArray<string>,
  query: string,
  showAll: boolean,
): string[] {
  const q = query.trim().toLowerCase();
  return branches.filter(
    (b) =>
      (showAll || !isMachineBranch(b)) && (!q || b.toLowerCase().includes(q)),
  );
}

const PANEL_WIDTH = 300;

/**
 * A searchable base-branch picker in place of the flat `<select>`. The
 * trigger reads as the field did (the branch in mono, a chevron); the
 * panel is a search box over the repository's branches with
 * `agent/*`/`session/*` folded away until "Show all branches" — never
 * remembered across opens, so the litter does not creep back by default.
 */
export function BranchPicker({
  id,
  branches,
  value,
  onChange,
  disabled,
  label = 'Base branch',
  className,
}: {
  id?: string;
  branches: ReadonlyArray<string>;
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        data-branch-picker
        data-value={value}
        className={clsx(
          'inline-flex max-w-full items-center gap-1.5 text-left',
          className,
        )}
      >
        <IconGitBranch size={11} className="shrink-0 text-text-muted" />
        <span className="min-w-0 truncate font-mono">{value || '—'}</span>
        <IconChevron size={12} className="shrink-0 text-text-muted" />
      </button>
      {open && (
        <BranchPanel
          listId={listId}
          triggerRef={triggerRef}
          branches={branches}
          value={value}
          label={label}
          onPick={(b) => {
            onChange(b);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function BranchPanel({
  listId,
  triggerRef,
  branches,
  value,
  label,
  onPick,
  onClose,
}: {
  listId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  branches: ReadonlyArray<string>;
  value: string;
  label: string;
  onPick: (branch: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const hiddenCount = useMemo(
    () => branches.filter(isMachineBranch).length,
    [branches],
  );
  const shown = useMemo(
    () => filterBranches(branches, query, showAll),
    [branches, query, showAll],
  );
  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: PANEL_WIDTH,
    estimatedHeight: 320,
    align: 'left',
    label,
    remeasureOn: [shown.length, showAll],
  });
  const active = Math.min(highlight, Math.max(0, shown.length - 1));

  return createPortal(
    <div
      ref={panelProps.ref}
      tabIndex={panelProps.tabIndex}
      role={panelProps.role}
      aria-label={panelProps['aria-label']}
      data-shortcut-guard={panelProps['data-shortcut-guard']}
      style={panelProps.style}
      onClick={panelProps.onClick}
      className="fixed z-[60] flex w-[300px] flex-col overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
    >
      <input
        aria-label="Search branches"
        placeholder="Search branches…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter' && shown[active]) {
            e.preventDefault();
            onPick(shown[active]);
          }
        }}
        className="m-2 h-8 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 font-mono text-xs text-text outline-none focus:border-accent"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        className="thin-scroll max-h-64 overflow-y-auto pb-1"
      >
        {shown.length === 0 && (
          <li className="px-3 py-2 text-xs text-text-muted">
            {query ? 'No branch matches.' : 'No branches.'}
          </li>
        )}
        {shown.map((branch, i) => (
          <li key={branch}>
            <button
              type="button"
              role="option"
              aria-selected={branch === value}
              onClick={() => onPick(branch)}
              onMouseEnter={() => setHighlight(i)}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs',
                i === active ? 'bg-surface-2 text-text' : 'text-text-secondary',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{branch}</span>
              {branch === value && (
                <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
                  current
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <label className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-text-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              setHighlight(0);
            }}
          />
          Show all branches (includes {hiddenCount} Waypoint-created{' '}
          {hiddenCount === 1 ? 'branch' : 'branches'})
        </label>
      )}
    </div>,
    document.body,
  );
}
