import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { AgentRun } from '@/types/agentRuns';
import { SessionTranscript } from './SessionTranscript';
import { useSessionTranscript } from './useSessionTranscript';
// chatUiRuntime is mapped to this mock by jest (package.json
// moduleNameMapper) — see ChatTranscript.test.tsx for the same pattern.
// `fakeView` is what the real ChatTranscript hands back through `onReady`,
// so it's what SessionTranscript's own `view` state ends up holding.
import { fakeView } from '../../../../.erb/mocks/chatUiRuntimeMock';

// The transcript's own data — history, live status, the followers — is
// useSessionTranscript's job and has its own tests; here the hook is
// stubbed so each case controls exactly what the pane renders from
// (turnCount, historyStatus, state) without driving the real bridge.
jest.mock('./useSessionTranscript', () => ({
  useSessionTranscript: jest.fn(),
}));
jest.mock('@/lib/sessionsStore', () => ({
  useSessionsSnapshot: jest.fn(() => ({ engine: undefined })),
  refreshSessions: jest.fn(async () => {}),
}));
jest.mock('@/data/engineApi', () => ({
  cancelTurn: jest.fn(),
  resolvePermission: jest.fn(),
  sendPrompt: jest.fn(),
}));

const mockUseSessionTranscript = useSessionTranscript as jest.Mock;

const run = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: 'run-abc1234',
    status: 'done',
    providerId: 'claude',
    entry: 'independent',
    ticketId: null,
    projectId: 'proj-1',
    title: null,
    isolation: 'worktree',
    cwd: '/wt/run-abc1234',
    autoApprove: false,
    branch: 'session/abc1234',
    baseRef: 'main',
    worktreePath: '/wt/run-abc1234',
    errorKind: null,
    errorMessage: null,
    prUrl: null,
    createdAt: '2026-09-12T10:00:00Z',
    startedAt: null,
    updatedAt: '2026-09-12T10:00:00Z',
    ...over,
  }) as AgentRun;

/** A stand-in for the hook's return, one field overridden at a time. */
function hookState(over: Partial<ReturnType<typeof useSessionTranscript>>) {
  return {
    context: { dispose: jest.fn() },
    state: { id: 'run-abc1234' },
    historyStatus: { kind: 'ready' },
    turnCount: 0,
    hasActiveTurn: false,
    brief: null,
    pendingPermissions: [],
    usage: null,
    liveStatus: { kind: 'closed', reason: { kind: 'ended' } },
    isGenerating: false,
    queuedCount: 0,
    reloadHistory: jest.fn(async () => {}),
    ...over,
  } as unknown as ReturnType<typeof useSessionTranscript>;
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeView.composerSlot = null;
});

describe('SessionTranscript — empty transcript state', () => {
  it('shows the empty-state message for a session that ended with zero turns', () => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
    );
    render(<SessionTranscript run={run({ status: 'done' })} />);

    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
    expect(
      screen.getByText(
        "This session ended before any activity — there's no transcript to show.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('chat-transcript')).not.toBeInTheDocument();
  });

  it('does not show the empty state, and keeps rendering the transcript, once the run has turns', () => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 3 }),
    );
    render(<SessionTranscript run={run({ status: 'done' })} />);

    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
  });

  it('does not show the empty state while the history read is still in flight', () => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'loading' }, turnCount: 0 }),
    );
    render(<SessionTranscript run={run({ status: 'done' })} />);

    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
  });

  it('does not show the empty state for a live run that has simply not produced a turn yet', () => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        turnCount: 0,
        liveStatus: { kind: 'live' },
      }),
    );
    render(<SessionTranscript run={run({ status: 'running' })} />);

    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
  });

  it('does not show the empty state while a turn is still in flight, even once the run has ended', () => {
    // A run can flip to a non-live ledger status (cancelled here) before the
    // turn it was mid-way through finishes committing to history — the
    // daemon's own activeTurn follower is still the more current signal in
    // that window than the ledger's turnCount, which lags behind it.
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        turnCount: 0,
        hasActiveTurn: true,
      }),
    );
    render(<SessionTranscript run={run({ status: 'cancelled' })} />);

    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
  });

  it('does not show the empty state for an interrupted run — it has not ended, it is just unreachable', () => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
    );
    render(<SessionTranscript run={run({ status: 'interrupted' })} />);

    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
  });

  it('hides the composer dock once the empty state takes over, and restores it once the run has turns again', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    fakeView.composerSlot = slot;

    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 3 }),
    );
    const { rerender } = render(
      <SessionTranscript run={run({ status: 'running' })} />,
    );
    expect(screen.getByLabelText('Message this session')).toBeInTheDocument();

    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
    );
    rerender(<SessionTranscript run={run({ status: 'done' })} />);
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Message this session'),
    ).not.toBeInTheDocument();

    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 3 }),
    );
    rerender(<SessionTranscript run={run({ status: 'done' })} />);
    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message this session')).toBeInTheDocument();

    document.body.removeChild(slot);
  });
});
