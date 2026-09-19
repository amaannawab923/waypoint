import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { AgentRun } from '@/types/agentRuns';
import { SessionTranscript } from './SessionTranscript';
import { useSessionTranscript } from './useSessionTranscript';

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

beforeEach(() => jest.clearAllMocks());

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
});
