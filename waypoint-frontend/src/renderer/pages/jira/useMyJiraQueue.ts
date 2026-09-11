import { useCallback, useEffect, useMemo, useState } from 'react';
import { PRIORITY_ORDER } from '@/components/domain/PriorityIcon';
import type { JiraProjectKey, JiraTicket, JiraTicketRole } from '@/types/jira';

/**
 * Filtering, sorting and pagination for the My Jira queue — all of it in the
 * renderer, over the array `listMyJiraTickets` already returned. Not one of
 * these controls re-runs the JQL search, and that is the design rather than
 * an accident of convenience. Four independent reasons, any one of which
 * would be sufficient on its own:
 *
 *  1. Server-side filtering would break a documented invariant. Reassigning
 *     an issue away from yourself deliberately does NOT remove its row —
 *     setJiraTicketAssignee patches in place with .map(), never .filter(),
 *     and says in its own comment that the row "stays visible until the next
 *     refresh". A filter chip that re-ran MY_WORK_JQL *is* a refresh, so
 *     every chip click would silently delete the row the user just acted on.
 *  2. JiraTicketPage reads out of the same cache. /my-jira/:ticketKey finds
 *     its issue in jiraApi's module-level `lastTickets`, which
 *     `rememberTickets` overwrites wholesale on every list read — so a
 *     filtered read would leave that cache holding only the filtered subset,
 *     and expanding a row would start 404-ing on issues plainly on screen a
 *     moment earlier.
 *  3. The transitions cache would thrash. `rememberTickets` rebuilds
 *     `transitionsByTicketId` from each search, so a search per keystroke
 *     would mean a per-issue transitions round trip per keystroke behind it.
 *  4. The on-screen copy is a contract. "refresh re-runs the search"
 *     (MyJiraPage.tsx) was written deliberately to replace a false "polls
 *     every 15s" — and later a false "one API call", since a queue over
 *     PAGE_SIZE pages the same search across several, and then a false
 *     "re-reads the whole queue", since it stops at MAX_PAGES (ROAD-22).
 *     What it promises is that the search runs only when the page opens
 *     (MyJiraPage and JiraTicketPage both read on mount) or Refresh is
 *     pressed, and never from this toolbar: a filter, sort or page change
 *     that quietly issued a request would make it false again. This hook
 *     imports nothing from data/jiraApi, which is what keeps that true.
 *
 * The cost is real and is stated rather than hidden. listMyTickets caps its
 * crawl at MAX_PAGES × PAGE_SIZE = 500, so these filters and sorts apply to
 * the 500 most recently updated unresolved issues, not to the queue. That is
 * exactly what MyJiraPage's truncation strip exists to say out loud, and why
 * it shipped alongside this rather than after it.
 */

export const PAGE_SIZE = 25;

export type JiraSortKey = 'updated' | 'priority' | 'key';

/**
 * Three keys, each with one fixed direction and no asc/desc toggle.
 *
 * A work queue has exactly one useful direction per key — nobody wants their
 * least urgent work first — and a toggle would double the state space and
 * the test matrix to offer five orderings nobody asked for. It is a one-line
 * addition later if that turns out to be wrong.
 *
 * There is deliberately no "status" sort. `stateName` is per-workflow free
 * text a site's admins chose, so alphabetising it produces an order with no
 * meaning ("Blocked, Done, In Progress, To Do"). Status is genuinely useful
 * as a *filter*, which is how it is offered.
 */
export const SORT_OPTIONS: { key: JiraSortKey; label: string }[] = [
  { key: 'updated', label: 'Recently updated' },
  { key: 'priority', label: 'Priority' },
  { key: 'key', label: 'Issue key' },
];

export interface JiraQueueQuery {
  projectKey: JiraProjectKey | 'all';
  role: JiraTicketRole | 'all';
  /** Selected status names, in the site's own words. Empty = every status. */
  stateNames: string[];
  /** Free text over key + title. Stored raw; trimmed at compare time. */
  text: string;
  sort: JiraSortKey;
  /** 1-based. Never trusted directly — clamped against pageCount at render. */
  page: number;
}

/** `updated` is the default because it is also the order MY_WORK_JQL already
 * returns (`ORDER BY updated DESC`) — first paint matches what this page
 * rendered before any of this existed, for every ticket whose `updated`
 * Jira actually sent. ROAD-15 made a missing/unparseable `updated` sort to
 * the bottom client-side rather than masquerading as "just now", so that
 * one case is no longer byte-identical to the server's own order — the
 * honest tradeoff for not lying about a timestamp this app doesn't have. */
export const DEFAULT_QUERY: JiraQueueQuery = {
  projectKey: 'all',
  role: 'all',
  stateNames: [],
  text: '',
  sort: 'updated',
  page: 1,
};

/**
 * The query the last mount of this hook was left holding.
 *
 * Survives MyJiraPage unmounting, which is not a hypothetical: the drawer's
 * Expand navigates to /my-jira/:key, and coming back today drops the user's
 * filters on the floor without saying so. That is a papercut with two
 * filters; with five, a sort and a page it is a real loss of work.
 *
 * Module scope, NOT localStorage. A filter is a working set for this sitting,
 * not a preference — persisting it to disk means opening the app tomorrow to
 * a narrowed list with no memory of having narrowed it, which is the same
 * class of "this looks complete and isn't" bug the truncation notice exists
 * to kill. Same reasoning, same shape, as jiraApi.ts's own session cache
 * (lastTickets/lastSyncAt) — and the deliberate opposite of lib/recents.ts,
 * which genuinely should outlive the session.
 *
 * Also not the URL / useSearchParams, which is the other obvious home for
 * this. JiraTicketPage's own "← Back to My Jira" is a plain <Link
 * to="/my-jira">, so the round trip this is meant to survive would drop the
 * query string anyway; it would add a serialization format to get wrong and
 * to keep backward-compatible; and an Electron window has no address bar, so
 * none of the things a URL is normally worth it for — copying a link,
 * bookmarking, the back button — are available to pay for it.
 */
let lastQuery: JiraQueueQuery = DEFAULT_QUERY;

/** Test-only — the module-level query cache outlives any one `it()` block,
 * so without this a test that clicks a filter silently changes the starting
 * state of every test after it. See jiraStore.ts's resetJiraStoreForTests for
 * the same escape hatch and the same reason. */
export function resetMyJiraQueueForTests(): void {
  lastQuery = DEFAULT_QUERY;
}

/**
 * Forgets the remembered query. Called when the Jira connection goes away,
 * because a filter is scoped to the account it was built against.
 *
 * The module-level cache is deliberate and stays (see `lastQuery` above),
 * but "survives a remount" quietly became "survives a different person
 * signing in": disconnecting and reconnecting as another account left the
 * previous user's project filter and search text in place, so someone who
 * had never touched a filter opened straight into "No tickets match these
 * filters." over a queue that was not empty. `clearCache()` in jiraApi.ts
 * already drops the tickets on disconnect; this is the same idea for the
 * query that selects them, and it is exported rather than folded in there
 * so the page-level concern stays owned by the page.
 */
export function clearMyJiraQuery(): void {
  lastQuery = DEFAULT_QUERY;
}

/**
 * Whether anything is narrowing or reordering the list — i.e. whether "No
 * tickets match these filters." is the honest empty state rather than
 * "Nothing in your Jira queue."
 *
 * Whitespace-only `text` is deliberately NOT active: a stray space typed into
 * the search box would otherwise flip an empty queue's copy from a true
 * statement about the user's Jira into a false one about their filters, and
 * `matchesQuery` already treats it as matching everything, so the two agree.
 *
 * A non-default `sort` DOES count. It is not a filter, so it can never be the
 * reason nothing matched — but "Clear filters" is the one control that
 * restores a known-good view, and a Clear that left the list in an order the
 * user no longer wants is a Clear that didn't clear. `page` never counts:
 * being on page 3 is a consequence of the query, not part of it.
 */
export function hasActiveQuery(query: JiraQueueQuery): boolean {
  return (
    query.projectKey !== DEFAULT_QUERY.projectKey ||
    query.role !== DEFAULT_QUERY.role ||
    query.stateNames.length > 0 ||
    query.text.trim() !== '' ||
    query.sort !== DEFAULT_QUERY.sort
  );
}

export function matchesQuery(
  ticket: JiraTicket,
  query: JiraQueueQuery,
): boolean {
  if (query.projectKey !== 'all' && ticket.projectKey !== query.projectKey) {
    return false;
  }
  if (query.role !== 'all' && ticket.role !== query.role) return false;
  // Empty selection means every status, not no status — the alternative
  // (empty = match nothing) would render an empty list the moment a user
  // unticked their last checkbox, which reads as a bug rather than a filter.
  if (
    query.stateNames.length > 0 &&
    !query.stateNames.includes(ticket.stateName)
  ) {
    return false;
  }
  const text = query.text.trim().toLowerCase();
  if (text === '') return true;
  // Key as well as title: "ENG-4" is how people refer to their own work out
  // loud, and a search box that couldn't find an issue by the identifier
  // printed on its own row would be a strange thing to ship.
  return (
    ticket.key.toLowerCase().includes(text) ||
    ticket.title.toLowerCase().includes(text)
  );
}

/**
 * Orders two Jira issue keys the way a person reads them: project first,
 * then the issue NUMBER as a number. Lexical comparison puts ENG-81 before
 * ENG-9, which is wrong in the one place a key sort exists to be right.
 *
 * Not `localeCompare(b, undefined, { numeric: true })`: that reads digit
 * runs as numbers as a side effect of collation, under whatever locale the
 * process happens to have, and a sort order that depends on the machine's
 * locale is not an order. This splits on the LAST '-' (a project key can
 * legally contain one) and compares the halves for what they are.
 *
 * A key whose suffix isn't a number — a malformed key, a shape a future
 * Jira invents — falls back to a plain string compare rather than to NaN,
 * so such a row lands somewhere deterministic instead of somewhere the
 * comparator's own inconsistency decides per run.
 */
export function compareIssueKeys(a: string, b: string): number {
  const aCut = a.lastIndexOf('-');
  const bCut = b.lastIndexOf('-');
  const aProject = aCut === -1 ? a : a.slice(0, aCut);
  const bProject = bCut === -1 ? b : b.slice(0, bCut);
  if (aProject !== bProject) return aProject.localeCompare(bProject);

  const aSuffix = aCut === -1 ? '' : a.slice(aCut + 1);
  const bSuffix = bCut === -1 ? '' : b.slice(bCut + 1);
  const aNumber = Number(aSuffix);
  const bNumber = Number(bSuffix);
  // `Number('')` is 0, which would quietly sort a suffix-less key as issue
  // zero, so emptiness is checked rather than inferred from the parse.
  const bothNumeric =
    aSuffix !== '' &&
    bSuffix !== '' &&
    Number.isFinite(aNumber) &&
    Number.isFinite(bNumber);
  if (bothNumeric) return aNumber - bNumber;
  return aSuffix.localeCompare(bSuffix);
}

/**
 * The comparator behind every sort option — and note that every branch falls
 * through to `compareIssueKeys` rather than returning 0 on a tie.
 *
 * Array.prototype.sort is stable, so a 0 here would be "safe" in the sense
 * that nothing crashes. But stability only preserves the *input* order, and
 * the input order is whatever Jira happened to return on this particular
 * refresh. Two issues of equal priority could therefore swap places between
 * two reads with nothing about them having changed, which is exactly the
 * kind of movement that makes a list feel untrustworthy. The explicit
 * tiebreak makes rendered order a function of the set alone.
 */
export function compareTickets(
  a: JiraTicket,
  b: JiraTicket,
  sort: JiraSortKey,
): number {
  if (sort === 'priority') {
    const byPriority =
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
    if (byPriority !== 0) return byPriority;
  }
  if (sort === 'updated') {
    // "Unknown" covers two shapes Jira can hand back: a genuinely missing
    // updatedAt (null), and a present-but-unparseable one (Date.parse
    // yields NaN, which a malformed or non-ISO string can still produce
    // even though the field is typed as a string). Both are put after
    // every known timestamp rather than falling through to the key
    // tiebreak — scattering NaN among real dates via the tiebreak isn't
    // just a display quirk, it makes the comparator intransitive
    // (a<b, b<c, c<a is reachable), which breaks the sort itself.
    const at = a.updatedAt === null ? NaN : Date.parse(a.updatedAt);
    const bt = b.updatedAt === null ? NaN : Date.parse(b.updatedAt);
    const aKnown = Number.isFinite(at);
    const bKnown = Number.isFinite(bt);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown && bt !== at) return bt - at;
  }
  return compareIssueKeys(a.key, b.key);
}

/**
 * The pager's rendered run: page numbers plus 'gap' markers. Always includes
 * 1, pageCount, and current ± 1.
 *
 * Never emits a 'gap' standing in for a single omitted page — a gap that
 * hides one number is strictly worse than the number, since it costs the same
 * space, tells the reader less, and takes an extra click to reach.
 */
export function pageWindow(
  current: number,
  pageCount: number,
): (number | 'gap')[] {
  const shown = Array.from(
    new Set([1, current - 1, current, current + 1, pageCount]),
  )
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);

  return shown.flatMap((page, index) => {
    if (index === 0) return [page];
    const previous = shown[index - 1];
    const missing = page - previous - 1;
    if (missing === 0) return [page];
    if (missing === 1) return [previous + 1, page];
    return ['gap' as const, page];
  });
}

export interface MyJiraQueue {
  query: JiraQueueQuery;
  /** Patches the query. Resets to page 1 unless the patch is ONLY `{ page }`
   *  — so forgetting to reset is impossible rather than a discipline. */
  setQuery: (patch: Partial<JiraQueueQuery>) => void;
  resetQuery: () => void;
  hasActiveQuery: boolean;
  /** Every loaded ticket surviving the filters, sorted. */
  matched: JiraTicket[];
  /** The slice rendered on the current page. */
  pageItems: JiraTicket[];
  /** Clamped into [1, pageCount] — never `query.page` raw. */
  page: number;
  pageCount: number;
  /** 1-based inclusive range of `matched` on this page, for "Showing X–Y of N". */
  rangeStart: number;
  rangeEnd: number;
  /** Derived from the loaded set — see the existing projectCounts comment. */
  projectKeys: JiraProjectKey[];
  projectCounts: Map<JiraProjectKey, number>;
  stateNames: string[];
}

export function useMyJiraQueue(tickets: JiraTicket[]): MyJiraQueue {
  const [query, setQueryState] = useState<JiraQueueQuery>(() => lastQuery);

  useEffect(() => {
    lastQuery = query;
  }, [query]);

  const setQuery = useCallback((patch: Partial<JiraQueueQuery>) => {
    setQueryState((current) => {
      // Changing what is in the list changes what page 3 even means, so
      // every patch but a bare page change goes back to the first page. This
      // is enforced by the shape of the setter rather than left to each call
      // site to remember, because "remember to reset the page" is precisely
      // the kind of rule that is followed four times and forgotten the fifth.
      const keys = Object.keys(patch);
      const pageOnly = keys.length === 1 && keys[0] === 'page';
      return pageOnly
        ? { ...current, ...patch }
        : { ...current, ...patch, page: 1 };
    });
  }, []);

  const resetQuery = useCallback(() => setQueryState(DEFAULT_QUERY), []);

  // Derived from whatever the connected account can actually see, sorted for
  // a stable chip order. This used to iterate a hardcoded ['ENG','PLAT','GRW']
  // — the three fixture projects — which against a real site would have
  // rendered no project chips at all for anyone whose projects happen to be
  // called something else.
  //
  // Counts are of the whole loaded set, deliberately not of what currently
  // matches. A count that moved as you typed would be a moving target you
  // could never learn; "ENG 12" as a stable fact about your queue is
  // something you read once and then navigate by.
  const projectCounts = useMemo(
    () =>
      tickets.reduce(
        (counts, ticket) =>
          counts.set(
            ticket.projectKey,
            (counts.get(ticket.projectKey) ?? 0) + 1,
          ),
        new Map<JiraProjectKey, number>(),
      ),
    [tickets],
  );

  const projectKeys = useMemo(
    () => Array.from(projectCounts.keys()).sort((a, b) => a.localeCompare(b)),
    [projectCounts],
  );

  // Statuses are per-workflow free text, so the only honest list of them is
  // the one this account's own issues actually use. A hardcoded set would be
  // wrong on the first site that renamed "To Do".
  const stateNames = useMemo(
    () =>
      Array.from(new Set(tickets.map((t) => t.stateName))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [tickets],
  );

  const matched = useMemo(
    () =>
      tickets
        .filter((ticket) => matchesQuery(ticket, query))
        .sort((a, b) => compareTickets(a, b, query.sort)),
    [tickets, query],
  );

  // Clamped here, at render, and deliberately not in a useEffect that calls
  // setQuery({ page: 1 }). An effect runs *after* the offending render, so
  // the out-of-range page would paint first — one frame of "No tickets match
  // these filters." over a list that has plenty. The clamp also covers the
  // case no effect on `query` would catch at all: the set shrinking underneath
  // an unchanged query, which is what handleDismissTombstone and a smaller
  // refresh both do.
  const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const page = Math.min(Math.max(query.page, 1), pageCount);

  const pageItems = useMemo(
    () => matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [matched, page],
  );

  return {
    query,
    setQuery,
    resetQuery,
    hasActiveQuery: hasActiveQuery(query),
    matched,
    pageItems,
    page,
    pageCount,
    rangeStart: matched.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1,
    rangeEnd: Math.min(page * PAGE_SIZE, matched.length),
    projectKeys,
    projectCounts,
    stateNames,
  };
}
