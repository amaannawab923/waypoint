import type {
  LiveSnapshot,
  LiveUpdate,
  TopicClosedReason,
} from '@/types/engine';
import {
  BUSY_RETRY_MS,
  createLiveFollower,
  type TopicBridge,
} from './liveFollower';

type Handlers = {
  onUpdate: (update: LiveUpdate) => void;
  onClosed: (reason: TopicClosedReason) => void;
};

/** A bridge the test drives: hand out snapshots, push updates, close topics. */
function fakeBridge() {
  const subs = new Map<string, { topic: string; handlers: Handlers }>();
  let n = 0;
  let nextSnapshot: LiveSnapshot = {
    generation: 1,
    sequence: 0,
    timestamp: 1,
    data: { items: [] },
  };
  const unsubscribed: string[] = [];
  const bridge: TopicBridge = {
    subscribeTopic: jest.fn(async (topic, handlers) => {
      n += 1;
      const subscriptionId = `sub-${n}`;
      subs.set(subscriptionId, { topic, handlers });
      return {
        subscriptionId,
        snapshot: nextSnapshot,
        unsubscribe: () => unsubscribed.push(subscriptionId),
      };
    }),
    snapshotTopic: jest.fn(async () => nextSnapshot),
  };
  return {
    bridge,
    unsubscribed,
    setSnapshot: (s: LiveSnapshot) => {
      nextSnapshot = s;
    },
    push: (id: string, update: LiveUpdate) =>
      subs.get(id)!.handlers.onUpdate(update),
    close: (id: string, reason: TopicClosedReason) =>
      subs.get(id)!.handlers.onClosed(reason),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const TOPIC = 'acp.session.activeTurn|{"conversationId":"run-a"}';

describe('createLiveFollower', () => {
  it('starts connecting, seeds from the first snapshot, and reports live', async () => {
    const { bridge } = fakeBridge();
    const follower = createLiveFollower<{ items: string[] }>(TOPIC, bridge);
    const seen: string[] = [];
    follower.subscribe(() => seen.push(follower.getStatus().kind));

    expect(follower.getStatus()).toEqual({ kind: 'connecting' });
    expect(follower.getSnapshot()).toBeUndefined();
    await flush();

    expect(follower.getStatus()).toEqual({ kind: 'live' });
    expect(follower.getSnapshot()).toEqual({ items: [] });
    expect(seen).toEqual(['live']);
    expect(bridge.subscribeTopic).toHaveBeenCalledWith(
      TOPIC,
      expect.anything(),
    );
  });

  it('applies in-order Immer patches and notifies once per update', async () => {
    const fb = fakeBridge();
    const follower = createLiveFollower<{ items: string[] }>(TOPIC, fb.bridge);
    await flush();
    const notified = jest.fn();
    follower.subscribe(notified);

    fb.push('sub-1', {
      generation: 1,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [{ op: 'add', path: ['items', 0], value: 'a' }],
    });
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 1,
      sequence: 2,
      timestamp: 3,
      delta: [{ op: 'add', path: ['items', 1], value: 'b' }],
    });

    expect(follower.getSnapshot()).toEqual({ items: ['a', 'b'] });
    expect(notified).toHaveBeenCalledTimes(2);
    expect(fb.bridge.snapshotTopic).not.toHaveBeenCalled();
  });

  it('re-reads the snapshot on a sequence gap, holds the updates that arrive meanwhile, and replays the ones the snapshot does not fold in', async () => {
    const fb = fakeBridge();
    const follower = createLiveFollower<{ items: string[] }>(TOPIC, fb.bridge);
    await flush();
    fb.setSnapshot({
      generation: 1,
      sequence: 5,
      timestamp: 9,
      data: { items: ['fresh'] },
    });
    const statuses: string[] = [];
    follower.subscribe(() => statuses.push(follower.getStatus().kind));

    // sequence 0 held, but this update is based on 3: something was missed.
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 3,
      sequence: 4,
      timestamp: 2,
      delta: [],
    });
    expect(follower.getStatus()).toEqual({ kind: 'stale' });
    // Folded into the snapshot (sequence 5 ≤ 5): skipped on replay.
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 4,
      sequence: 5,
      timestamp: 2,
      delta: [{ op: 'add', path: ['items', 0], value: 'folded' }],
    });
    // After the snapshot's cursor: replayed onto it.
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 5,
      sequence: 6,
      timestamp: 3,
      delta: [{ op: 'add', path: ['items', 1], value: 'after' }],
    });
    await flush();

    expect(fb.bridge.snapshotTopic).toHaveBeenCalledWith('sub-1');
    expect(fb.bridge.snapshotTopic).toHaveBeenCalledTimes(1);
    expect(follower.getSnapshot()).toEqual({ items: ['fresh', 'after'] });
    expect(follower.getStatus()).toEqual({ kind: 'live' });
    expect(statuses).toEqual(['stale', 'live']);
    // And the chain continues from the replayed update.
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 6,
      sequence: 7,
      timestamp: 4,
      delta: [{ op: 'add', path: ['items', 2], value: 'next' }],
    });
    expect(follower.getSnapshot()).toEqual({
      items: ['fresh', 'after', 'next'],
    });
    expect(fb.bridge.snapshotTopic).toHaveBeenCalledTimes(1);
  });

  it('retries once, after a beat, when the topic is still attached from a document that just went away', async () => {
    jest.useFakeTimers();
    try {
      const fb = fakeBridge();
      (fb.bridge.subscribeTopic as jest.Mock).mockRejectedValueOnce(
        new Error(
          'Topic "acp.session.activeTurn|…" is already attached on this Wire client',
        ),
      );
      const follower = createLiveFollower(TOPIC, fb.bridge);
      await jest.advanceTimersByTimeAsync(1);
      expect(follower.getStatus()).toEqual({ kind: 'connecting' });
      await jest.advanceTimersByTimeAsync(BUSY_RETRY_MS + 5);
      expect(follower.getStatus()).toEqual({ kind: 'live' });
      expect(fb.bridge.subscribeTopic).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-reads the snapshot on a generation change and on a patch that does not fit', async () => {
    const fb = fakeBridge();
    const follower = createLiveFollower<{ items: string[] }>(TOPIC, fb.bridge);
    await flush();

    fb.push('sub-1', {
      generation: 2,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [],
    });
    await flush();
    expect(fb.bridge.snapshotTopic).toHaveBeenCalledTimes(1);

    // Back live at generation 1 / sequence 0 (the fake's default). A patch
    // into a path that does not exist cannot be applied → resync again.
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [{ op: 'replace', path: ['nope', 'deep', 3], value: 1 }],
    });
    await flush();
    expect(fb.bridge.snapshotTopic).toHaveBeenCalledTimes(2);
    expect(follower.getStatus()).toEqual({ kind: 'live' });
  });

  it('reports closed with the daemon’s reason, and reconnect() subscribes afresh', async () => {
    const fb = fakeBridge();
    const follower = createLiveFollower<{ items: string[] }>(TOPIC, fb.bridge);
    await flush();

    fb.close('sub-1', { kind: 'disconnected' });
    expect(follower.getStatus()).toEqual({
      kind: 'closed',
      reason: { kind: 'disconnected' },
    });
    // The old value stays readable while closed — a panel keeps showing
    // the last known transcript rather than blanking.
    expect(follower.getSnapshot()).toEqual({ items: [] });

    fb.setSnapshot({
      generation: 7,
      sequence: 0,
      timestamp: 1,
      data: { items: ['again'] },
    });
    follower.reconnect();
    expect(follower.getStatus()).toEqual({ kind: 'connecting' });
    await flush();
    expect(follower.getStatus()).toEqual({ kind: 'live' });
    expect(follower.getSnapshot()).toEqual({ items: ['again'] });
    expect(fb.bridge.subscribeTopic).toHaveBeenCalledTimes(2);
    // An update from the dead subscription is ignored; one from the live one applies.
    fb.push('sub-1', {
      generation: 7,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [{ op: 'add', path: ['items', 1], value: 'stale-sub' }],
    });
    fb.push('sub-2', {
      generation: 7,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [{ op: 'add', path: ['items', 1], value: 'live-sub' }],
    });
    expect(follower.getSnapshot()).toEqual({ items: ['again', 'live-sub'] });
  });

  it('reconnect() is a no-op unless closed', async () => {
    const fb = fakeBridge();
    const follower = createLiveFollower<{ items: string[] }>(TOPIC, fb.bridge);
    await flush();
    follower.reconnect();
    expect(fb.bridge.subscribeTopic).toHaveBeenCalledTimes(1);
  });

  it('a refused subscribe is closed with the sentence main sent', async () => {
    const fb = fakeBridge();
    (fb.bridge.subscribeTopic as jest.Mock).mockRejectedValueOnce(
      new Error('The agent engine is not running.'),
    );
    const follower = createLiveFollower(TOPIC, fb.bridge);
    await flush();

    expect(follower.getStatus()).toEqual({
      kind: 'closed',
      reason: { kind: 'error', message: 'The agent engine is not running.' },
    });
  });

  it('dispose unsubscribes, drops late answers and stops notifying', async () => {
    const fb = fakeBridge();
    const follower = createLiveFollower(TOPIC, fb.bridge);
    await flush();
    const listener = jest.fn();
    follower.subscribe(listener);

    follower.dispose();
    fb.push('sub-1', {
      generation: 1,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [],
    });

    expect(fb.unsubscribed).toEqual(['sub-1']);
    expect(listener).not.toHaveBeenCalled();

    // Disposed before the subscribe answered: the answer is released, not kept.
    const late = fakeBridge();
    const early = createLiveFollower(TOPIC, late.bridge);
    early.dispose();
    await flush();
    expect(late.unsubscribed).toEqual(['sub-1']);
  });
});
