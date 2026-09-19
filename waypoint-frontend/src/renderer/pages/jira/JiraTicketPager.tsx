import { clsx } from 'clsx';
import { pageWindow } from './useMyJiraQueue';

/**
 * Numbered pages under a tab's ticket list — the per-role/per-source tabs'
 * own pager, built on usePagedTickets rather than useMyJiraQueue's
 * `MyJiraQueue`. Same rendered shape as MyJiraPager (the All Tickets tab's
 * own pager: reuses its exported `pageWindow`), but over plain primitive
 * props instead of that hook's specific shape, since these tabs have no
 * `setQuery` to call through.
 *
 * Renders nothing at all on a single page — see MyJiraPager's own comment
 * for why that is deliberate, not an oversight.
 */
export default function JiraTicketPager({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Ticket list pages"
      className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-text-muted"
    >
      <span>
        Showing {rangeStart}–{rangeEnd} of {total}
      </span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="cursor-pointer rounded-[var(--radius-sm)] border border-border-strong px-2 py-1 font-semibold text-text-secondary hover:bg-surface-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          ‹ Prev
        </button>
        {pageWindow(page, pageCount).map((entry, index, run) =>
          entry === 'gap' ? (
            // Keyed by the page it follows rather than by its array index —
            // same reasoning as MyJiraPager's own identical gap key.
            <span key={`gap-after-${run[index - 1]}`} className="px-1">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              aria-current={entry === page ? 'page' : undefined}
              onClick={() => onPageChange(entry)}
              className={clsx(
                'min-w-7 cursor-pointer rounded-[var(--radius-sm)] border px-2 py-1 font-semibold',
                entry === page
                  ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                  : 'border-border-strong text-text-secondary hover:bg-surface-2',
              )}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          className="cursor-pointer rounded-[var(--radius-sm)] border border-border-strong px-2 py-1 font-semibold text-text-secondary hover:bg-surface-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Next ›
        </button>
      </span>
    </nav>
  );
}
