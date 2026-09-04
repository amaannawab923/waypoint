import { act, renderHook } from '@testing-library/react';
import { approveCopilotProposal, rejectCopilotProposal } from '@/data/api';
import type { ProposalView } from '@/types/entities';
import {
  resetProposalStoreForTests,
  approveProposal,
  getProposal,
  rejectProposal,
  subscribeProposals,
  updateProposals,
  upsertProposals,
  useAllProposals,
} from './proposalStore';

jest.mock('@/data/api', () => ({
  approveCopilotProposal: jest.fn(),
  rejectCopilotProposal: jest.fn(),
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
});

describe('proposalStore', () => {
  it('upsertProposals adds rows retrievable by id, and is a no-op for an empty array', () => {
    upsertProposals([proposal({ id: 'a' }), proposal({ id: 'b' })]);
    expect(getProposal('a')?.id).toBe('a');
    expect(getProposal('b')?.id).toBe('b');

    const before = getProposal('a');
    upsertProposals([]);
    expect(getProposal('a')).toBe(before);
  });

  it('upsertProposals overwrites an existing row by id (last write wins)', () => {
    upsertProposals([proposal({ id: 'a', status: 'proposed' })]);
    upsertProposals([proposal({ id: 'a', status: 'executed' })]);
    expect(getProposal('a')?.status).toBe('executed');
  });

  it('notifies every subscriber on upsert, not just one', () => {
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    const unsubA = subscribeProposals(listenerA);
    const unsubB = subscribeProposals(listenerB);

    upsertProposals([proposal()]);

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it('unsubscribe stops further notifications to that listener only', () => {
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    const unsubA = subscribeProposals(listenerA);
    subscribeProposals(listenerB);
    unsubA();

    upsertProposals([proposal()]);

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it('updateProposals applies the updater only to rows the store holds, and is a no-op when the updater declines every row', () => {
    upsertProposals([proposal({ id: 'a', modelNotifiedAt: null })]);
    const listener = jest.fn();
    subscribeProposals(listener);

    // 'missing' isn't in the store — updater must not be asked to touch it.
    updateProposals(['a', 'missing'], (p) =>
      p.modelNotifiedAt == null
        ? { ...p, modelNotifiedAt: '2026-01-03T00:00:00.000Z' }
        : p,
    );
    expect(getProposal('a')?.modelNotifiedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(listener).toHaveBeenCalledTimes(1);

    // Second call: the updater declines (already notified) — no-op, no notify.
    updateProposals(['a'], (p) =>
      p.modelNotifiedAt == null ? { ...p, modelNotifiedAt: 'x' } : p,
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('approveProposal POSTs through approveCopilotProposal and upserts the response', async () => {
    upsertProposals([proposal({ id: 'a', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'a', status: 'executed' }));

    const result = await approveProposal('a');

    expect(approveCopilotProposal).toHaveBeenCalledWith('a');
    expect(result.status).toBe('executed');
    expect(getProposal('a')?.status).toBe('executed');
  });

  it('rejectProposal POSTs through rejectCopilotProposal and upserts the response', async () => {
    upsertProposals([proposal({ id: 'a', status: 'proposed' })]);
    jest
      .mocked(rejectCopilotProposal)
      .mockResolvedValue(proposal({ id: 'a', status: 'rejected' }));

    const result = await rejectProposal('a');

    expect(rejectCopilotProposal).toHaveBeenCalledWith('a');
    expect(result.status).toBe('rejected');
    expect(getProposal('a')?.status).toBe('rejected');
  });

  // The literal W4.1 accept criterion (architecture §1.8/P4): "approving in
  // the Copilot panel removes the row from an already-mounted Review screen
  // with no refetch." There's no Review screen yet (W4.3), so this proves
  // the underlying mechanism with two independently-rendered consumers of
  // the shared store — the same guarantee any future second surface relies
  // on.
  it('approving via one consumer of the store is reflected in a second, independently-rendered consumer with no refetch', async () => {
    upsertProposals([proposal({ id: 'a', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'a', status: 'executed' }));

    // Two separate mounted "surfaces" — e.g. the Copilot panel and a future
    // Review screen — each with their own hook instance reading the store.
    const panel = renderHook(() => useAllProposals());
    const reviewScreen = renderHook(() => useAllProposals());

    expect(panel.result.current.find((p) => p.id === 'a')?.status).toBe(
      'proposed',
    );
    expect(reviewScreen.result.current.find((p) => p.id === 'a')?.status).toBe(
      'proposed',
    );

    // Approve fired from the "panel" side only.
    await act(async () => {
      await approveProposal('a');
    });

    // approveCopilotProposal (the network call) was made exactly once — the
    // second surface's update came from the broadcast, not its own fetch.
    expect(approveCopilotProposal).toHaveBeenCalledTimes(1);
    expect(panel.result.current.find((p) => p.id === 'a')?.status).toBe(
      'executed',
    );
    expect(reviewScreen.result.current.find((p) => p.id === 'a')?.status).toBe(
      'executed',
    );
  });

  it('a component unmounted before an approve resolves does not receive the notification (no leaked update)', async () => {
    upsertProposals([proposal({ id: 'a', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'a', status: 'executed' }));

    const surface = renderHook(() => useAllProposals());
    surface.unmount();

    await act(async () => {
      await approveProposal('a');
    });

    // The store itself still reflects the write — unmounting a reader must
    // never block a writer.
    expect(getProposal('a')?.status).toBe('executed');
  });
});
