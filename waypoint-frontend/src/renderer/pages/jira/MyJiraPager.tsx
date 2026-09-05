import { clsx } from 'clsx';
import { pageWindow, type MyJiraQueue } from './useMyJiraQueue';

/**
 * Numbered pages under the ticket list.
 *
 * Numbered rather than infinite scroll or a "Load more" button, because
 * neither of those is honest about what this list is. There is no more data
 * to fetch — the whole matched set is already in memory — so both would
 * perform a fake fetch, and neither can ever state the one thing a finite,
 * fully-known set makes stateable: "26–50 of 240". Infinite scroll in
 * particular makes the total unspeakable, and "Load more" only ever grows,
 * so there is no way back to the top of a 200-issue queue.
 *
 * Renders nothing at all on a single page. jiraClient's own note says a
 * personal Jira queue is 10-40 issues, so at 25 per page most users will
 * never see this component — and "Page 1 of 1" beside two dead arrows is
 * chrome that tells them nothing while implying there is somewhere else to
 * be. There is no page-size selector for the same reason: a preference to
 * manage for a control most people never meet.
 */
export default function MyJiraPager({ queue }: { queue: MyJiraQueue }) {
  const { page, pageCount, rangeStart, rangeEnd, matched, setQuery } = queue;
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Ticket list pages"
      className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-text-muted"
    >
      <span>
        Showing {rangeStart}–{rangeEnd} of {matched.length}
      </span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setQuery({ page: page - 1 })}
          className="cursor-pointer rounded-[var(--radius-sm)] border border-border-strong px-2 py-1 font-semibold text-text-secondary hover:bg-surface-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          ‹ Prev
        </button>
        {pageWindow(page, pageCount).map((entry, index, run) =>
          entry === 'gap' ? (
            // Keyed by the page it follows rather than by its array index. A
            // gap never leads the run and never follows another gap, so the
            // previous entry is always a page number — which makes this a
            // real identity ("the gap after 6") instead of a position that
            // means something different every time the run changes shape.
            <span key={`gap-after-${run[index - 1]}`} className="px-1">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              aria-current={entry === page ? 'page' : undefined}
              onClick={() => setQuery({ page: entry })}
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
          onClick={() => setQuery({ page: page + 1 })}
          className="cursor-pointer rounded-[var(--radius-sm)] border border-border-strong px-2 py-1 font-semibold text-text-secondary hover:bg-surface-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Next ›
        </button>
      </span>
    </nav>
  );
}
