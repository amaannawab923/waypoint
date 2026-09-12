import { applyPatches, enablePatches, type Patch } from 'immer';
import type {
  LiveSnapshot,
  LiveUpdate,
  TopicClosedReason,
} from '@/types/engine';

/**
 * A renderer-side follower of one daemon live topic — ROAD-60.
 *
 * The daemon's live models speak `@emdash/wire`'s protocol: a snapshot
 * `{generation, sequence, data}` and then updates `{generation,
 * baseSequence, sequence, delta}` where `delta` is a list of Immer patches
 * against the previous state. This follower keeps `data` current by
 * applying each update in order, and re-reads the snapshot whenever an
 * update cannot be applied in order — a `generation` the daemon reseeded,
 * a `baseSequence` that is not the sequence we hold (something was
 * missed), or a patch that does not fit. That is the same policy emdash's
 * own LiveFollower applies, without its instrumentation.
 *
 * The result is chat-ui's `LiveReadable<T>` (`getSnapshot` + `subscribe`
 * with a plain listener), which is what `connectSession` wants, plus a
 * `status` a panel can show: connecting → live → (stale during a resync)
 * → closed when the daemon went away. A closed follower is not retried on
 * its own — the sessions store reconnects when the engine reports running
 * again, so a stopped engine is one fact in one place, not N retry loops.
 *
 * Pure with respect to Electron: the bridge is injected, so every path is
 * a unit test with a fake bridge.
 */

enablePatches();

/** How long to wait before the one retry on "already attached". */
export const BUSY_RETRY_MS = 300;

export type LiveReadable<T> = {
  getSnapshot(): T | null | undefined;
  subscribe(listener: () => void): () => void;
};

export type FollowerStatus =
  | { kind: 'connecting' }
  | { kind: 'live' }
  /** An update did not fit; a fresh snapshot is on its way. */
  | { kind: 'stale' }
  | {
      kind: 'closed';
      reason: TopicClosedReason | { kind: 'error'; message: string };
    };

export interface TopicBridge {
  subscribeTopic(
    topic: string,
    handlers: {
      onUpdate: (update: LiveUpdate) => void;
      onClosed: (reason: TopicClosedReason) => void;
    },
  ): Promise<{
    subscriptionId: string;
    snapshot: LiveSnapshot;
    unsubscribe: () => void;
  }>;
  snapshotTopic(subscriptionId: string): Promise<LiveSnapshot>;
}

export interface LiveFollower<T> extends LiveReadable<T> {
  readonly topic: string;
  getStatus(): FollowerStatus;
  /** Fires on every value or status change. */
  subscribe(listener: () => void): () => void;
  /** Re-subscribe after `closed` (the engine came back). No-op otherwise. */
  reconnect(): void;
  dispose(): void;
}

export function createLiveFollower<T>(
  topic: string,
  bridge: TopicBridge,
): LiveFollower<T> {
  let value: T | undefined;
  let generation = -1;
  let sequence = -1;
  let status: FollowerStatus = { kind: 'connecting' };
  let subscriptionId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let resyncing = false;
  // Updates that arrive while a snapshot is on its way. Dropping them
  // meant one gap during a stream turned into a resync loop: the update
  // after the snapshot did not chain onto it, so another resync (found in
  // review). Kept in order and replayed onto the snapshot instead — the
  // rule emdash's own follower applies.
  let held: LiveUpdate[] = [];
  // Every subscribe/resync is a generation of its own; a late answer from
  // an earlier one (the topic closed and reopened meanwhile) is dropped.
  let attempt = 0;
  // One retry when the topic is still attached from a document or unit
  // that just went away — a rapid A → B → A switch, or a reload — before
  // the old attachment's release has landed in main.
  let retriedBusy = false;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const setStatus = (next: FollowerStatus) => {
    status = next;
    notify();
  };
  const applyInOrder = (update: LiveUpdate): boolean => {
    if (update.generation !== generation || update.baseSequence !== sequence)
      return false;
    try {
      value = applyPatches(value as object, update.delta as Patch[]) as T;
    } catch {
      return false;
    }
    sequence = update.sequence;
    return true;
  };

  const seed = (snapshot: LiveSnapshot) => {
    value = snapshot.data as T;
    generation = snapshot.generation;
    sequence = snapshot.sequence;
    resyncing = false;
    // Replay what arrived meanwhile: updates the snapshot already folds in
    // (same generation, sequence ≤ the snapshot's) are skipped; the rest
    // must chain. One that does not is dropped — the snapshot is the
    // authority at its cursor, and the next live update either chains or
    // asks for another snapshot; going again here could loop.
    const pending = held;
    held = [];
    for (const update of pending) {
      if (
        update.generation === snapshot.generation &&
        update.sequence <= snapshot.sequence
      )
        continue;
      if (!applyInOrder(update)) break;
    }
    setStatus({ kind: 'live' });
  };

  const resync = () => {
    if (resyncing || disposed || subscriptionId === null) return;
    resyncing = true;
    const myAttempt = attempt;
    const id = subscriptionId;
    if (status.kind !== 'stale') setStatus({ kind: 'stale' });
    bridge
      .snapshotTopic(id)
      .then((snapshot) => {
        if (disposed || myAttempt !== attempt) return;
        seed(snapshot);
      })
      .catch((error: unknown) => {
        if (disposed || myAttempt !== attempt) return;
        resyncing = false;
        setStatus({
          kind: 'closed',
          reason: {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  };

  const applyUpdate = (update: LiveUpdate) => {
    if (disposed || status.kind === 'closed') return;
    if (status.kind === 'stale') {
      held.push(update);
      return;
    }
    if (!applyInOrder(update)) {
      held.push(update);
      resync();
      return;
    }
    notify();
  };

  const connect = () => {
    if (disposed) return;
    attempt += 1;
    const myAttempt = attempt;
    setStatus({ kind: 'connecting' });
    bridge
      .subscribeTopic(topic, {
        onUpdate: (update) => {
          if (myAttempt === attempt) applyUpdate(update);
        },
        onClosed: (reason) => {
          if (myAttempt !== attempt) return;
          subscriptionId = null;
          unsubscribe = null;
          setStatus({ kind: 'closed', reason });
        },
      })
      .then((sub) => {
        if (disposed || myAttempt !== attempt) {
          sub.unsubscribe();
          return;
        }
        subscriptionId = sub.subscriptionId;
        unsubscribe = sub.unsubscribe;
        seed(sub.snapshot);
      })
      .catch((error: unknown) => {
        if (disposed || myAttempt !== attempt) return;
        const message = error instanceof Error ? error.message : String(error);
        if (/already attached/i.test(message) && !retriedBusy) {
          retriedBusy = true;
          setTimeout(() => {
            if (!disposed && myAttempt === attempt) connect();
          }, BUSY_RETRY_MS);
          return;
        }
        setStatus({ kind: 'closed', reason: { kind: 'error', message } });
      });
  };

  connect();

  return {
    topic,
    getSnapshot: () => value,
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect() {
      if (status.kind !== 'closed') return;
      connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      attempt += 1;
      unsubscribe?.();
      unsubscribe = null;
      subscriptionId = null;
      listeners.clear();
    },
  };
}
