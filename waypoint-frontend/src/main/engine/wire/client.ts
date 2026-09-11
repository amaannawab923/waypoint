import { randomUUID } from 'node:crypto';
import {
  EngineCallError,
  type EngineTransport,
  type EngineTransportCloseReason,
  type Unsubscribe,
  type WireMessage,
  type WireResultMessage,
  type WireTopicErrorMessage,
  type WireClient,
} from '../types';
import { createFrameDecoder, encodeJsonFrame } from './codec';

/**
 * The Wire client: request/response calls plus topic subscription, over one
 * connected `EngineTransport`. No reconnect logic lives here — `../types.ts`
 * says that is the supervisor's job, and this file holds to it.
 *
 * Two protocol facts below are NOT obvious from `../types.ts` alone and were
 * confirmed against emdash `main` at 9b102a5f3 rather than assumed, because
 * getting either wrong would make this client silently drop data:
 *
 * 1. How a `result` is *sent*, generically. `packages/wire/src/api/
 *    connect.ts:118-131` — the client's single `transport.onMessage`
 *    handler routes every `{ kind: 'result', id, ... }` to whichever
 *    `pending` entry that `id` belongs to, with NO branch on what kind of
 *    request originally created that `id`. `call`, `snapshot`, and `attach`
 *    (`connect.ts:453-482`, `510-514`, `515-546`) all just call the same
 *    internal `request()`, which stuffs the message into the same `pending`
 *    map by its own id and lets this one generic handler resolve it. So
 *    `result` is not "the answer to a call" — it is "the answer to
 *    whichever outstanding request has this id," and this client's
 *    `pendingRequests` map (below) mirrors that: one map, keyed by id, for
 *    every request kind that expects a `result` back.
 *
 * 2. How a live topic's initial value actually reaches the client — this is
 *    the fact `../types.ts`'s own `WireClient.attach` doc glosses over by
 *    saying attach "resolves once the initial snapshot arrives," without
 *    saying how. It does NOT ride on the `attach` request's own `result`:
 *      - `packages/wire/src/api/serve.ts:276-347` (the `case 'attach':`
 *        branch of `handleMessage`) replies to an `attach` message by
 *        establishing the subscription and then resolving with `undefined`
 *        — no snapshot value, no `kind: 'snapshot'` message pushed to the
 *        client. That `undefined` reaches the client as an ordinary
 *        `{ kind: 'result', id, ok: true, value: undefined }`, handled by
 *        the exact same generic path as (1).
 *      - The daemon only ever answers a *separate* `{ kind: 'snapshot', id,
 *        topic }` request — `../types.ts`'s own `WireSnapshotMessage`,
 *        which is shaped identically to emdash's own client-to-server
 *        request of the same name (`protocol.ts:28-32`) — and it answers
 *        THAT with the snapshot value, again via a plain `result`
 *        (`serve.ts:204-234`, `replySnapshot`, whose `work` returns
 *        `source.snapshot()` and is posted back through the same
 *        `postSuccessfulResult` every other reply uses).
 *      - Confirmed against the one real consumer in emdash that does both:
 *        `packages/wire/src/live/replica/state.ts:65-70` fires
 *        `handle.attach(...)` and `handle.snapshot()` *concurrently*
 *        (`Promise.all([handle.snapshot(), this.detachPromise])`) rather
 *        than sequencing one after the other, specifically so no `update`
 *        that lands in the gap between them is lost.
 *    `../types.ts` exposes exactly the message shape this needs
 *    (`WireSnapshotMessage`) but no client method to send one — so `attach`
 *    below sends BOTH a `WireAttachMessage` and a `WireSnapshotMessage`
 *    itself, races them the same way emdash's own replica does, and only
 *    resolves once both have answered. This is not a workaround for a
 *    contract gap; `../types.ts`'s `WireMessage` union already carries
 *    everything this needs — see this file's own report for the one thing
 *    worth tightening in `../types.ts`'s doc comment, not its shapes.
 *
 * `WireErrorCode` (`../types.ts`) is emdash's own uppercase vocabulary
 * (`UNKNOWN_TOPIC`, `NOT_FOUND`, `HANDLER_ERROR`, ...), not a code this
 * client invents — and, since ROAD-49's contract closed that union to
 * exactly those daemon-observed values, every locally-detected failure
 * below is spelled using one of the SAME codes rather than a client-only
 * string: `'DISCONNECTED'` for both a closed client and a transport `send`
 * that threw (`EngineTransport.send`'s own contract: "Throws if closed" —
 * so that throw already means disconnection, precisely), `'TIMEOUT'` for a
 * call that outran its deadline, and `'ALREADY_EXISTS'` for a second
 * `attach()` on a topic this client already has open (see `attach`'s own
 * comment on why that is refused rather than fanned out).
 */

/** One outstanding request awaiting a `result` by id — see this file's
 *  header, fact (1), for why `call`, `attach`, and `snapshot` all share this
 *  one map instead of three. `onDisconnect` is what lets `handleClose`
 *  (below) reject every in-flight request the moment the transport goes
 *  away, matching `WireClient.close`'s contract ("every pending call
 *  rejects with `disconnected`" — `code: 'DISCONNECTED'` in the vocabulary
 *  `../types.ts` actually declares) without each caller having to also
 *  register a separate `onClose` listener of its own. */
interface PendingRequest {
  onResult(message: WireResultMessage): void;
  onDisconnect(reason: EngineTransportCloseReason): void;
}

/** Bookkeeping for one attached topic, alive from the moment `attach()` is
 *  called until its `detach()` runs (or the transport closes). Registered
 *  in `attachments` BEFORE either wire message is sent, so an `update` that
 *  the daemon pushes the instant it processes our `attach` — before our own
 *  process has even seen the `snapshot` reply — still has somewhere to
 *  land. */
interface AttachState {
  handlers: {
    onSnapshot: (value: unknown) => void;
    onUpdate: (update: unknown) => void;
    onGap?: () => void;
    onError?: (
      error: WireTopicErrorMessage['error'],
      retrying: boolean,
    ) => void;
  };
  /** Flips true the moment `onSnapshot` has been delivered. Until then,
   *  every `update` for this topic is held in `bufferedUpdates` instead of
   *  reaching `onUpdate` — see this file's header, fact (2): the daemon can
   *  legally push an `update` before this client has processed the
   *  `snapshot` reply, since the two requests race, and a subscriber that
   *  is handed an update before it has ever seen the base value it applies
   *  against would have nothing coherent to apply it to. */
  snapshotDelivered: boolean;
  bufferedUpdates: unknown[];
}

function describeCloseReason(reason: EngineTransportCloseReason): string {
  switch (reason.kind) {
    case 'closed-by-us':
      return 'the Wire transport was closed locally';
    case 'peer-closed':
      return 'the Wire transport peer closed the connection';
    case 'error':
      return `the Wire transport failed: ${reason.message}`;
    case 'child-exited':
      return `the engine process exited (code ${String(reason.code)}, signal ${String(reason.signal)})`;
    default: {
      // Exhaustiveness guard: `EngineTransportCloseReason` is a closed union
      // owned by `../types.ts`, which this file may not edit — if a variant
      // is ever added there, this line fails to compile instead of silently
      // stringifying `undefined` at runtime.
      const exhaustive: never = reason;
      return `unknown transport close reason: ${JSON.stringify(exhaustive)}`;
    }
  }
}

/** Invokes a caller-supplied handler defensively. A subscriber's `onUpdate`
 *  (etc.) throwing must not unwind this client's own message-dispatch loop
 *  and take every other pending call or attachment down with it — the same
 *  posture emdash's own `connect.ts` takes at `notifyReattached` /
 *  `notifyReattachError` (`connect.ts:666-690`), which wrap every observer
 *  callback in exactly this kind of try/catch for exactly this reason. */
function callHandler(fn: () => void): void {
  try {
    fn();
  } catch {
    // A misbehaving subscriber is the subscriber's problem, not this
    // client's connection's problem.
  }
}

export function createWireClient(transport: EngineTransport): WireClient {
  const decoder = createFrameDecoder();
  const pendingRequests = new Map<string, PendingRequest>();
  const attachments = new Map<string, AttachState>();
  const disconnectListeners = new Set<
    (reason: EngineTransportCloseReason) => void
  >();
  let closed = false;
  // Declared here (assigned further down, once `transport.onData`/`onClose`
  // are actually wired up) rather than left as `const`s at their natural
  // point of use: `handleClose` — defined next, before either exists yet —
  // needs to unsubscribe both, and at the time `handleClose` ever actually
  // RUNS both are long since assigned, so this is safe. It is also the only
  // ordering that doesn't force `handleClose`'s own declaration below the
  // two transport listeners it is referenced FROM (each listener's callback
  // calls `handleClose`), which would just relocate the same
  // forward-reference problem rather than remove it.
  let unsubscribeData: Unsubscribe;
  let unsubscribeClose: Unsubscribe;

  function trySend(
    message: WireMessage,
  ): { ok: true } | { ok: false; error: unknown } {
    try {
      transport.send(encodeJsonFrame(message));
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** For `cancel`/`detach`: control messages this client sends on a
   *  best-effort basis while tearing something down. There is no one left
   *  to hand a failure to — the caller already has its own promise settled
   *  (a timeout has already rejected the call; a `detach()` has no promise
   *  at all) — and `EngineTransport.send`'s own contract says it throws
   *  once the transport is closed, which is exactly the situation where
   *  this message no longer needs to go anywhere. */
  function sendBestEffort(message: WireMessage): void {
    trySend(message);
  }

  function routeMessage(message: WireMessage): void {
    switch (message.kind) {
      case 'result':
        pendingRequests.get(message.id)?.onResult(message);
        return;
      case 'update': {
        const state = attachments.get(message.topic);
        // No attachment for this topic: either the daemon is pushing an
        // update for a topic we already detached (a race inherent to any
        // async detach — our `detach` may still be in flight when this
        // arrives) or, in principle, a topic this client never asked for.
        // Either way this is data with nowhere to go, not a protocol
        // violation worth failing the connection over.
        if (!state) return;
        if (!state.snapshotDelivered) {
          state.bufferedUpdates.push(message.update);
          return;
        }
        callHandler(() => state.handlers.onUpdate(message.update));
        return;
      }
      case 'topic-gap': {
        const state = attachments.get(message.topic);
        if (state?.handlers.onGap) callHandler(state.handlers.onGap);
        return;
      }
      case 'topic-error': {
        const state = attachments.get(message.topic);
        if (!state) return;
        if (state.handlers.onError) {
          const handler = state.handlers.onError;
          callHandler(() => handler(message.error, message.retrying));
        }
        // `retrying: false` is the daemon saying the topic itself is dead,
        // not merely that this one delivery was skipped — nothing further
        // will ever arrive for it, so there is nothing left to buffer or
        // detach.
        if (!message.retrying) attachments.delete(message.topic);
        return;
      }
      case 'call':
      case 'attach':
      case 'detach':
      case 'cancel':
        // These are messages THIS client sends, never receives — the
        // daemon has no reason to echo one back. Dropped, not thrown: one
        // stray or forward-incompatible message must not take the whole
        // connection down, and `../types.ts`'s `WireMessage` union already
        // makes this branch unreachable for anything the daemon actually
        // speaks.
        return;
      default:
        // Exhaustiveness backstop, distinct from the named-but-unhandled
        // kinds just above: `message` here is whatever `JSON.parse` in
        // `./codec.ts` produced, cast to `WireMessage` but never actually
        // validated against it (see `FrameDecoder.push`'s own comment on
        // why the codec trusts a pinned daemon build rather than schema-
        // checking every frame). A `kind` this switch does not recognize —
        // protocol drift on the daemon's side, or a genuinely corrupt
        // frame that still happened to parse as JSON — lands here instead
        // of silently matching nothing.
        return;
    }
  }

  function handleClose(reason: EngineTransportCloseReason): void {
    if (closed) return;
    closed = true;
    unsubscribeData();
    unsubscribeClose();

    for (const request of pendingRequests.values())
      request.onDisconnect(reason);
    pendingRequests.clear();

    // "Stops every subscription" (`WireClient.close`'s own contract): local
    // bookkeeping is torn down and no further `onUpdate`/`onGap`/`onError`
    // will fire. Deliberately NOT synthesizing a `topic-error` for every
    // still-attached topic here — those are the daemon's own signal about
    // one topic, and manufacturing one locally would claim the daemon said
    // something it never said. A caller that wants to know the client
    // itself is gone uses `onDisconnect`, below, which is the honest place
    // for that claim.
    attachments.clear();

    for (const cb of disconnectListeners) callHandler(() => cb(reason));
  }

  unsubscribeData = transport.onData((chunk) => {
    if (closed) return;
    let messages: WireMessage[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      // `FrameDecoder.push`'s own contract (`./codec.ts`): a throw means
      // the byte stream can no longer be trusted, and the caller must
      // close rather than attempt to resynchronize. There is no
      // `EngineTransportCloseReason` variant for "we gave up on your
      // bytes," so this is reported as `error` with the parse failure's
      // own message — accurate, since from this client's side a corrupted
      // frame and a genuinely broken transport look identical: bytes that
      // can no longer be turned into `WireMessage`s.
      handleClose({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      // And actually hang up: handleClose settles this client's own state,
      // but the socket would otherwise stay open to a peer we have decided
      // not to trust (found in review, L4). The supervisor happened to
      // compensate on both paths it used; the client's `close` contract
      // should not depend on that.
      transport.close();
      return;
    }
    for (const message of messages) routeMessage(message);
  });

  unsubscribeClose = transport.onClose((reason) => {
    handleClose(reason);
  });

  function detachTopic(topic: string): void {
    // A no-op on a topic that is already gone — because its `detach()` was
    // already called once, because a `topic-error` with `retrying: false`
    // already removed it, or because the whole client already closed. A
    // detach function a caller might reasonably call more than once (or
    // hold past the client's lifetime) should never throw for any of those
    // ordinary reasons.
    if (!attachments.has(topic)) return;
    attachments.delete(topic);
    sendBestEffort({ kind: 'detach', topic });
  }

  function call<T = unknown>(
    path: string,
    input?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (closed) {
      return Promise.reject(
        new EngineCallError(path, 'DISCONNECTED', 'Wire client is closed'),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (): void => {
        pendingRequests.delete(id);
        if (timer !== undefined) clearTimeout(timer);
      };

      pendingRequests.set(id, {
        onResult: (message) => {
          settle();
          if (message.ok) {
            resolve(message.value as T);
          } else {
            reject(
              new EngineCallError(
                path,
                message.code,
                message.message,
                message.cause,
              ),
            );
          }
        },
        onDisconnect: (reason) => {
          settle();
          reject(
            new EngineCallError(
              path,
              'DISCONNECTED',
              describeCloseReason(reason),
            ),
          );
        },
      });

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          settle();
          // Tells the daemon to stop doing whatever `path` was doing. Best
          // effort: whether or not this lands, the promise below has
          // already settled from this client's point of view, and
          // `../types.ts`'s `WireClient.call` contract only promises that a
          // timeout rejects with code `'TIMEOUT'`, not that the daemon
          // definitely stopped work.
          sendBestEffort({ kind: 'cancel', id });
          reject(
            new EngineCallError(
              path,
              'TIMEOUT',
              `Wire call '${path}' timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }

      const sent = trySend({ kind: 'call', id, path, input });
      if (!sent.ok) {
        settle();
        // `EngineTransport.send`'s own contract says this only throws once
        // the transport is closed — so this IS a disconnection, not a
        // separate "internal" bucket the closed `WireErrorCode` vocabulary
        // has no slot for anyway.
        reject(
          new EngineCallError(
            path,
            'DISCONNECTED',
            sent.error instanceof Error
              ? sent.error.message
              : String(sent.error),
            sent.error,
          ),
        );
      }
    });
  }

  function attach(
    topic: string,
    handlers: AttachState['handlers'],
  ): Promise<Unsubscribe> {
    if (closed) {
      return Promise.reject(
        new EngineCallError(
          `attach:${topic}`,
          'DISCONNECTED',
          'Wire client is closed',
        ),
      );
    }
    if (attachments.has(topic)) {
      // Refused rather than fanned out to a second handler set. Nothing in
      // `../types.ts`'s `WireClient` contract says what a second `attach()`
      // on a live topic should even do: fan updates out to both handler
      // sets (silent until one of the two callers' `detach()` also silently
      // stops the other's updates), or hand back the first attach's own
      // detach function (silently letting a caller who never called
      // `attach` themselves tear down someone else's subscription)? Both
      // are surprising in a different way, and W1 has exactly one real
      // subscriber (`../types.ts`'s own header: "nobody attaches anything
      // but a debug view"), so there is no real caller yet whose actual
      // needs could settle which surprise is the lesser one. Refusing is
      // the one option that cannot silently do the wrong thing — a caller
      // that wants to fan one topic out to two consumers shares the
      // `Unsubscribe` this returns, rather than calling `attach` twice.
      //
      // `'ALREADY_EXISTS'`, not an invented code: `../types.ts`'s
      // `WireErrorCode` is now closed to exactly emdash's own uppercase
      // vocabulary (no string-escape hatch), and this is the one entry in
      // it that actually describes "you asked for a second one of a thing
      // that already exists" — the same shape of problem the daemon itself
      // reports it for elsewhere, just detected here instead of there.
      return Promise.reject(
        new EngineCallError(
          `attach:${topic}`,
          'ALREADY_EXISTS',
          `Topic "${topic}" is already attached on this Wire client`,
        ),
      );
    }

    const state: AttachState = {
      handlers,
      snapshotDelivered: false,
      bufferedUpdates: [],
    };
    attachments.set(topic, state);

    return new Promise<Unsubscribe>((resolve, reject) => {
      let attachAcked = false;
      let settled = false;

      const cleanupAndReject = (error: EngineCallError): void => {
        if (settled) return;
        settled = true;
        attachments.delete(topic);
        reject(error);
      };

      const maybeResolve = (): void => {
        if (settled || !attachAcked || !state.snapshotDelivered) return;
        settled = true;
        resolve(() => detachTopic(topic));
      };

      const attachId = randomUUID();
      const snapshotId = randomUUID();

      pendingRequests.set(attachId, {
        onResult: (message) => {
          pendingRequests.delete(attachId);
          if (!message.ok) {
            cleanupAndReject(
              new EngineCallError(
                `attach:${topic}`,
                message.code,
                message.message,
                message.cause,
              ),
            );
            return;
          }
          attachAcked = true;
          maybeResolve();
        },
        onDisconnect: (reason) => {
          pendingRequests.delete(attachId);
          cleanupAndReject(
            new EngineCallError(
              `attach:${topic}`,
              'DISCONNECTED',
              describeCloseReason(reason),
            ),
          );
        },
      });

      pendingRequests.set(snapshotId, {
        onResult: (message) => {
          pendingRequests.delete(snapshotId);
          if (!message.ok) {
            cleanupAndReject(
              new EngineCallError(
                `attach:${topic}`,
                message.code,
                message.message,
                message.cause,
              ),
            );
            // The `attach` half may already have been acked by the time the
            // `snapshot` half fails — the two requests race, per this
            // file's header. Detach whatever the daemon already
            // established so a failed `attach()` call never leaves a live
            // subscription running with no `Unsubscribe` anyone can call.
            if (attachAcked) sendBestEffort({ kind: 'detach', topic });
            return;
          }
          callHandler(() => state.handlers.onSnapshot(message.value));
          state.snapshotDelivered = true;
          const buffered = state.bufferedUpdates;
          state.bufferedUpdates = [];
          for (const update of buffered) {
            callHandler(() => state.handlers.onUpdate(update));
          }
          maybeResolve();
        },
        onDisconnect: (reason) => {
          pendingRequests.delete(snapshotId);
          cleanupAndReject(
            new EngineCallError(
              `attach:${topic}`,
              'DISCONNECTED',
              describeCloseReason(reason),
            ),
          );
        },
      });

      // Both sends below use 'DISCONNECTED' for the same reason `call`'s own
      // send failure does: `EngineTransport.send` only throws once the
      // transport is closed, so a caught throw here already IS a
      // disconnection.
      const attachSent = trySend({ kind: 'attach', id: attachId, topic });
      if (!attachSent.ok) {
        pendingRequests.delete(attachId);
        pendingRequests.delete(snapshotId);
        cleanupAndReject(
          new EngineCallError(
            `attach:${topic}`,
            'DISCONNECTED',
            attachSent.error instanceof Error
              ? attachSent.error.message
              : String(attachSent.error),
            attachSent.error,
          ),
        );
        return;
      }

      const snapshotSent = trySend({ kind: 'snapshot', id: snapshotId, topic });
      if (!snapshotSent.ok) {
        pendingRequests.delete(attachId);
        pendingRequests.delete(snapshotId);
        cleanupAndReject(
          new EngineCallError(
            `attach:${topic}`,
            'DISCONNECTED',
            snapshotSent.error instanceof Error
              ? snapshotSent.error.message
              : String(snapshotSent.error),
            snapshotSent.error,
          ),
        );
      }
    });
  }

  function onDisconnect(
    cb: (reason: EngineTransportCloseReason) => void,
  ): Unsubscribe {
    if (closed) {
      // The transport is already gone, and the one event this callback
      // exists to observe already happened before it was registered. There
      // is nothing left to fire it with — mirroring emdash's own
      // already-disposed `Connection.onDisconnect` (`connect.ts:547-551`),
      // which returns a no-op unsubscribe rather than fire the callback
      // retroactively or hold it forever.
      return () => {};
    }
    disconnectListeners.add(cb);
    return () => disconnectListeners.delete(cb);
  }

  function close(): void {
    // Reject everything in flight and stop every subscription synchronously
    // — `WireClient.close`'s own contract promises this, and it must not
    // depend on `transport.close()` eventually triggering `onClose` at some
    // later, transport-specific tick.
    handleClose({ kind: 'closed-by-us' });
    try {
      transport.close();
    } catch {
      // Best effort: a transport that is already tearing itself down may
      // throw on a second `close()`, and this client has nothing further
      // to do about it either way.
    }
  }

  return { call, attach, onDisconnect, close };
}
