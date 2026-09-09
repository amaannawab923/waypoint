import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  detectLocalClaudeCode,
  getWorkspace,
  listDraftTickets,
  listNotifications,
  listProjects,
  listReviewQueue,
} from '@/data/api';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import {
  resetProposalStoreForTests,
  upsertProposals,
} from '@/lib/proposalStore';
import type { ProposalView } from '@/types/entities';
import { Sidebar } from './Sidebar';

// ROAD-13: the Review badge used to be seeded from a one-shot
// `getProposalCounts()` call whose result never changed after mount, so it
// froze at the app-launch count for the rest of the session. It now reads
// live off the shared proposalStore (lib/proposalStore.ts), the same store
// ReviewPage/useReviewQueue, the Copilot panel, and the ticket drawer's
// pending-proposals section already subscribe to — this file exercises that
// reactivity directly, without going through any of those other surfaces.
jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(),
  listProjects: jest.fn(),
  listReviewQueue: jest.fn(),
  listNotifications: jest.fn(),
  listDraftTickets: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ useLoadedJiraConnection: jest.fn() }));
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));
jest.mock('@/components/domain/AddProjectWizard', () => ({
  AddProjectWizard: () => null,
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

function mount() {
  jest
    .mocked(getWorkspace)
    .mockResolvedValue({ id: 'ws-1', name: 'Waypoint Labs' } as never);
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(listNotifications).mockResolvedValue([]);
  jest.mocked(listDraftTickets).mockResolvedValue([]);
  jest
    .mocked(detectLocalClaudeCode)
    .mockResolvedValue({ state: 'absent' } as never);
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

function reviewBadgeText(): string | null {
  const reviewLink = screen.getByRole('link', { name: /review/i });
  // AlertBadge renders nothing (no span at all) once count <= 0 — see
  // Sidebar.tsx's AlertBadge — so "no badge" reads as null here, not "0".
  return within(reviewLink).queryByText(/^\d+$/)?.textContent ?? null;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetProposalStoreForTests();
});

describe('Sidebar Review badge — live off the shared proposal store (ROAD-13)', () => {
  it('seeds from the workspace-wide proposed queue on mount, then updates live when a new proposal lands in the store — no remount, no extra fetch', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a' })],
      counts: { proposed: 1, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    mount();

    await screen.findByText('1');
    expect(reviewBadgeText()).toBe('1');
    expect(listReviewQueue).toHaveBeenCalledTimes(1);

    // A proposal created elsewhere (e.g. the Copilot panel reloading after
    // an agent run) lands in the shared store the same way it always has —
    // upsertProposals, no sidebar-specific plumbing.
    act(() => {
      upsertProposals([proposal({ id: 'b' })]);
    });

    expect(reviewBadgeText()).toBe('2');
    // The badge derives this from the store already broadcasting the
    // change — it must not have gone back to the network for it.
    expect(listReviewQueue).toHaveBeenCalledTimes(1);
  });

  it('drops the count when a proposal is approved or rejected from any surface, live', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a' }), proposal({ id: 'b' })],
      counts: { proposed: 2, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    mount();
    await screen.findByText('2');

    // Simulates an approve/reject fired from a wholly different mounted
    // surface (Review screen, ticket drawer, Copilot panel) — all of them
    // resolve through proposalStore's approveProposal/rejectProposal, which
    // upserts the resolved row into this same store.
    act(() => {
      upsertProposals([proposal({ id: 'a', status: 'executed' })]);
    });

    expect(reviewBadgeText()).toBe('1');
  });

  it('shows no badge once the store has no proposed proposals left', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a' })],
      counts: { proposed: 1, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    mount();
    await screen.findByText('1');

    act(() => {
      upsertProposals([proposal({ id: 'a', status: 'rejected' })]);
    });

    expect(reviewBadgeText()).toBeNull();
  });
});
