import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AgentRun, AgentRunStatus } from '@/types/agentRuns';
import {
  dropPendingPrompt,
  retryPendingPrompt,
  sendPrompt,
  warmRun,
} from '@/data/engineApi';
import { useSessionsSnapshot } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import { SessionTranscript } from './SessionTranscript';
import { useSessionTranscript } from './useSessionTranscript';
// chatUiRuntime is mapped to this mock by jest (package.json
// moduleNameMapper) — see ChatTranscript.test.tsx for the same pattern.
// `fakeView` is what the real ChatTranscript hands back through `onReady`,
// so it's what SessionTranscript's own slot state ends up holding.
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
jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));
jest.mock('@/data/engineApi', () => ({
  cancelTurn: jest.fn(),
  resolvePermission: jest.fn(),
  sendPrompt: jest.fn(),
  // Pending by default: the warm-up's own settle is exercised where it
  // matters (the placeholder test), and nowhere else updates state
  // after a test's own act.
  warmRun: jest.fn(() => new Promise(() => {})),
  retryPendingPrompt: jest.fn(),
  dropPendingPrompt: jest.fn(async () => {}),
}));

const mockUseSessionTranscript = useSessionTranscript as jest.Mock;
const mockUseSessionsSnapshot = useSessionsSnapshot as jest.Mock;
const mockSendPrompt = sendPrompt as jest.Mock;
const mockWarmRun = warmRun as jest.Mock;
const mockRetry = retryPendingPrompt as jest.Mock;
const mockDrop = dropPendingPrompt as jest.Mock;
const mockToast = showErrorToast as jest.Mock;

const ALL_STATUSES: AgentRunStatus[] = [
  'queued',
  'provisioning',
  'running',
  'blocked',
  'finishing',
  'needs-review',
  'done',
  'interrupted',
  'failed',
  'cancelled',
];

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

// hookState()'s default `state` is a bare `{id}` stand-in; onSend needs
// `state.session.setPendingPrompt`, so the send tests use this one.
const fakeState = () =>
  ({
    id: 'run-abc1234',
    session: { setPendingPrompt: jest.fn() },
  }) as unknown as ReturnType<typeof useSessionTranscript>['state'];

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
    pending: [],
    refreshPending: jest.fn(async () => {}),
    ...over,
  } as unknown as ReturnType<typeof useSessionTranscript>;
}

function withComposerSlot() {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  fakeView.composerSlot = slot;
  return () => document.body.removeChild(slot);
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeView.composerSlot = null;
  mockUseSessionsSnapshot.mockReturnValue({ engine: undefined });
});

// Never-lock (2026-09-20; the founder: "there's no approval for locking
// any session in any scenario ever"). The composer is mounted, enabled
// and typeable for every status the ledger has, with or without turns,
// with or without a chat-ui slot, with the engine up or down.
describe('SessionTranscript — the composer is never locked', () => {
  it.each(ALL_STATUSES)(
    'the composer is mounted and typeable for a %s run with no turns and no slot',
    (status) => {
      mockUseSessionTranscript.mockReturnValue(
        hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
      );
      render(<SessionTranscript run={run({ status })} />);
      const box = screen.getByLabelText('Message this session');
      expect(box).not.toBeDisabled();
      fireEvent.change(box, { target: { value: 'still here' } });
      expect(box).toHaveValue('still here');
    },
  );

  it.each(ALL_STATUSES)(
    'a %s run with zero turns and the engine DOWN still has the box open — only Send is held',
    (status) => {
      mockUseSessionsSnapshot.mockReturnValue({ engine: { kind: 'stopped' } });
      mockUseSessionTranscript.mockReturnValue(
        hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
      );
      render(<SessionTranscript run={run({ status })} />);
      const box = screen.getByLabelText('Message this session');
      expect(box).not.toBeDisabled();
      expect(box).toHaveAttribute(
        'placeholder',
        expect.stringMatching(/engine is not running/),
      );
      fireEvent.change(box, { target: { value: 'for later' } });
      expect(screen.getByLabelText('Send')).toBeDisabled();
    },
  );

  it('the composer is mounted while a start is awaited (no chat state yet)', () => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({ state: null, historyStatus: { kind: 'loading' } }),
    );
    render(<SessionTranscript run={run({ status: 'provisioning' })} />);
    expect(screen.getByText('Starting the session…')).toBeInTheDocument();
    const box = screen.getByLabelText('Message this session');
    expect(box).not.toBeDisabled();
    expect(box).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/your message goes with it/),
    );
  });

  it('never renders the words that used to lock it', () => {
    ALL_STATUSES.forEach((status) => {
      mockUseSessionTranscript.mockReturnValue(
        hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
      );
      const { container, unmount } = render(
        <SessionTranscript run={run({ status })} />,
      );
      expect(container.textContent).not.toMatch(
        /has ended|nothing to resume|cannot be resumed|Nothing to show/i,
      );
      expect(container.querySelectorAll('textarea[disabled]')).toHaveLength(0);
      unmount();
    });
  });

  it('a run with no activity yet says so above a canvas that stays put, composer included', () => {
    const cleanup = withComposerSlot();
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 0 }),
    );
    render(<SessionTranscript run={run({ status: 'done' })} />);
    expect(
      screen.getByText(/No activity in this session yet/),
    ).toHaveTextContent(/Message it to continue/);
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
    expect(screen.getByLabelText('Message this session')).not.toBeDisabled();
    cleanup();
  });

  // Found in review: chat-ui's own slot usually arrives a beat after the
  // first render (its mount effect runs after the parent's), so this
  // transition — no slot yet, then a real one — happens on essentially
  // every session-tab open, not a rare edge case. The old
  // `composerSlot ? createPortal(...) : dock` switched between a bare
  // child and a portal at the same JSX position — a type change React
  // remounts across — which reset the composer (lost focus, lost the
  // in-progress keystroke) the instant the slot showed up.
  it('the composer keeps its identity — focus, in-progress text — across the transition from no chat-ui slot to a real one', () => {
    fakeView.composerSlot = null;
    mockUseSessionTranscript.mockReturnValue(
      hookState({ historyStatus: { kind: 'ready' }, turnCount: 2 }),
    );
    const { rerender } = render(
      <SessionTranscript run={run({ status: 'running' })} />,
    );
    const before = screen.getByLabelText('Message this session');
    fireEvent.change(before, { target: { value: 'still typing' } });
    before.focus();
    expect(document.activeElement).toBe(before);

    // chat-ui's slot shows up; a re-render is all that takes (SessionTranscript
    // reads `ready.view.composerSlot` fresh each render — see its own comment).
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    fakeView.composerSlot = slot;
    rerender(<SessionTranscript run={run({ status: 'running' })} />);

    const after = screen.getByLabelText('Message this session');
    expect(after).toBe(before); // the very same DOM node — no remount
    expect(document.activeElement).toBe(after);
    expect(after).toHaveValue('still typing');
    expect(slot.contains(after)).toBe(true);

    document.body.removeChild(slot);
  });

  it.each([
    ['loading', { historyStatus: { kind: 'loading' }, turnCount: 0 }],
    ['live', { turnCount: 0, liveStatus: { kind: 'live' } }],
    ['active turn', { turnCount: 0, hasActiveTurn: true }],
    ['turns', { turnCount: 3 }],
    [
      'outbox rows',
      {
        turnCount: 0,
        pending: [
          {
            id: 'pp-1',
            runId: 'run-abc1234',
            seq: 1,
            text: 'waiting',
            reason: 'starting',
            state: 'queued',
            autoAttempts: 0,
            lastError: null,
          },
        ],
      },
    ],
  ] as const)('the no-activity line is not shown over %s', (_name, over) => {
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        historyStatus: { kind: 'ready' },
        ...(over as Partial<ReturnType<typeof useSessionTranscript>>),
      }),
    );
    render(
      <SessionTranscript
        run={run({ status: _name === 'live' ? 'running' : 'cancelled' })}
      />,
    );
    expect(screen.queryByText(/No activity in this session yet/)).toBeNull();
  });
});

describe('SessionTranscript — what a send does, said in the placeholder', () => {
  it('a finished run says "Connecting…" while it warms, then that a message continues it; a working run says a follow-up is queued', async () => {
    let settleWarm: () => void = () => {};
    mockWarmRun.mockImplementationOnce(
      () =>
        new Promise<{ kind: 'warmed'; loaded: boolean }>((resolve) => {
          settleWarm = () => resolve({ kind: 'warmed', loaded: true });
        }),
    );
    mockUseSessionTranscript.mockReturnValue(hookState({ turnCount: 2 }));
    const { rerender } = render(
      <SessionTranscript run={run({ status: 'done' })} />,
    );
    const box = screen.getByLabelText('Message this session');
    expect(box).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/Connecting/),
    );
    expect(box).not.toBeDisabled();
    await act(async () => settleWarm());
    expect(screen.getByLabelText('Message this session')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/continue it/),
    );
    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 2, isGenerating: true }),
    );
    rerender(<SessionTranscript run={run({ status: 'running' })} />);
    expect(screen.getByLabelText('Message this session')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/Add a follow-up/),
    );
  });

  it('warms the session on open for a run that is not live — once per run — and never for a live one', () => {
    mockUseSessionTranscript.mockReturnValue(hookState({ turnCount: 2 }));
    const { rerender } = render(
      <SessionTranscript run={run({ status: 'done' })} />,
    );
    expect(mockWarmRun).toHaveBeenCalledWith('run-abc1234');
    rerender(<SessionTranscript run={run({ status: 'done', turnCount: 3 })} />);
    expect(mockWarmRun).toHaveBeenCalledTimes(1);
    mockWarmRun.mockClear();
    render(
      <SessionTranscript
        run={run({ id: 'run-live0001', status: 'running' })}
      />,
    );
    expect(mockWarmRun).not.toHaveBeenCalled();
  });

  // Found in review: the warm-up effect's dependency array used to be
  // `[run.id, engineDown]` — neither changes across a queued/provisioning
  // run progressing to a terminal status, so a pane opened early (the
  // one case most likely to be watched start-to-finish) never warmed at
  // all for that mount; the one invocation the old deps gave it was
  // spent on the early-return branch.
  it('warms once the run leaves queued/provisioning — a pane opened early is not warmed forever', () => {
    mockUseSessionTranscript.mockReturnValue(hookState({ turnCount: 0 }));
    const { rerender } = render(
      <SessionTranscript run={run({ id: 'run-early001', status: 'queued' })} />,
    );
    expect(mockWarmRun).not.toHaveBeenCalled();

    rerender(
      <SessionTranscript run={run({ id: 'run-early001', status: 'done' })} />,
    );
    expect(mockWarmRun).toHaveBeenCalledWith('run-early001');
    expect(mockWarmRun).toHaveBeenCalledTimes(1);
  });

  // Found in review: neither of the warm-up effect's early returns reset
  // `warming` — a warm cycle still in flight when the run turns live and
  // idle (a resume landing before the daemon reports `isGenerating`)
  // stranded the placeholder on "Connecting…" for a session that was
  // actually already up and answering.
  it('does not strand the placeholder on "Connecting…" once the run turns live while a warm-up is still in flight', () => {
    mockWarmRun.mockImplementationOnce(() => new Promise(() => {})); // never settles
    mockUseSessionTranscript.mockReturnValue(hookState({ turnCount: 2 }));
    const { rerender } = render(
      <SessionTranscript run={run({ id: 'run-stuck001', status: 'done' })} />,
    );
    expect(screen.getByLabelText('Message this session')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/Connecting/),
    );

    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 2, isGenerating: false }),
    );
    rerender(
      <SessionTranscript
        run={run({ id: 'run-stuck001', status: 'running' })}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    const placeholder = box.getAttribute('placeholder');
    expect(placeholder ?? '').not.toMatch(/Connecting/);
  });
});

describe('SessionTranscript — every send lands somewhere', () => {
  // Found in review: the outcome-specific tests below (outboxed,
  // cancelled-mid-resume, continued, …) only drove 4 of the 10 statuses
  // between them. onSend's own switch reads only `result.outcome`, never
  // `run.status` — so this is deliberately complementary, not redundant:
  // it proves every status can even REACH a send at all (never held back
  // by the composer itself), not that each status maps to a particular
  // outcome, which is main's call, not the renderer's.
  it.each(ALL_STATUSES)(
    'a %s run can always attempt a send — sendPrompt is reached with the text',
    async (status) => {
      const cleanup = withComposerSlot();
      mockSendPrompt.mockResolvedValueOnce({ outcome: 'sent', status });
      mockUseSessionTranscript.mockReturnValue(
        hookState({ turnCount: 1, state: fakeState() }),
      );
      render(<SessionTranscript run={run({ status })} />);
      const box = screen.getByLabelText('Message this session');
      fireEvent.change(box, { target: { value: `hello from ${status}` } });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Send'));
      });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        'run-abc1234',
        `hello from ${status}`,
      );
      cleanup();
    },
  );

  it('outboxed: the box is cleared, the strip shows the row, and the outbox is re-read', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'outboxed',
      status: 'done',
      pending: { id: 'pp-1', reason: 'starting', state: 'queued' },
    });
    const refreshPending = jest.fn(async () => {});
    const state = fakeState();
    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 0, state, refreshPending }),
    );
    render(<SessionTranscript run={run({ status: 'done' })} />);

    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'while starting' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(mockSendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'while starting',
    );
    expect(box).toHaveValue('');
    // The transcript's own pending prompt would claim the daemon has it.
    expect(state!.session.setPendingPrompt).toHaveBeenLastCalledWith(null);
    expect(refreshPending).toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    cleanup();
  });

  it('cancelled-mid-resume: the text comes back to the box with a toast saying so', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'cancelled-mid-resume',
      status: 'cancelled',
    });
    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 0, state: fakeState() }),
    );
    render(<SessionTranscript run={run({ status: 'failed' })} />);

    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'still there?' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(box).toHaveValue('still there?');
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringMatching(/back in the box/),
    );
    cleanup();
  });

  it.each(['continued', 'resumed-and-sent'] as const)(
    '%s: the followers, left closed on the ended session, are reconnected',
    async (outcome) => {
      const cleanup = withComposerSlot();
      mockSendPrompt.mockResolvedValueOnce({
        outcome,
        status: 'running',
        resume: 'loaded',
      });
      const reconnect = jest.fn();
      mockUseSessionTranscript.mockReturnValue(
        hookState({ turnCount: 0, state: fakeState(), reconnect }),
      );
      render(<SessionTranscript run={run({ status: 'done' })} />);
      const box = screen.getByLabelText('Message this session');
      fireEvent.change(box, { target: { value: 'one more thing' } });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Send'));
      });
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(box).toHaveValue('');
      cleanup();
    },
  );

  it('replaced-by-new warns that the prior conversation was not restored', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'resumed-and-sent',
      status: 'running',
      resume: 'replaced-by-new',
    });
    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 0, state: fakeState() }),
    );
    render(<SessionTranscript run={run({ status: 'cancelled' })} />);
    fireEvent.change(screen.getByLabelText('Message this session'), {
      target: { value: 'hello again' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringMatching(/could not restore the previous conversation/),
    );
    cleanup();
  });

  it('an ordinary send on a live run never reconnects — nothing ended to reconnect to', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockResolvedValueOnce({
      outcome: 'sent',
      status: 'running',
    });
    const reconnect = jest.fn();
    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 3, state: fakeState(), reconnect }),
    );
    render(<SessionTranscript run={run({ status: 'running' })} />);
    fireEvent.change(screen.getByLabelText('Message this session'), {
      target: { value: 'another turn' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(reconnect).not.toHaveBeenCalled();
    cleanup();
  });

  it('a rejected send keeps the text and says why', async () => {
    const cleanup = withComposerSlot();
    mockSendPrompt.mockRejectedValueOnce(
      new Error('The engine is not running.'),
    );
    mockUseSessionTranscript.mockReturnValue(
      hookState({ turnCount: 0, state: fakeState() }),
    );
    render(<SessionTranscript run={run({ status: 'done' })} />);
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'keep me' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(box).toHaveValue('keep me');
    expect(mockToast).toHaveBeenCalledWith('The engine is not running.');
    cleanup();
  });
});

describe('SessionTranscript — the outbox strip', () => {
  const rows = [
    {
      id: 'pp-1',
      runId: 'run-abc1234',
      seq: 1,
      byMemberId: 'mem-1',
      text: 'first, waiting',
      reason: 'spawn-failed',
      state: 'queued',
      autoAttempts: 3,
      lastError: 'auth expired',
      claimedAt: null,
      resolvedAt: null,
      createdAt: '2026-09-20T00:00:00Z',
    },
    {
      id: 'pp-2',
      runId: 'run-abc1234',
      seq: 2,
      byMemberId: 'mem-1',
      text: 'second, behind it',
      reason: 'starting',
      state: 'unresolved',
      autoAttempts: 0,
      lastError: null,
      claimedAt: null,
      resolvedAt: null,
      createdAt: '2026-09-20T00:00:01Z',
    },
  ] as const;

  it('shows each waiting message with its reason; Resend on the first, Discard on each', async () => {
    const cleanup = withComposerSlot();
    const refreshPending = jest.fn(async () => {});
    mockRetry.mockResolvedValueOnce({ outcome: 'sent', status: 'running' });
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        turnCount: 1,
        state: fakeState(),
        pending: rows as unknown as never[],
        refreshPending,
      }),
    );
    render(<SessionTranscript run={run({ status: 'failed' })} />);
    expect(screen.getByText('first, waiting')).toBeInTheDocument();
    expect(
      screen.getByText(/could not be started \(auth expired\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/could not tell whether this reached the agent/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Resend')).toHaveLength(1);
    expect(screen.getAllByText('Discard')).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByText('Resend'));
    });
    expect(mockRetry).toHaveBeenCalledWith('run-abc1234');
    expect(refreshPending).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getAllByText('Discard')[1]);
    });
    expect(mockDrop).toHaveBeenCalledWith('run-abc1234', 'pp-2');
    cleanup();
  });

  // Found in review: every PendingPromptReason had a unit test for its
  // sentence (sessionStatus.test.ts), but never one through the actual
  // OutboxStrip the person sees — this renders each reason for real and
  // checks its sentence lands in the DOM.
  it.each([
    ['starting', /session is starting/],
    ['finishing', /filing the run's report/],
    ['folder-missing', /folder is not on disk/],
    ['repository-missing', /repository is not linked/],
    ['spawn-failed', /agent could not be started/],
    ['owner-offline', /Waypoint; it is sent when they are online/],
    ['blocked-by-earlier', /behind an earlier message/],
  ] as const)('renders the real sentence for reason %s', (reason, expected) => {
    const cleanup = withComposerSlot();
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        turnCount: 1,
        pending: [
          {
            id: 'pp-r',
            runId: 'run-abc1234',
            seq: 1,
            byMemberId: 'mem-1',
            text: 'a waiting message',
            reason,
            state: 'queued',
            autoAttempts: 0,
            lastError: null,
            claimedAt: null,
            resolvedAt: null,
            createdAt: '2026-09-20T00:00:00Z',
          },
        ] as unknown as never[],
      }),
    );
    render(<SessionTranscript run={run({ status: 'failed' })} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
    cleanup();
  });

  it('a `sending` row (a crash-recovery check in flight) reads "Checking…", never its stale original reason', () => {
    const cleanup = withComposerSlot();
    mockUseSessionTranscript.mockReturnValue(
      hookState({
        turnCount: 1,
        pending: [
          {
            id: 'pp-s',
            runId: 'run-abc1234',
            seq: 1,
            byMemberId: 'mem-1',
            text: 'was it delivered?',
            reason: 'starting',
            state: 'sending',
            autoAttempts: 0,
            lastError: null,
            claimedAt: null,
            resolvedAt: null,
            createdAt: '2026-09-20T00:00:00Z',
          },
        ] as unknown as never[],
      }),
    );
    render(<SessionTranscript run={run({ status: 'running' })} />);
    expect(
      screen.getByText(/Checking whether this reached the agent/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/session is starting/)).toBeNull();
    cleanup();
  });
});

describe('SessionTranscript — the mode picker (feedback round 1)', () => {
  const config = {
    modelOptions: null,
    efforts: null,
    modeOptions: {
      configId: 'mode',
      selected: 'plan',
      available: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan Mode' },
        { id: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    },
    availableCommands: [],
  };

  it('an Investigate never offers Bypass Permissions; a Fix still does', () => {
    mockUseSessionTranscript.mockReturnValue(hookState({ config } as never));
    const { unmount } = render(
      <SessionTranscript
        run={run({ status: 'running', intent: 'investigate' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    const investigate = screen.getByLabelText('All modes') as HTMLSelectElement;
    expect([...investigate.options].map((o) => o.value)).toEqual([
      'default',
      'plan',
    ]);
    unmount();

    mockUseSessionTranscript.mockReturnValue(hookState({ config } as never));
    render(
      <SessionTranscript
        run={run({ status: 'running', intent: 'fix', autoApprove: true })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    const fix = screen.getByLabelText('All modes') as HTMLSelectElement;
    expect([...fix.options].map((o) => o.value)).toContain('bypassPermissions');
    // An auto-approve Fix's "May edit files" is the bypass mode.
    expect(
      screen
        .getByRole('button', { name: 'May edit files' })
        .getAttribute('title'),
    ).toMatch(/^Never asks/);
  });
});
