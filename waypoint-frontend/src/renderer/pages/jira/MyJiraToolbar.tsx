import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { IconCheck, IconChevron, IconSearch } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/pages/tickets/Popover';
import { jiraProjectColor } from '@/types/jira';
import type { JiraTicketRole } from '@/types/jira';
import { SORT_OPTIONS, type MyJiraQueue } from './useMyJiraQueue';

const ROLE_FILTERS: { key: JiraTicketRole | 'all'; label: string }[] = [
  { key: 'all', label: 'Any role' },
  { key: 'assignee', label: 'Assigned' },
  { key: 'reporter', label: 'Reported' },
  { key: 'watcher', label: 'Watching' },
];

function FilterChip({
  active,
  onClick,
  swatch,
  children,
}: {
  active: boolean;
  onClick: () => void;
  swatch?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold whitespace-nowrap',
        active
          ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
          : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-2',
      )}
    >
      {swatch && (
        <span
          className="size-2 shrink-0 rounded-sm"
          style={{ background: swatch }}
        />
      )}
      {children}
    </button>
  );
}

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

/**
 * Builds the render-prop `Popover` asks for, so the two dropdowns here share
 * one trigger button rather than restating the same six attributes twice.
 *
 * Defined at module scope, not inline in the JSX, and that is load-bearing
 * rather than tidiness: a function returning JSX written inside a component's
 * render is a component React sees as a *new type* on every render, which
 * throws away and rebuilds the subtree's DOM and state each time. Here that
 * would mean the trigger button losing focus mid-interaction. The neighbouring
 * TicketListToolbar does write these inline and carries the lint error for it;
 * copying the shape of that toolbar was the goal, copying that was not.
 */
function popoverTrigger(label: ReactNode) {
  return function PopoverTriggerButton({
    open,
    toggle,
  }: {
    open: boolean;
    toggle: () => void;
  }) {
    return (
      <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
        {label}
        <IconChevron size={13} />
      </Button>
    );
  };
}

/**
 * Everything above the ticket list: the project and role chips this page has
 * always had, plus a search box, a status filter and a sort.
 *
 * This has to render OUTSIDE the list's `overflow-hidden` container, and the
 * page keeps it that way. Both popovers here open as `absolute z-40` panels,
 * and an absolutely-positioned panel inside a clipping ancestor is cut off at
 * that ancestor's edge — the exact failure three tests in MyJiraPage.test.tsx
 * exist to guard against for the row-level transition popover, which had to
 * escape to a portal to survive it.
 */
export default function MyJiraToolbar({
  queue,
  totalCount,
}: {
  queue: MyJiraQueue;
  /** Every loaded ticket, not the matching ones — the "All n" chip and the
   *  per-project counts describe the queue, not the current view. */
  totalCount: number;
}) {
  const { query, setQuery, projectKeys, projectCounts, stateNames } = queue;
  const activeSort = SORT_OPTIONS.find((o) => o.key === query.sort);

  return (
    <div className="mb-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          active={query.projectKey === 'all'}
          onClick={() => setQuery({ projectKey: 'all' })}
        >
          All {totalCount}
        </FilterChip>
        {projectKeys.map((key) => (
          <FilterChip
            key={key}
            active={query.projectKey === key}
            onClick={() => setQuery({ projectKey: key })}
            swatch={jiraProjectColor(key)}
          >
            {key} {projectCounts.get(key)}
          </FilterChip>
        ))}
        <span className="mx-1 h-4.5 w-px bg-border" />
        {ROLE_FILTERS.map((r) => (
          <FilterChip
            key={r.key}
            active={query.role === r.key}
            onClick={() => setQuery({ role: r.key })}
          >
            {r.label}
          </FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Not debounced, unlike the near-identical box in
            TicketListToolbar. That one debounces because every keystroke
            there is an HTTP round trip to the tickets API; this one filters
            an array of at most 500 objects already in memory, so a debounce
            would buy nothing and cost the thing a search box is judged on —
            the list moving while you type. */}
        <span className="relative flex h-8 items-center">
          <IconSearch
            size={13}
            className="pointer-events-none absolute left-2.5 text-text-muted"
          />
          <input
            type="text"
            value={query.text}
            onChange={(e) => setQuery({ text: e.target.value })}
            placeholder="Search key or title…"
            aria-label="Search your Jira queue"
            className="h-8 w-52 rounded-[var(--radius-sm)] border border-border-strong bg-bg pr-2 pl-8 text-sm text-text outline-none placeholder:text-text-muted focus:border-accent"
          />
        </span>

        <Popover
          trigger={popoverTrigger(
            <>
              Status
              {query.stateNames.length > 0 && (
                <Badge tone="accent">{query.stateNames.length}</Badge>
              )}
            </>,
          )}
        >
          <div className="flex w-56 flex-col">
            <p className="mb-1 px-2 pt-1 text-xs font-medium tracking-wide text-text-muted uppercase">
              Status
            </p>
            {/* The site's own words, taken from the loaded issues rather than
                from a list written here — Jira statuses are per-workflow free
                text and a hardcoded set is wrong on the first site that
                renamed "To Do". */}
            {stateNames.map((name) => (
              // htmlFor as well as nesting the input, so the association is
              // explicit rather than only structural. Status names come from
              // the site and can contain spaces and punctuation, so the id is
              // prefixed to keep it a plausible identifier and to keep it from
              // colliding with anything else on the page.
              <label
                key={name}
                htmlFor={`jira-status-${name}`}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm text-text hover:bg-surface-2"
              >
                <input
                  id={`jira-status-${name}`}
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={query.stateNames.includes(name)}
                  onChange={() =>
                    setQuery({
                      stateNames: toggleInArray(query.stateNames, name),
                    })
                  }
                />
                {name}
              </label>
            ))}
            {query.stateNames.length > 0 && (
              <button
                type="button"
                onClick={() => setQuery({ stateNames: [] })}
                className="mt-1 cursor-pointer self-start px-2 text-xs text-accent hover:underline"
              >
                Clear
              </button>
            )}
          </div>
        </Popover>

        <Popover
          align="end"
          trigger={popoverTrigger(<>Sort: {activeSort?.label}</>)}
        >
          <div className="flex w-48 flex-col">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setQuery({ sort: opt.key })}
                className={clsx(
                  'flex cursor-pointer items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2',
                  query.sort === opt.key ? 'text-accent' : 'text-text',
                )}
              >
                {opt.label}
                {query.sort === opt.key && <IconCheck size={14} />}
              </button>
            ))}
          </div>
        </Popover>
      </div>
    </div>
  );
}
