import { act, renderHook, waitFor } from '@testing-library/react';
import {
  listCopilotProposals,
  approveCopilotProposal,
  rejectAllCopilotProposals,
  markCopilotProposalsNotified,
} from '@/data/api';
import type { ProposalView } from '@/types/entities';
import { resetProposalStoreForTests } from '@/lib/proposalStore';
import { useCopilotProposals } from './useCopilotProposals';

jest.mock('@/data/api', () => ({
  listCopilotProposals: jest.fn(),
  approveCopilotProposal: jest.fn(),
  rejectCopilotProposal: jest.fn(),
  rejectAllCopilotProposals: jest.fn(),
  markCopilotProposalsNotified: jest.fn(),
}));

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-1',
    conversationId: 'conv-1',
    kind: 'state_change',
    ticketId: 'wi-1',
    payload: { stateId: 'st-done' },
    snapshot: { identifier: 'LAUNCH-3', title: 'T', toStateName: 'Done' },
    anchorSeq: 1,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
    expiresAt: '2026-01-02T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'copilot',
    projectId: 'proj-1',
    agentId: null,
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
  jest.mocked(listCopilotProposals).mockResolvedValue([]);
});

describe('useCopilotProposals', () => {
  it('fetches on mount and scopes the returned list to its own conversationId', async () => {
    jest
      .mocked(listCopilotProposals)
      .mockImplementation(async (id: string) =>
        id === 'conv-1'
          ? [proposal({ id: 'a', conversationId: 'conv-1' })]
          : [],
      );

    const { result } = renderHook(() => useCopilotProposals('conv-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.proposals.map((p) => p.id)).toEqual(['a']);
  });

  it('a null conversationId fetches nothing and returns an empty list', () => {
    const { result } = renderHook(() => useCopilotProposals(null));
    expect(result.current.proposals).toEqual([]);
    expect(listCopilotProposals).not.toHaveBeenCalled();
  });

  // The W4.1 refactor's core promise (architecture §1.8): the mutable state
  // moved into the shared proposalStore, but the panel's own behavior must
  // be unchanged — approve/reject still resolve through this hook's
  // `proposals`, scoped to its own conversation.
  it("approve resolves through the shared store and is reflected in this hook's own scoped list", async () => {
    jest
      .mocked(listCopilotProposals)
      .mockResolvedValue([proposal({ id: 'a', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'a', status: 'executed' }));

    const { result } = renderHook(() => useCopilotProposals('conv-1'));
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));

    await act(async () => {
      await result.current.approve('a');
    });

    expect(result.current.proposals[0].status).toBe('executed');
  });

  // The literal W4.1 accept criterion, at the hook level this time: two
  // independently-mounted consumers of the SAME conversation (standing in
  // for "the Copilot panel" and "an already-mounted Review screen" — W4.3's
  // actual Review screen isn't built yet, but it will read the same shared
  // store this hook already does) both see an approve fired from only one
  // of them, with only one network call.
  it('approving from one mounted hook instance updates a second, independently-rendered instance with no refetch', async () => {
    jest
      .mocked(listCopilotProposals)
      .mockResolvedValue([proposal({ id: 'a', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'a', status: 'executed' }));

    const panel = renderHook(() => useCopilotProposals('conv-1'));
    const reviewScreen = renderHook(() => useCopilotProposals('conv-1'));
    await waitFor(() => expect(panel.result.current.proposals).toHaveLength(1));
    await waitFor(() =>
      expect(reviewScreen.result.current.proposals).toHaveLength(1),
    );
    // Each instance fetched once on mount.
    expect(listCopilotProposals).toHaveBeenCalledTimes(2);

    await act(async () => {
      await panel.result.current.approve('a');
    });

    expect(approveCopilotProposal).toHaveBeenCalledTimes(1);
    expect(panel.result.current.proposals[0].status).toBe('executed');
    expect(reviewScreen.result.current.proposals[0].status).toBe('executed');
    // Still exactly one fetch each — the second instance never refetched to
    // learn about the approve.
    expect(listCopilotProposals).toHaveBeenCalledTimes(2);
  });

  it('switching conversationId scopes the list to the new conversation without clearing what the store holds for the old one', async () => {
    jest
      .mocked(listCopilotProposals)
      .mockImplementation(async (id: string) =>
        id === 'conv-1'
          ? [proposal({ id: 'a', conversationId: 'conv-1' })]
          : [proposal({ id: 'b', conversationId: 'conv-2' })],
      );

    const { result, rerender } = renderHook(
      ({ id }) => useCopilotProposals(id),
      {
        initialProps: { id: 'conv-1' as string | null },
      },
    );
    await waitFor(() =>
      expect(result.current.proposals.map((p) => p.id)).toEqual(['a']),
    );

    rerender({ id: 'conv-2' });
    await waitFor(() =>
      expect(result.current.proposals.map((p) => p.id)).toEqual(['b']),
    );
  });

  it('rejectAll POSTs the bulk endpoint then reloads the authoritative list', async () => {
    jest
      .mocked(listCopilotProposals)
      .mockResolvedValueOnce([proposal({ id: 'a', status: 'proposed' })]);
    const { result } = renderHook(() => useCopilotProposals('conv-1'));
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));

    jest.mocked(rejectAllCopilotProposals).mockResolvedValue({ rejected: 1 });
    jest
      .mocked(listCopilotProposals)
      .mockResolvedValueOnce([proposal({ id: 'a', status: 'rejected' })]);

    await act(async () => {
      await result.current.rejectAll();
    });

    expect(rejectAllCopilotProposals).toHaveBeenCalledWith('conv-1');
    expect(result.current.proposals[0].status).toBe('rejected');
  });

  it('buildOutcomePreamble summarizes resolved, unnotified proposals and markNotified stamps them', async () => {
    jest
      .mocked(listCopilotProposals)
      .mockResolvedValue([
        proposal({ id: 'a', status: 'executed', modelNotifiedAt: null }),
      ]);
    jest
      .mocked(markCopilotProposalsNotified)
      .mockResolvedValue({ notified: 1 });

    const { result } = renderHook(() => useCopilotProposals('conv-1'));
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));

    const preamble = result.current.buildOutcomePreamble();
    expect(preamble?.ids).toEqual(['a']);
    expect(preamble?.text).toContain('approved and executed');

    await act(async () => {
      await result.current.markNotified(['a']);
    });

    expect(markCopilotProposalsNotified).toHaveBeenCalledWith('conv-1', ['a']);
    expect(result.current.proposals[0].modelNotifiedAt).not.toBeNull();
    // Once notified, the same outcome must not be offered again.
    expect(result.current.buildOutcomePreamble()).toBeNull();
  });
});
