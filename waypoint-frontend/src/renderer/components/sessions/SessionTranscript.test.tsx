import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AgentRun } from '@/types/agentRuns';
import { sendPrompt } from '@/data/engineApi';
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
const mockSendPrompt = sendPrompt as jest.Mock;

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
    reconnect: jest.fn(),
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

// ROAD-XXX: resume dead sessions — the composer stays open for a
// resumable (dead) run, and a send that fails for any reason (a rejected
// promise, or a resolved-but-undelivered outcome) must leave the typed
// text in the box, not just log a toast and clear it.
describe('SessionTranscript — resume on message', () => {
  function withComposerSlot() {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    fakeView.composerSlot = slot;
    return () => document.body.removeChild(slot);
  }

  it.each(['interrupted', 'failed', 'cancelled'] as const)(
    'the composer stays enabled for a %s run, with the resume placeholder',
    (status) => {
      const cleanup = withComposerSlot();
      mockUseSessionTranscript.mockReturnValue(
        hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
      );
      render(<SessionTranscript run={run({ status })} />);

      const box = screen.getByLabelText('Message this session');
      expect(box).not.toBeDisabled();
      expect(box).toHaveAttribute(
        'placeholder',
        'Sending will resume this session in the same worktree…',
      );
      cleanup();
    },
  );

  it.each(['done', 'needs-review', 'provisioning', 'queued'] as const)(
    'the composer stays disabled for a %s run',
    (status) => {
      const cleanup = withComposerSlot();
      mockUseSessionTranscript.mockReturnValue(
        hookState({ historyStatus: { kind: 'ready' }, turnCount: 3 }),
      );
      render(<SessionTranscript run={run({ status })} />);

      expect(screen.getByLabelText('Message this session')).toBeDisabled();
      cleanup();
    },
  );

  it('a resumable run with no worktree left disables the composer with an honest reason, distinct from "ended"', () => {
    const cleanup = withComposerSlot();
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
    );
    render(
      <SessionTranscript
        run={run({ status: 'failed', cwd: null, worktreePath: null })}
      />,
    );

    const box = screen.getByLabelText('Message this session');
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute(
      'placeholder',
      'This run has no worktree left to resume on.',
    );
    cleanup();
  });

  // hookState()'s default `state` is a bare `{id}` stand-in — fine for the
  // earlier tests, which never actually call onSend, but onSend itself
  // needs `state.session.setPendingPrompt`, so these two tests supply a
  // fuller fake.
  const fakeState = () =>
    ({
      id: 'run-abc1234',
      session: { setPendingPrompt: jest.fn() },
    }) as unknown as ReturnType<typeof useSessionTranscript>['state'];

  it('a send that resolves worktree-gone keeps the typed text in the box — resolved, not rejected, but still undelivered', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'worktree-gone',
      status: 'failed',
    });
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        turnCount: 0,
        state: fakeState(),
      }),
    );
    render(<SessionTranscript run={run({ status: 'failed' })} />);

    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'still there?' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });

    expect(mockSendPrompt).toHaveBeenCalledWith('run-abc1234', 'still there?');
    // The text was NOT cleared — SessionComposer only clears on a
    // fulfilled onSend, and SessionTranscript's onSend must have thrown
    // for this outcome even though the sendPrompt promise itself resolved.
    expect(box).toHaveValue('still there?');
    cleanup();
  });

  it('a send that succeeds after reviving a replaced-by-new session clears the text and warns about lost context', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'resumed-and-sent',
      status: 'running',
      resume: 'replaced-by-new',
    });
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        turnCount: 0,
        state: fakeState(),
      }),
    );
    render(<SessionTranscript run={run({ status: 'cancelled' })} />);

    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'hello again' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });

    expect(box).toHaveValue('');
    cleanup();
  });

  // Live-discovered (manual walkthrough, ROAD-XXX): `resuming` correctly
  // keeps the transcript's followers alive across a message-triggered
  // resume instead of tearing them down, but that means nothing else ever
  // told them to reconnect — they were last left `closed` on the session
  // that died, and the daemon's new one went unheard until a manual
  // reload. `reconnect` is the fix; this pins it firing exactly on a
  // successful resume, not on an ordinary live send.
  it('a send that revives the run reconnects the transcript followers, left closed on the dead session', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'resumed-and-sent',
      status: 'running',
      resume: 'loaded',
    });
    const reconnect = jest.fn();
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        turnCount: 0,
        state: fakeState(),
        reconnect,
      }),
    );
    render(<SessionTranscript run={run({ status: 'interrupted' })} />);

    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'still there?' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });

    expect(reconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('an ordinary send on a live run never reconnects — nothing died to reconnect to', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'sent',
      status: 'running',
    });
    const reconnect = jest.fn();
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        turnCount: 3,
        state: fakeState(),
        reconnect,
      }),
    );
    render(<SessionTranscript run={run({ status: 'running' })} />);

    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'another turn' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });

    expect(reconnect).not.toHaveBeenCalled();
    cleanup();
  });
});
