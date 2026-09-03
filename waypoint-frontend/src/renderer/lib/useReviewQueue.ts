import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listReviewQueue,
  getProposalCounts,
  type ReviewQueueSegment,
  type ReviewQueueCounts,
} from '@/data/api';
import { useAllProposals, upsertProposals } from '@/lib/proposalStore';
import type { ProposalKind, ProposalView } from '@/types/entities';

/**
 * Owns the Review screen's page of the workspace-scoped aggregate queue
 * (architecture §4.4, W4.3) — the segments/filters/pagination sibling of
 * useCopilotProposals.ts's conversation-scoped hook. Same shape: rows land
 * in the shared lib/proposalStore.ts (W4.1) rather than local component
 * state, so an approve/reject fired from here is visible on any other
 * mounted surface reading the same store with no refetch, and vice versa
 * (e.g. approving from the Copilot panel removes the row from an
 * already-mounted Review screen).
 *
 * What this hook adds beyond the store itself: it remembers WHICH ids the
 * current (segment, agentId, projectId, kind) query returned, across pages,
 * so `proposals` below can be recomputed live from the store on every
 * store mutation — not just re-derived once at fetch time. That's what
 * makes a bulk-approve fired from THIS screen disappear from the "Waiting
 * on you" segment immediately: the row's own `status` moves off 'proposed'
 * in the store, and the derived list re-filters on every store notify with
 * no refetch.
 */
export function useReviewQueue(
  segment: ReviewQueueSegment,
  agentId: string | undefined,
  projectId: string | undefined,
  kind: ProposalKind | undefined,
) {
  const allProposals = useAllProposals();
  const [ids, setIds] = useState<string[]>([]);
  const [counts, setCounts] = useState<ReviewQueueCounts>({
    proposed: 0,
    blocked: 0,
    recent: 0,
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Guards every async response against a query change mid-flight — a slow
  // response for the PREVIOUS (segment, filters) tuple must never overwrite
  // state for the query now showing. Same pattern as useCopilotProposals's
  // activeIdRef.
  const queryToken = useRef(0);

  const reload = useCallback(async () => {
    const token = ++queryToken.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listReviewQueue({
        status: segment,
        agentId,
        projectId,
        kind,
      });
      if (queryToken.current !== token) return;
      upsertProposals(result.proposals);
      setIds(result.proposals.map((p) => p.id));
      setCounts(result.counts);
      setNextCursor(result.nextCursor);
    } catch (err) {
      if (queryToken.current === token)
        setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (queryToken.current === token) setLoading(false);
    }
  }, [segment, agentId, projectId, kind]);

  useEffect(() => {
    reload().catch(() => {
      // httpClient already toasted; error state above covers the empty view.
    });
  }, [reload]);

  const loadMore = useCallback(async () => {
    const token = queryToken.current;
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await listReviewQueue({
        status: segment,
        agentId,
        projectId,
        kind,
        cursor: nextCursor,
      });
      if (queryToken.current !== token) return;
      upsertProposals(result.proposals);
      setIds((prev) => [...prev, ...result.proposals.map((p) => p.id)]);
      setCounts(result.counts);
      setNextCursor(result.nextCursor);
    } finally {
      if (queryToken.current === token) setLoadingMore(false);
    }
  }, [segment, agentId, projectId, kind, nextCursor, loadingMore]);

  // Re-poll just the counts (cheap — see getProposalCounts's own comment)
  // after a bulk action changes segment membership, without disturbing this
  // hook's already-loaded page or scroll position.
  const refreshCounts = useCallback(async () => {
    const result = await getProposalCounts();
    setCounts(result);
  }, []);

  const byId = useMemo(() => {
    const map = new Map<string, ProposalView>();
    for (const p of allProposals) map.set(p.id, p);
    return map;
  }, [allProposals]);

  // Re-derived from the store on every render (cheap: `ids` is at most a
  // handful of pages of `limit`). The 'proposed' segment additionally
  // filters on the row's live status — a proposal approved/rejected from
  // this screen (or from anywhere else, e.g. the Copilot panel) drops out
  // of "Waiting on you" the instant the store updates, with no refetch.
  // 'recent'/'blocked' rows are already resolved (or the segment is always
  // empty), so no equivalent live filter applies there.
  const proposals = useMemo(() => {
    const rows = ids
      .map((id) => byId.get(id))
      .filter((p): p is ProposalView => Boolean(p));
    return segment === 'proposed'
      ? rows.filter((p) => p.status === 'proposed')
      : rows;
  }, [ids, byId, segment]);

  return {
    proposals,
    counts,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor != null,
    loadMore,
    reload,
    refreshCounts,
  };
}
