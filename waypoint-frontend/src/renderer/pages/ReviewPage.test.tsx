import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  listReviewQueue,
  getProposalCounts,
  getReviewHealthStats,
  listAgents,
  listProjects,
  bulkApproveProposals,
  bulkRejectProposals,
  approveCopilotProposal,
  rejectCopilotProposal,
} from '@/data/api';
import type { Agent, Project, ProposalView } from '@/types/entities';
import { resetProposalStoreForTests } from '@/lib/proposalStore';
import {
  getActiveSelectableView,
  __resetActiveSelectableViewForTests,
} from '@/lib/useActiveSelectableView';
import ReviewPage from './ReviewPage';

// W4.3 — ReviewPage's own accept-criterion coverage: the health strip's
// <10-decisions floor, bulk select + bulk action wiring (through the real
// bulk endpoints, not single-row approve/reject), the `e`/`r` shortcuts
// firing only while this screen is mounted and focus isn't in a text field,
// and the toolbar filters narrowing the underlying query.
jest.mock('@/data/api', () => ({
  listReviewQueue: jest.fn(),
  getProposalCounts: jest.fn(),
  getReviewHealthStats: jest.fn(),
  listAgents: jest.fn(),
  listProjects: jest.fn(),
  bulkApproveProposals: jest.fn(),
  bulkRejectProposals: jest.fn(),
  approveCopilotProposal: jest.fn(),
  rejectCopilotProposal: jest.fn(),
}));

// Only `id`/`name` are ever read by ReviewPage's filter dropdowns — cast
// rather than filling in every unrelated Agent/Project field.
function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: 'agent-1', name: 'Code Reviewer', ...overrides } as Agent;
}
function project(overrides: Partial<Project> = {}): Project {
  return { id: 'proj-1', name: 'Compass Web', ...overrides } as Project;
}

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-1',
    conversationId: null,
    kind: 'state_change',
    ticketId: 'wi-1',
    payload: { stateId: 'st-done' },
    snapshot: {
      identifier: 'LAUNCH-3',
      title: 'Nav breaks on iPad',
      toStateName: 'Done',
    },
    anchorSeq: null,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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

const EMPTY_COUNTS = { proposed: 0, blocked: 0, recent: 0 };
const NOT_ENOUGH_DATA = {
  decisionCount: 3,
  approvalRate: null,
  medianDecisionMs: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  resetProposalStoreForTests();
  __resetActiveSelectableViewForTests();
  jest.mocked(listAgents).mockResolvedValue([agent()]);
  jest.mocked(listProjects).mockResolvedValue([project()]);
  jest.mocked(getReviewHealthStats).mockResolvedValue(NOT_ENOUGH_DATA);
  jest.mocked(getProposalCounts).mockResolvedValue(EMPTY_COUNTS);
  jest.mocked(listReviewQueue).mockResolvedValue({
    proposals: [],
    counts: EMPTY_COUNTS,
    nextCursor: null,
  });
});

describe('ReviewPage', () => {
  it('renders the three segments with their counts and defaults to Waiting on you', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal()],
      counts: { proposed: 6, blocked: 2, recent: 12 },
      nextCursor: null,
    });

    render(<ReviewPage />);

    await waitFor(() =>
      expect(screen.getByText('1 waiting on you')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('tab', { name: /Waiting on you\s*6/ }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('tab', { name: /Blocked\s*2/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /Ran overnight\s*12/ }),
    ).toBeInTheDocument();
  });

  it('switching to Blocked shows the "nothing blocked" empty state, not a broken one', async () => {
    render(<ReviewPage />);
    await waitFor(() => expect(listReviewQueue).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: /Blocked/ }));

    await waitFor(() =>
      expect(listReviewQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'blocked' }),
      ),
    );
    expect(await screen.findByText('Nothing blocked')).toBeInTheDocument();
  });

  it('the health strip shows "not enough decisions" below the 10-decision floor', async () => {
    render(<ReviewPage />);
    expect(
      await screen.findByText(/Not enough decisions yet/),
    ).toBeInTheDocument();
  });

  it('the health strip shows the rate and median once at or above 10 decisions', async () => {
    jest.mocked(getReviewHealthStats).mockResolvedValue({
      decisionCount: 14,
      approvalRate: 0.86,
      medianDecisionMs: 5200,
    });

    render(<ReviewPage />);

    expect(await screen.findByText('86%')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(
      screen.queryByText(/Not enough decisions yet/),
    ).not.toBeInTheDocument();
  });

  it('an Agent filter selection narrows the query and clears any selection', async () => {
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [proposal({ id: 'a' })],
      counts: { proposed: 1, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    render(<ReviewPage />);
    await waitFor(() =>
      expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent: All/ }));
    fireEvent.click(await screen.findByText('Code Reviewer'));

    await waitFor(() =>
      expect(listReviewQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'proposed', agentId: 'agent-1' }),
      ),
    );
    expect(
      screen.getByRole('button', { name: /Agent: Code Reviewer/ }),
    ).toBeInTheDocument();
  });

  describe('bulk select + bulk actions', () => {
    beforeEach(() => {
      jest.mocked(listReviewQueue).mockResolvedValue({
        proposals: [proposal({ id: 'a' }), proposal({ id: 'b' })],
        counts: { proposed: 2, blocked: 0, recent: 0 },
        nextCursor: null,
      });
    });

    it('checking two rows shows the bulk bar with the right count, and Clear empties it', async () => {
      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByLabelText('Select proposal a'));
      fireEvent.click(screen.getByLabelText('Select proposal b'));
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Clear'));
      expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    });

    it('"Approve selected" calls the real bulk-approve endpoint with exactly the checked ids', async () => {
      jest.mocked(bulkApproveProposals).mockResolvedValue([
        { id: 'a', status: 'executed', statusReason: null },
        { id: 'b', status: 'executed', statusReason: null },
      ]);

      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByLabelText('Select proposal a'));
      fireEvent.click(screen.getByLabelText('Select proposal b'));
      await act(async () => {
        fireEvent.click(screen.getByText('Approve selected'));
      });

      expect(bulkApproveProposals).toHaveBeenCalledWith(['a', 'b']);
      expect(approveCopilotProposal).not.toHaveBeenCalled();
      // Approving drops both rows out of the proposed segment view.
      await waitFor(() =>
        expect(
          screen.queryByLabelText('Select proposal a'),
        ).not.toBeInTheDocument(),
      );
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it('"Reject selected" calls the real bulk-reject endpoint', async () => {
      jest
        .mocked(bulkRejectProposals)
        .mockResolvedValue([
          { id: 'a', status: 'rejected', statusReason: null },
        ]);

      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByLabelText('Select proposal a'));
      await act(async () => {
        fireEvent.click(screen.getByText('Reject selected'));
      });

      expect(bulkRejectProposals).toHaveBeenCalledWith(['a']);
      expect(rejectCopilotProposal).not.toHaveBeenCalled();
    });

    it('"e" bulk-approves the current selection, "r" bulk-rejects it', async () => {
      jest
        .mocked(bulkApproveProposals)
        .mockResolvedValue([
          { id: 'a', status: 'executed', statusReason: null },
        ]);
      jest
        .mocked(bulkRejectProposals)
        .mockResolvedValue([
          { id: 'b', status: 'rejected', statusReason: null },
        ]);

      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByLabelText('Select proposal a'));
      await act(async () => {
        fireEvent.keyDown(document, { key: 'e' });
      });
      expect(bulkApproveProposals).toHaveBeenCalledWith(['a']);

      fireEvent.click(screen.getByLabelText('Select proposal b'));
      await act(async () => {
        fireEvent.keyDown(document, { key: 'r' });
      });
      expect(bulkRejectProposals).toHaveBeenCalledWith(['b']);
    });

    it('does nothing on "e"/"r" when nothing is selected', async () => {
      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );

      fireEvent.keyDown(document, { key: 'e' });
      fireEvent.keyDown(document, { key: 'r' });

      expect(bulkApproveProposals).not.toHaveBeenCalled();
      expect(bulkRejectProposals).not.toHaveBeenCalled();
    });

    // Scoping check: a shortcut key typed into an ordinary text field (a
    // stand-in for any input elsewhere on the screen) must not trigger a
    // bulk action just because the Review screen happens to be mounted.
    it('ignores "e"/"r" typed into a text field even with a selection', async () => {
      render(
        <div>
          <input aria-label="stray input" />
          <ReviewPage />
        </div>,
      );
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByLabelText('Select proposal a'));

      const input = screen.getByLabelText('stray input');
      fireEvent.keyDown(input, { key: 'e' });
      fireEvent.keyDown(input, { key: 'r' });

      expect(bulkApproveProposals).not.toHaveBeenCalled();
      expect(bulkRejectProposals).not.toHaveBeenCalled();
    });

    it('stops listening for "e"/"r" once the screen unmounts', async () => {
      const { unmount } = render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByLabelText('Select proposal a'));

      unmount();
      fireEvent.keyDown(document, { key: 'e' });

      expect(bulkApproveProposals).not.toHaveBeenCalled();
    });
  });

  // W5.4: ReviewPage registers itself as the app-shell keyboard layer's
  // "active selectable view" (useActiveSelectableView.ts) so ⌘A can reach
  // it — additive to the e/r listener above, exercised through the
  // registry directly rather than mounting the whole global hook (see
  // useGlobalKeyboardShortcuts.test.tsx for that hook's own ⌘A dispatch
  // coverage).
  describe('active-view registration (W5.4)', () => {
    beforeEach(() => {
      jest.mocked(listReviewQueue).mockResolvedValue({
        proposals: [proposal({ id: 'a' }), proposal({ id: 'b' })],
        counts: { proposed: 2, blocked: 0, recent: 0 },
        nextCursor: null,
      });
    });

    it("registers a view whose selectAll selects every proposal in the 'proposed' segment", async () => {
      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );

      const view = getActiveSelectableView();
      expect(view).not.toBeNull();

      act(() => {
        view?.selectAll();
      });

      expect(screen.getByText('2 selected')).toBeInTheDocument();
    });

    it('selectAll no-ops on segments with no checkboxes (e.g. Blocked)', async () => {
      render(<ReviewPage />);
      await waitFor(() => expect(listReviewQueue).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('tab', { name: /Blocked/ }));
      await waitFor(() =>
        expect(listReviewQueue).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'blocked' }),
        ),
      );

      act(() => {
        getActiveSelectableView()?.selectAll();
      });

      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("the registered view's clear() empties the selection", async () => {
      render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByLabelText('Select proposal a'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      act(() => {
        getActiveSelectableView()?.clear();
      });

      expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    });

    it('unregisters on unmount, leaving no active view behind', async () => {
      const { unmount } = render(<ReviewPage />);
      await waitFor(() =>
        expect(screen.getByLabelText('Select proposal a')).toBeInTheDocument(),
      );
      expect(getActiveSelectableView()).not.toBeNull();

      unmount();

      expect(getActiveSelectableView()).toBeNull();
    });
  });
});
