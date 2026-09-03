import { act, renderHook, waitFor } from '@testing-library/react';
import { listReviewQueue, getProposalCounts } from '@/data/api';
import type { ProposalView } from '@/types/entities';
import {
  resetProposalStoreForTests,
  upsertProposals,
} from '@/lib/proposalStore';
import { useReviewQueue } from './useReviewQueue';

jest.mock('@/data/api', () => ({
  listReviewQueue: jest.fn(),
  getProposalCounts: jest.fn(),
}));

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-1',
    conversationId: null,
    kind: 'state_change',
    ticketId: 'wi-1',
    payload: { stateId: 'st-done' },
    snapshot: { identifier: 'LAUNCH-3', title: 'T', toStateName: 'Done' },
    anchorSeq: null,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
    expiresAt: '2026-01-02T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'agent_run',
    projectId: 'proj-1',
    agentId: 'agent-1',
    agentRunId: null,
    sourceRequestId: null,
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetProposalStoreForTests();
});

describe('useReviewQueue', () => {
  it('fetches the given segment and filters on mount, upserting rows into the shared store', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a' })],
      counts: { proposed: 1, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    const { result } = renderHook(() =>
      useReviewQueue('proposed', 'agent-1', 'proj-1', 'state_change'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.proposals.map((p) => p.id)).toEqual(['a']);
    expect(result.current.counts).toEqual({
      proposed: 1,
      blocked: 0,
      recent: 0,
    });
    expect(listReviewQueue).toHaveBeenCalledWith({
      status: 'proposed',
      agentId: 'agent-1',
      projectId: 'proj-1',
      kind: 'state_change',
    });
  });

  it('refetches when the segment or a filter changes', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [],
      counts: { proposed: 0, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    const { rerender } = renderHook(
      ({
        segment,
        agentId,
      }: {
        segment: 'proposed' | 'recent';
        agentId: string | undefined;
      }) => useReviewQueue(segment, agentId, undefined, undefined),
      { initialProps: { segment: 'proposed', agentId: undefined } },
    );

    await waitFor(() => expect(listReviewQueue).toHaveBeenCalledTimes(1));

    rerender({ segment: 'recent', agentId: undefined });
    await waitFor(() => expect(listReviewQueue).toHaveBeenCalledTimes(2));
    expect(listReviewQueue).toHaveBeenLastCalledWith({
      status: 'recent',
      agentId: undefined,
      projectId: undefined,
      kind: undefined,
    });

    rerender({ segment: 'recent', agentId: 'agent-9' });
    await waitFor(() => expect(listReviewQueue).toHaveBeenCalledTimes(3));
    expect(listReviewQueue).toHaveBeenLastCalledWith({
      status: 'recent',
      agentId: 'agent-9',
      projectId: undefined,
      kind: undefined,
    });
  });

  // The 'proposed' segment's core promise: a row this hook (or any other
  // mounted surface reading the shared store — the Copilot panel, a bulk
  // action fired from this same screen) resolves drops out of "Waiting on
  // you" immediately, because the derived list re-filters on the row's own
  // live status rather than the id list fetched at query time.
  it('drops a row from the proposed segment once its store status moves off proposed, without a refetch', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [
        proposal({ id: 'a', status: 'proposed' }),
        proposal({ id: 'b', status: 'proposed' }),
      ],
      counts: { proposed: 2, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    const { result } = renderHook(() =>
      useReviewQueue('proposed', undefined, undefined, undefined),
    );
    await waitFor(() => expect(result.current.proposals).toHaveLength(2));

    act(() => {
      upsertProposals([proposal({ id: 'a', status: 'executed' })]);
    });

    expect(result.current.proposals.map((p) => p.id)).toEqual(['b']);
    // No extra fetch triggered by the store mutation alone.
    expect(listReviewQueue).toHaveBeenCalledTimes(1);
  });

  it('does not apply that live-status filter to the recent segment (already-resolved rows stay visible)', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a', status: 'executed' })],
      counts: { proposed: 0, blocked: 0, recent: 1 },
      nextCursor: null,
    });

    const { result } = renderHook(() =>
      useReviewQueue('recent', undefined, undefined, undefined),
    );
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));
    expect(result.current.proposals[0].status).toBe('executed');
  });

  it('loadMore appends the next page and stops offering more once nextCursor is null', async () => {
    jest
      .mocked(listReviewQueue)
      .mockResolvedValueOnce({
        proposals: [proposal({ id: 'a' })],
        counts: { proposed: 2, blocked: 0, recent: 0 },
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        proposals: [proposal({ id: 'b' })],
        counts: { proposed: 2, blocked: 0, recent: 0 },
        nextCursor: null,
      });

    const { result } = renderHook(() =>
      useReviewQueue('proposed', undefined, undefined, undefined),
    );
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.proposals.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
    expect(listReviewQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-1' }),
    );
  });

  it('refreshCounts polls /proposals/counts without touching the loaded page', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a' })],
      counts: { proposed: 1, blocked: 0, recent: 0 },
      nextCursor: null,
    });
    jest
      .mocked(getProposalCounts)
      .mockResolvedValue({ proposed: 4, blocked: 0, recent: 2 });

    const { result } = renderHook(() =>
      useReviewQueue('proposed', undefined, undefined, undefined),
    );
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));

    await act(async () => {
      await result.current.refreshCounts();
    });

    expect(result.current.counts).toEqual({
      proposed: 4,
      blocked: 0,
      recent: 2,
    });
    expect(result.current.proposals.map((p) => p.id)).toEqual(['a']);
  });
});
