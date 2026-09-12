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
}));

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
  it('creates a chat state per run, follows the four topics, seeds history, and hands back the pending permissions and usage', async () => {
    const state = 'acp.session.state|{"conversationId":"run-a"}';
    const usage = 'acp.session.usage|{"conversationId":"run-a"}';
    const fb = fakeBridge(
      {
        [state]: {
          lifecycle: 'ready',
          isGenerating: true,
          pendingPermissions: [{ requestId: 'p1' }],
        },
        [usage]: { contextSize: 200_000, contextUsed: 18_000, cost: null },
      },
      [{ id: 't1', seq: 1 }],
    );
    const { result } = renderHook(() =>
      useSessionTranscript('run-a', fb.bridge),
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
    expect(result.current.historyStatus).toEqual({ kind: 'ready' });
    expect(result.current.state).toBe(chatState);
    expect(result.current.pendingPermissions).toEqual([{ requestId: 'p1' }]);
    expect(result.current.isGenerating).toBe(true);
    expect(result.current.usage).toEqual({
      contextSize: 200_000,
      contextUsed: 18_000,
      cost: null,
    });
    expect(result.current.liveStatus).toEqual({ kind: 'live' });
  });

  it('re-reads history when a turn commits, reports a failed read, and disposes everything when the run changes', async () => {
    const fb = fakeBridge({}, []);
    const disconnect = jest.fn();
    runtime.connectSession.mockImplementation(() => disconnect);
    const { result, rerender } = renderHook(
      ({ id }) => useSessionTranscript(id, fb.bridge),
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
    // Four followers of run-a were released.
    expect(fb.unsubscribed).toHaveLength(4);
    expect(runtime.createChatState).toHaveBeenCalledTimes(2);
    expect(result.current.historyStatus).toEqual({ kind: 'ready' });
  });
});
