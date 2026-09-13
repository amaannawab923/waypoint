import type {
  LiveSnapshot,
  LiveUpdate,
  TopicClosedReason,
} from '@/types/engine';
import {
  createSessionSource,
  sessionTopic,
  type SessionBridge,
} from './sessionSource';

type Handlers = {
  onUpdate: (update: LiveUpdate) => void;
  onClosed: (reason: TopicClosedReason) => void;
};

function fakeBridge(snapshots: Record<string, unknown>) {
  const subs = new Map<string, { topic: string; handlers: Handlers }>();
  let n = 0;
  const bridge: SessionBridge = {
    subscribeTopic: jest.fn(async (topic, handlers) => {
      n += 1;
      const subscriptionId = `sub-${n}`;
      subs.set(subscriptionId, { topic, handlers });
      return {
        subscriptionId,
        snapshot: {
          generation: 1,
          sequence: 0,
          timestamp: 1,
          data: snapshots[topic],
        } as LiveSnapshot,
        unsubscribe: jest.fn(),
      };
    }),
    snapshotTopic: jest.fn(),
    call: jest.fn(async () => ({ turns: [{ id: 't1' }], nextCursor: null })),
  };
  return {
    bridge,
    subs,
    closeAll: (reason: TopicClosedReason) =>
      subs.forEach((s) => s.handlers.onClosed(reason)),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sessionTopic', () => {
  it('builds the daemon’s keyed topic for a run’s conversation', () => {
    expect(sessionTopic('activeTurn', 'run-abc1234')).toBe(
      'acp.session.activeTurn|{"conversationId":"run-abc1234"}',
    );
    expect(sessionTopic('state', 'run-abc1234')).toBe(
      'acp.session.state|{"conversationId":"run-abc1234"}',
    );
  });
});

describe('createSessionSource', () => {
  it('follows activeTurn, plan and state for the conversation and exposes them as connectSession’s source', async () => {
    const fb = fakeBridge({
      [sessionTopic('activeTurn', 'run-a')]: null,
      [sessionTopic('plan', 'run-a')]: {
        id: 'session-plan',
        entries: [],
        updatedAt: 1,
      },
      [sessionTopic('state', 'run-a')]: {
        lifecycle: 'ready',
        pendingPermissions: [{ requestId: 'p1' }],
      },
    });

    const source = createSessionSource('run-a', fb.bridge);
    await flush();

    expect(
      (fb.bridge.subscribeTopic as jest.Mock).mock.calls
        .map((c) => c[0])
        .sort(),
    ).toEqual(
      [
        sessionTopic('activeTurn', 'run-a'),
        sessionTopic('plan', 'run-a'),
        sessionTopic('state', 'run-a'),
      ].sort(),
    );
    expect(source.connectSource.activeTurn.getSnapshot()).toBeNull();
    expect(source.connectSource.plan.getSnapshot()).toEqual({
      id: 'session-plan',
      entries: [],
      updatedAt: 1,
    });
    expect(source.connectSource.sessionState.getSnapshot()).toEqual({
      pendingPermissions: [{ requestId: 'p1' }],
    });
  });

  it('answers an empty permission list before the state snapshot has landed', () => {
    const fb = fakeBridge({});
    const source = createSessionSource('run-a', fb.bridge);

    expect(source.connectSource.sessionState.getSnapshot()).toEqual({
      pendingPermissions: [],
    });
  });

  it('loadHistory calls the allowlisted procedure with the conversation and a default page', async () => {
    const fb = fakeBridge({});
    const source = createSessionSource('run-a', fb.bridge);

    const page = await source.loadHistory();
    await source.loadHistory({ before: 17, limit: 10 });

    expect(page).toEqual({ turns: [{ id: 't1' }], nextCursor: null });
    expect(fb.bridge.call).toHaveBeenNthCalledWith(1, 'acp.getHistory', {
      conversationId: 'run-a',
      limit: 50,
    });
    expect(fb.bridge.call).toHaveBeenNthCalledWith(2, 'acp.getHistory', {
      conversationId: 'run-a',
      limit: 10,
      before: 17,
    });
  });

  it('reconnect re-subscribes every closed follower; dispose releases all three', async () => {
    const fb = fakeBridge({});
    const source = createSessionSource('run-a', fb.bridge);
    await flush();

    fb.closeAll({ kind: 'disconnected' });
    expect(source.activeTurn.getStatus().kind).toBe('closed');
    source.reconnect();
    await flush();

    expect(fb.bridge.subscribeTopic).toHaveBeenCalledTimes(6);
    expect(source.plan.getStatus().kind).toBe('live');

    source.dispose();
    const unsubscribes = [...fb.subs.keys()].slice(3);
    expect(unsubscribes).toHaveLength(3);
  });
});
