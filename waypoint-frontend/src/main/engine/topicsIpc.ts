import type { EngineSupervisor } from './supervisor';
import { SNAPSHOT_TIMEOUT_MS } from './runs/daemonApi';
import {
  ALLOWED_PROCEDURES,
  ENGINE_IPC,
  EngineCallError,
  isAllowedTopic,
  type LiveSnapshot,
  type LiveUpdate,
  type TopicClosedReason,
  type TopicSubscription,
  type Unsubscribe,
  type WireClient,
} from './types';

/**
 * The renderer's window onto the daemon's live models and a few of its
 * procedures — ROAD-60.
 *
 * Main keeps the Wire client (supervisor.ts); the renderer keeps the
 * transcript UI (components/chat/). Between them: one `subscribe` per
 * topic the renderer wants, answered with the first snapshot and followed
 * by every update the daemon pushes, until `unsubscribe` or the daemon
 * goes away — at which point the renderer is told (`topicClosed`) rather
 * than left holding a subscription that will never update again. A
 * `snapshot` re-read on an existing subscription is the resync the
 * follower asks for when an update's `baseSequence` does not match.
 *
 * Narrow on purpose: isAllowedTopic and ALLOWED_PROCEDURES (types.ts) are
 * the whole surface. The renderer is this app's own code, but IPC is an
 * input to the privileged process, and a topic name is a string — the
 * same posture jiraIpc.ts and proposalApproval.ts take with their ids.
 *
 * Electron-free (`ipcMain`, `webContents` are injected) so every path
 * here is a unit test.
 */

export interface TopicsIpcHost {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  /** Push to the current window; a no-op when there is none. */
  send(channel: string, payload: unknown): void;
  /**
   * Fires when the renderer document that held the subscriptions is gone
   * — a reload, a full navigation, a crashed renderer. Its followers never
   * unsubscribed (there was no one left to), and the Wire client holds one
   * attachment per topic, so the next document's subscribe to the same
   * topic would be refused with ALREADY_EXISTS (found live: reload the
   * panel, and every transcript said "not live"). Every attachment is
   * released, silently — there is no document to tell.
   */
  onRendererGone?(callback: () => void): Unsubscribe;
}

export interface TopicsIpcDeps {
  supervisor: EngineSupervisor;
  host: TopicsIpcHost;
  logger: { warn: (m: string, meta?: Record<string, unknown>) => void };
  /** Test seam; defaults to an incrementing id. */
  mintId?: () => string;
}

interface Attachment {
  topic: string;
  detach: Unsubscribe | null;
  /** The client this attachment lives on; a different client means a reconnect. */
  client: WireClient;
}

export class TopicNotAllowedError extends Error {
  constructor(topic: string) {
    super(`Topic is not available to the renderer: ${topic}`);
    this.name = 'TopicNotAllowedError';
  }
}
export class ProcedureNotAllowedError extends Error {
  constructor(procedure: string) {
    super(`Procedure is not available to the renderer: ${procedure}`);
    this.name = 'ProcedureNotAllowedError';
  }
}
export class EngineNotRunningError extends Error {
  constructor() {
    super('The agent engine is not running.');
    this.name = 'EngineNotRunningError';
  }
}

function assertTopic(topic: unknown): string {
  if (typeof topic !== 'string' || !isAllowedTopic(topic)) {
    throw new TopicNotAllowedError(String(topic));
  }
  return topic;
}

function assertSubscriptionId(id: unknown): string {
  if (typeof id !== 'string' || !/^sub-\d+$/.test(id))
    throw new Error(`Not a subscription id: ${String(id)}`);
  return id;
}

/**
 * Attach and resolve with the first snapshot, wiring updates and terminal
 * errors to the callbacks. Shared by subscribe and snapshot (resync), which
 * is what keeps the two from drifting.
 */
function attachTopic<T>(
  client: WireClient,
  topic: string,
  callbacks: {
    onUpdate: (update: LiveUpdate) => void;
    onClosed: (reason: TopicClosedReason) => void;
  },
): Promise<{ snapshot: LiveSnapshot<T>; detach: Unsubscribe }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let detach: Unsubscribe | null = null;
    client
      .attach(topic, {
        onSnapshot: (value) => {
          if (settled) return;
          settled = true;
          // `detach` may not be known yet (snapshot can beat the attach
          // promise); resolve with a thunk that reads it when called.
          resolve({
            snapshot: value as LiveSnapshot<T>,
            detach: () => detach?.(),
          });
        },
        onUpdate: (update) => callbacks.onUpdate(update as LiveUpdate),
        onError: (error, retrying) => {
          if (retrying) return;
          if (!settled) {
            settled = true;
            reject(new EngineCallError(topic, error.code, error.message));
            return;
          }
          callbacks.onClosed({
            kind: 'topic-error',
            code: error.code,
            message: error.message,
          });
        },
      })
      .then((unsubscribe) => {
        detach = unsubscribe;
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
  });
}

export function registerTopicsIpc(deps: TopicsIpcDeps): Unsubscribe {
  const attachments = new Map<string, Attachment>();
  let counter = 0;
  const mintId = deps.mintId ?? (() => `sub-${(counter += 1)}`);

  const liveClient = (): WireClient => {
    const client = deps.supervisor.client();
    if (!client) throw new EngineNotRunningError();
    return client;
  };

  const close = (subscriptionId: string, reason: TopicClosedReason): void => {
    const attachment = attachments.get(subscriptionId);
    if (!attachment) return;
    attachments.delete(subscriptionId);
    try {
      attachment.detach?.();
    } catch {
      // A detach on a dead connection is already done.
    }
    if (reason.kind !== 'unsubscribed')
      deps.host.send(ENGINE_IPC.topicClosed, { subscriptionId, reason });
  };

  deps.host.handle(
    ENGINE_IPC.topicSubscribe,
    async (rawTopic): Promise<TopicSubscription> => {
      const topic = assertTopic(rawTopic);
      const client = liveClient();
      const subscriptionId = mintId();
      const { snapshot, detach } = await attachTopic(client, topic, {
        onUpdate: (update) => {
          if (attachments.has(subscriptionId))
            deps.host.send(ENGINE_IPC.topicUpdate, { subscriptionId, update });
        },
        onClosed: (reason) => close(subscriptionId, reason),
      });
      attachments.set(subscriptionId, { topic, detach, client });
      return { subscriptionId, snapshot };
    },
  );

  deps.host.handle(ENGINE_IPC.topicUnsubscribe, (rawId): void => {
    close(assertSubscriptionId(rawId), { kind: 'unsubscribed' });
  });

  // Resync: a bare snapshot of the subscription's topic on the attachment
  // it already holds. The follower ignores updates while stale and seeds
  // from the snapshot's cursor, so nothing needs re-attaching (review
  // round 2 — the first draft detached and re-attached).
  deps.host.handle(
    ENGINE_IPC.topicSnapshot,
    async (rawId): Promise<LiveSnapshot> => {
      const subscriptionId = assertSubscriptionId(rawId);
      const attachment = attachments.get(subscriptionId);
      if (!attachment)
        throw new Error(`No such subscription: ${subscriptionId}`);
      return liveClient().snapshot<LiveSnapshot>(attachment.topic, {
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
      });
    },
  );

  deps.host.handle(ENGINE_IPC.call, (procedure, input): Promise<unknown> => {
    if (typeof procedure !== 'string' || !(procedure in ALLOWED_PROCEDURES)) {
      throw new ProcedureNotAllowedError(String(procedure));
    }
    if (!ALLOWED_PROCEDURES[procedure](input)) {
      throw new Error(`Input rejected for ${procedure}.`);
    }
    return liveClient().call(procedure, input);
  });

  // The daemon going away closes every subscription — the renderer's
  // followers mark themselves stale and re-subscribe when the engine is
  // running again (the status channel tells them). Nothing here retries on
  // its own: a subscription is the renderer's to hold, not main's.
  const unsubscribeStatus = deps.supervisor.onStatusChange((status) => {
    if (status.kind === 'running') return;
    for (const subscriptionId of [...attachments.keys()]) {
      close(subscriptionId, { kind: 'disconnected' });
    }
  });

  const unsubscribeGone =
    deps.host.onRendererGone?.(() => {
      for (const subscriptionId of [...attachments.keys()])
        close(subscriptionId, { kind: 'unsubscribed' });
    }) ?? null;

  return () => {
    unsubscribeStatus();
    unsubscribeGone?.();
    for (const subscriptionId of [...attachments.keys()])
      close(subscriptionId, { kind: 'unsubscribed' });
  };
}
