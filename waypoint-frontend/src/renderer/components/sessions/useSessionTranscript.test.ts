import { act, renderHook } from '@testing-library/react';
import { getChatUiRuntime } from '@/components/chat/chatUiRuntime';
import type { SessionBridge } from '@/data/live/sessionSource';
import type {
  LiveSnapshot,
  LiveUpdate,
  TopicClosedReason,
} from '@/types/engine';
import { useSessionTranscript } from './useSessionTranscript';

jest.mock('@/data/engineApi', () => ({
  engineSessionBridge: {},
  onEngineStatusChanged: jest.fn(() => () => {}),
  onRunChanged: jest.fn(() => () => {}),
  listPendingPrompts: jest.fn(async () => []),
}));
jest.mock('@/data/api', () => ({
  getAgentRunTranscript: jest.fn(async () => undefined),
  listAgentRunEvents: jest.fn(async () => []),
}));
const { onRunChanged, listPendingPrompts } = jest.requireMock(
  '@/data/engineApi',
) as { onRunChanged: jest.Mock; listPendingPrompts: jest.Mock };
const { listAgentRunEvents } = jest.requireMock('@/data/api') as {
  listAgentRunEvents: jest.Mock;
};

type Handlers = {
  onUpdate: (update: LiveUpdate) => void;
  onClosed: (reason: TopicClosedReason) => void;
};

/** A bridge with scripted snapshots per topic and a history answer. */
function fakeBridge(snapshots: Record<string, unknown>, history: unknown[]) {
  const subs = new Map<string, { topic: string; handlers: Handlers }>();
  const unsubscribed: string[] = [];
  let n = 0;
  const bridge: SessionBridge = {
    subscribeTopic: jest.fn(async (topic, handlers) => {
      n += 1;
      const id = `sub-${n}`;
      subs.set(id, { topic, handlers });
      return {
        subscriptionId: id,
        snapshot: {
          generation: 1,
          sequence: 0,
          timestamp: 1,
          data: snapshots[topic] ?? null,
        } as LiveSnapshot,
        unsubscribe: () => unsubscribed.push(id),
      };
    }),
    snapshotTopic: jest.fn(),
    call: jest.fn(async () => ({ turns: history, nextCursor: null })),
  };
  return { bridge, subs, unsubscribed };
}

const runtime = getChatUiRuntime() as unknown as {
  createChatState: jest.Mock;
  connectSession: jest.Mock;
};

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

beforeEach(() => jest.clearAllMocks());

describe('useSessionTranscript', () => {
  it('creates a chat state per run, follows the five topics, seeds history, and hands back the pending permissions, usage and config', async () => {
    const state = 'acp.session.state|{"conversationId":"run-a"}';
    const usage = 'acp.session.usage|{"conversationId":"run-a"}';
    const config = 'acp.session.config|{"conversationId":"run-a"}';
    const fb = fakeBridge(
      {
        [state]: {
          lifecycle: 'ready',
          isGenerating: true,
          pendingPermissions: [{ requestId: 'p1' }],
        },
        [usage]: { contextSize: 200_000, contextUsed: 18_000, cost: null },
        [config]: {
          modelOptions: null,
          efforts: null,
          modeOptions: {
            configId: 'mode',
            selected: 'default',
            available: [{ id: 'default', name: 'Default' }],
          },
          availableCommands: [],
        },
      },
      [{ id: 't1', seq: 1 }],
    );
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', { bridge: fb.bridge }),
    );
    await flush();

    expect(runtime.createChatState).toHaveBeenCalledTimes(1);
    expect(runtime.createChatState.mock.calls[0][1]).toEqual({
      uri: 'run:run-a',
    });
    expect(runtime.connectSession).toHaveBeenCalledTimes(1);
    const topics = (fb.bridge.subscribeTopic as jest.Mock).mock.calls
      .map((c) => c[0])
      .sort();
    expect(topics).toEqual(
      [
        'acp.session.activeTurn|{"conversationId":"run-a"}',
        'acp.session.plan|{"conversationId":"run-a"}',
        state,
        usage,
        config,
      ].sort(),
    );
    expect(fb.bridge.call).toHaveBeenCalledWith('acp.getHistory', {
      conversationId: 'run-a',
      limit: 100,
    });
    const chatState = runtime.createChatState.mock.results[0].value;
    expect(chatState.transcript.history.seed).toHaveBeenCalledWith([
      { id: 't1', seq: 1 },
    ]);
    // History is seeded BEFORE the live session is connected — chat-ui's
    // seed resets the active turn, so the other order wiped a turn in
    // flight (found live; commit 347a192). Connecting second lays the
    // follower's turn over the seeded history.
    expect(
      chatState.transcript.history.seed.mock.invocationCallOrder[0],
    ).toBeLessThan(runtime.connectSession.mock.invocationCallOrder[0]);
    // And every later seed puts the follower's turn back.
    expect(chatState.transcript.activeTurn.set).toHaveBeenCalled();
    expect(result.current.historyStatus).toEqual({ kind: 'ready' });
    expect(result.current.state).toBe(chatState);
    expect(result.current.pendingPermissions).toEqual([{ requestId: 'p1' }]);
    expect(result.current.isGenerating).toBe(true);
    expect(result.current.usage).toEqual({
      contextSize: 200_000,
      contextUsed: 18_000,
      cost: null,
    });
    expect(result.current.config?.modeOptions?.selected).toBe('default');
    expect(result.current.liveStatus).toEqual({ kind: 'live' });
  });

  it('re-reads history when a turn commits, reports a failed read, and disposes everything when the run changes', async () => {
    const fb = fakeBridge({}, []);
    const disconnect = jest.fn();
    runtime.connectSession.mockImplementation(() => disconnect);
    const { result, rerender } = renderHook(
      ({ id }) => useSessionTranscript(id, { bridge: fb.bridge }),
      { initialProps: { id: 'run-a' } },
    );
    await flush();
    expect(fb.bridge.call).toHaveBeenCalledTimes(1);

    const options = runtime.connectSession.mock.calls[0][2];
    act(() => options.onTurnCommitted());
    await flush();
    expect(fb.bridge.call).toHaveBeenCalledTimes(2);

    (fb.bridge.call as jest.Mock).mockRejectedValueOnce(
      new Error('acp.getHistory: conversation-not-found'),
    );
    await act(() => result.current.reloadHistory());
    expect(result.current.historyStatus).toEqual({
      kind: 'failed',
      message: 'acp.getHistory: conversation-not-found',
    });

    const first = runtime.createChatState.mock.results[0].value;
    rerender({ id: 'run-b' });
    await flush();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    // Five followers of run-a were released.
    expect(fb.unsubscribed).toHaveLength(5);
    expect(runtime.createChatState).toHaveBeenCalledTimes(2);
    expect(result.current.historyStatus).toEqual({ kind: 'ready' });
  });

  it('makes no unit while the run awaits its session, and a fresh one once it has it (W4)', async () => {
    const fb = fakeBridge({}, []);
    const disconnect = jest.fn();
    runtime.connectSession.mockImplementation(() => disconnect);
    const { result, rerender } = renderHook(
      ({ awaiting }) =>
        useSessionTranscript('run-a', {
          awaitingSession: awaiting,
          bridge: fb.bridge,
        }),
      { initialProps: { awaiting: true } },
    );
    await flush();
    // Provisioning: nothing subscribed, nothing read, no state to render.
    expect(result.current.state).toBeNull();
    expect(fb.bridge.subscribeTopic).not.toHaveBeenCalled();
    expect(fb.bridge.call).not.toHaveBeenCalled();
    expect(result.current.historyStatus).toEqual({ kind: 'loading' });

    // Running: the unit is made, history read, session connected.
    rerender({ awaiting: false });
    await flush();
    expect(runtime.createChatState).toHaveBeenCalledTimes(1);
    expect(fb.bridge.subscribeTopic).toHaveBeenCalledTimes(5);
    expect(fb.bridge.call).toHaveBeenCalledTimes(1);
    expect(result.current.state).not.toBeNull();

    // A resume passes through provisioning again: the old unit goes, and
    // the far side gets fresh followers and a fresh history read.
    rerender({ awaiting: true });
    await flush();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(fb.unsubscribed).toHaveLength(5);
    expect(result.current.state).toBeNull();
    rerender({ awaiting: false });
    await flush();
    expect(runtime.createChatState).toHaveBeenCalledTimes(2);
    expect(fb.bridge.call).toHaveBeenCalledTimes(2);
  });
});

describe('the kept transcript (ROAD-124)', () => {
  const { getAgentRunTranscript } = jest.requireMock('@/data/api') as {
    getAgentRunTranscript: jest.Mock;
  };
  const kept = [
    {
      id: 't1',
      seq: 1,
      initiator: 'user',
      items: [],
      outcome: { kind: 'done' },
    },
  ];

  it("seeds the ledger's snapshot when the daemon has no history — a killed session, a restarted daemon", async () => {
    getAgentRunTranscript.mockResolvedValueOnce({
      turns: kept,
      turnCount: 1,
      capturedAt: 'x',
    });
    const fb = fakeBridge({}, []);
    runtime.connectSession.mockImplementation(() => jest.fn());
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', { bridge: fb.bridge }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    expect(state.transcript.history.seed).toHaveBeenLastCalledWith(kept);
    expect(result.current.turnCount).toBe(1);
    expect(result.current.historyStatus).toEqual({ kind: 'ready' });
    expect(getAgentRunTranscript).toHaveBeenCalledWith('run-a');
  });

  it('also stands in when the daemon errors; without a snapshot the error is reported', async () => {
    const fb = fakeBridge({}, []);
    (fb.bridge.call as jest.Mock).mockRejectedValue(
      new Error('acp.getHistory: conversation-not-found'),
    );
    runtime.connectSession.mockImplementation(() => jest.fn());
    getAgentRunTranscript.mockResolvedValueOnce({
      turns: kept,
      turnCount: 1,
      capturedAt: 'x',
    });
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', { bridge: fb.bridge }),
    );
    await flush();
    expect(result.current.historyStatus).toEqual({ kind: 'ready' });
    expect(result.current.turnCount).toBe(1);

    getAgentRunTranscript.mockResolvedValueOnce(undefined);
    await act(() => result.current.reloadHistory());
    expect(result.current.historyStatus).toEqual({
      kind: 'failed',
      message: 'acp.getHistory: conversation-not-found',
    });
  });

  it("prefers the daemon's history when it has one", async () => {
    const live = [
      {
        id: 't9',
        seq: 9,
        initiator: 'user',
        items: [],
        outcome: { kind: 'done' },
      },
    ];
    const fb = fakeBridge({}, live);
    runtime.connectSession.mockImplementation(() => jest.fn());
    renderHook(() => useSessionTranscript('run-a', { bridge: fb.bridge }));
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    expect(state.transcript.history.seed).toHaveBeenLastCalledWith(live);
    expect(getAgentRunTranscript).not.toHaveBeenCalled();
  });
});

describe('the folded brief (W5a)', () => {
  const long = `You are working on ROAD-43…\n${'x'.repeat(400)}`;
  const briefTurn = {
    id: 't1',
    seq: 1,
    initiator: 'user',
    items: [
      { kind: 'message', id: 'm1', seq: 1, role: 'user', text: long },
      {
        kind: 'message',
        id: 'm2',
        seq: 2,
        role: 'assistant',
        text: 'reading…',
      },
    ],
  };

  it('seeds the placeholder, hands the brief back, and folds the live first turn the same way', async () => {
    const fb = fakeBridge({}, [briefTurn]);
    runtime.connectSession.mockImplementation(() => jest.fn());
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', {
        bridge: fb.bridge,
        foldBrief: { label: 'ROAD-43 · Investigate' },
      }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const seeded = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(seeded[0].items[0].text).toMatch(
      /^Brief for ROAD-43 · Investigate — \d+ lines/,
    );
    expect(seeded[0].items[1].text).toBe('reading…');
    expect(result.current.brief).toBe(long);

    expect(
      typeof runtime.connectSession.mock.calls[0][1].activeTurn.subscribe,
    ).toBe('function');
  });

  it('folds the live first turn while the agent is still on it (no history yet)', async () => {
    const fb = fakeBridge(
      {
        [`acp.session.activeTurn|${JSON.stringify({ conversationId: 'run-a' })}`]:
          briefTurn,
      },
      [],
    );
    runtime.connectSession.mockImplementation(() => jest.fn());
    renderHook(() =>
      useSessionTranscript('run-a', {
        bridge: fb.bridge,
        foldBrief: { label: 'ROAD-43 · Investigate' },
      }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const placed = state.transcript.activeTurn.set.mock.calls.at(-1)[0];
    expect(placed.items[0].text).toMatch(/^Brief for ROAD-43 · Investigate/);
    const source = runtime.connectSession.mock.calls[0][1];
    expect(source.activeTurn.getSnapshot().items[0].text).toMatch(
      /^Brief for ROAD-43/,
    );
  });

  it('without the option, the first message is left as it is', async () => {
    const fb = fakeBridge({}, [briefTurn]);
    runtime.connectSession.mockImplementation(() => jest.fn());
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', { bridge: fb.bridge }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const seeded = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(seeded[0].items[0].text).toBe(long);
    expect(result.current.brief).toBeNull();
  });
});

// Never-lock (design §5.3): the markers are laid over every seed, from
// the run's events, and the outbox rows are handed back; both are
// re-read when main says the run changed.
describe('markers and the outbox (never-lock)', () => {
  const turns = [
    {
      id: 't1',
      seq: 1,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'm1', seq: 1, role: 'user', text: 'fix it' },
        { kind: 'message', id: 'm2', seq: 2, role: 'assistant', text: 'done' },
      ],
    },
  ];
  const finalized = {
    runId: 'run-a',
    seq: 4,
    kind: 'finalized',
    payload: {
      sequence: 1,
      verdict: 'fixed',
      proposals: [],
      afterTurnId: 't1',
    },
    at: '2026-09-20T00:00:04.000Z',
  };

  it('seeds the history with the markers after their turns, and hands back the open outbox rows', async () => {
    listAgentRunEvents.mockResolvedValueOnce([finalized]);
    listPendingPrompts.mockResolvedValueOnce([
      { id: 'pp-1', state: 'queued', text: 'later' },
      { id: 'pp-2', state: 'delivered', text: 'gone' },
      { id: 'pp-3', state: 'dropped', text: 'gone too' },
    ]);
    const fb = fakeBridge({}, turns);
    runtime.connectSession.mockImplementation(() => jest.fn());
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', {
        bridge: fb.bridge,
        markerLabel: 'ROAD-1 · Fix',
      }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const seeded = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(seeded[0].items.map((i: { id: string }) => i.id)).toEqual([
      'm1',
      'm2',
      'marker:4',
    ]);
    expect(seeded[0].items[2]).toMatchObject({
      role: 'thought',
      text: 'Waypoint · Completed ROAD-1 · Fix · verdict fixed',
    });
    expect(result.current.pending.map((p) => p.id)).toEqual(['pp-1']);
    expect(listAgentRunEvents).toHaveBeenCalledWith('run-a');
    // The pending prompt is cleared BEFORE the seed: chat-ui builds a
    // row's component once, by role, and a seed that adds a marker where
    // the pending prompt's user card stood recycles that card for it
    // (found live: a marker drawn as a user bubble).
    expect(
      state.session.setPendingPrompt.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      state.transcript.history.seed.mock.invocationCallOrder.at(-1),
    );
  });

  it('re-reads the events on a run change for this run only, and re-seeds when a marker was added', async () => {
    const fb = fakeBridge({}, turns);
    runtime.connectSession.mockImplementation(() => jest.fn());
    renderHook(() =>
      useSessionTranscript('run-a', { bridge: fb.bridge, markerLabel: 'X' }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const seedsBefore = state.transcript.history.seed.mock.calls.length;
    const notify = onRunChanged.mock.calls[0][0] as (c: {
      runId: string;
      status: string;
    }) => void;

    // Another run: nothing read.
    await act(async () => notify({ runId: 'run-b', status: 'done' }));
    await flush();
    expect(listAgentRunEvents).toHaveBeenCalledTimes(1);

    // This run, no new marker: read, but not re-seeded.
    await act(async () => notify({ runId: 'run-a', status: 'running' }));
    await flush();
    expect(listAgentRunEvents).toHaveBeenCalledTimes(2);
    expect(state.transcript.history.seed.mock.calls.length).toBe(seedsBefore);

    // This run, a marker appeared: re-seeded with it.
    listAgentRunEvents.mockResolvedValueOnce([finalized]);
    await act(async () => notify({ runId: 'run-a', status: 'done' }));
    await flush();
    expect(state.transcript.history.seed.mock.calls.length).toBe(
      seedsBefore + 1,
    );
    const seeded = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(seeded[0].items.at(-1).id).toBe('marker:4');
  });

  it('without a marker label, the events are not read and the history is seeded as it is', async () => {
    const fb = fakeBridge({}, turns);
    runtime.connectSession.mockImplementation(() => jest.fn());
    renderHook(() => useSessionTranscript('run-a', { bridge: fb.bridge }));
    await flush();
    expect(listAgentRunEvents).not.toHaveBeenCalled();
    const state = runtime.createChatState.mock.results[0].value;
    const seeded = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(seeded[0].items).toHaveLength(2);
  });

  // Found in review: `onRunChanged` can fire several times back-to-back
  // for one run (design §7: a burst during an outbox drain) — an older,
  // slower-resolving refresh finishing AFTER a newer, faster one used to
  // just overwrite it, since only the torn-down-unit guard existed.
  it('an older, slower refresh never overwrites a newer one that resolved first', async () => {
    const olderFinalized = {
      ...finalized,
      seq: 4,
      payload: { ...finalized.payload, verdict: 'stale-in-flight' },
    };
    const newerFinalized = {
      ...finalized,
      seq: 9,
      payload: { ...finalized.payload, verdict: 'current' },
    };
    const fb = fakeBridge({}, turns);
    runtime.connectSession.mockImplementation(() => jest.fn());
    renderHook(() =>
      useSessionTranscript('run-a', { bridge: fb.bridge, markerLabel: 'X' }),
    );
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const notify = onRunChanged.mock.calls[0][0] as (c: {
      runId: string;
      status: string;
    }) => void;

    let resolveOlder: ((events: unknown[]) => void) | null = null;
    listAgentRunEvents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    );
    // The older call starts and hangs — not yet resolved.
    const older = act(async () =>
      notify({ runId: 'run-a', status: 'running' }),
    );

    // The newer call starts after it, and resolves first.
    listAgentRunEvents.mockResolvedValueOnce([newerFinalized]);
    await act(async () => notify({ runId: 'run-a', status: 'done' }));
    await flush();
    expect(
      state.transcript.history.seed.mock.calls.at(-1)[0][0].items.at(-1),
    ).toMatchObject({ text: expect.stringContaining('current') });

    // The older call finally resolves — its stale result must not win.
    resolveOlder!([olderFinalized]);
    await older;
    await flush();
    const lastSeed = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(lastSeed[0].items.at(-1)).toMatchObject({
      text: expect.stringContaining('current'),
    });
    expect(JSON.stringify(lastSeed)).not.toContain('stale-in-flight');
  });

  // Found in review, round 4: the guard above was given to refreshMarkers
  // only. loadHistory has three uncoordinated triggers on one unit (the
  // connect, every turn commit, onRunChanged's re-seed), two of which
  // coincide on every send and finalize — and the same older-resolves-
  // last race there wound the transcript back to stale turns.
  it('an older, slower history read never overwrites a newer one that resolved first', async () => {
    const olderTurns = [
      {
        id: 't1',
        seq: 1,
        initiator: 'user',
        items: [],
        stale: 'stale-history',
      },
    ];
    const newerTurns = [
      { id: 't1', seq: 1, initiator: 'user', items: [] },
      { id: 't2', seq: 2, initiator: 'user', items: [], fresh: 'current' },
    ];
    const fb = fakeBridge({}, []);
    runtime.connectSession.mockImplementation(() => jest.fn());
    renderHook(() => useSessionTranscript('run-a', { bridge: fb.bridge }));
    await flush();
    const state = runtime.createChatState.mock.results[0].value;
    const options = runtime.connectSession.mock.calls[0][2];

    let resolveOlder: ((page: unknown) => void) | null = null;
    (fb.bridge.call as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    );
    // A turn commit starts a read that hangs.
    const older = act(async () => options.onTurnCommitted());

    // A second commit starts a newer read, which resolves first.
    (fb.bridge.call as jest.Mock).mockResolvedValueOnce({
      turns: newerTurns,
      nextCursor: null,
    });
    await act(async () => options.onTurnCommitted());
    await flush();
    expect(state.transcript.history.seed.mock.calls.at(-1)[0]).toHaveLength(2);

    // The older read finally resolves — it must not seed.
    resolveOlder!({ turns: olderTurns, nextCursor: null });
    await older;
    await flush();
    const lastSeed = state.transcript.history.seed.mock.calls.at(-1)[0];
    expect(lastSeed).toHaveLength(2);
    expect(JSON.stringify(lastSeed)).not.toContain('stale-history');
  });
});
