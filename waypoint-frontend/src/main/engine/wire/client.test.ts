import {
  EngineCallError,
  type EngineTransport,
  type EngineTransportCloseReason,
  type WireMessage,
} from '../types';
import { createFrameDecoder, encodeJsonFrame } from './codec';
import { createWireClient } from './client';

/**
 * An in-memory, byte-level fake of one connected `EngineTransport` end.
 * Every `send()` call is recorded verbatim in `sent` (so a test can assert
 * exactly which frames the client put on the wire, not just that it called
 * some mock once) and `receive()` hands a chunk to every registered
 * `onData` listener, exactly as a real socket delivering bytes from the
 * daemon would. There is deliberately no actual second "peer" object on the
 * other side — each test plays the daemon by hand, via `respond`/`receive`
 * below, which is what lets tests build scenarios emdash's real daemon
 * would never construct on purpose (an out-of-order result, a result for an
 * id nobody asked about, a stray blob-chunk frame) without needing a whole
 * fake server.
 */
interface FakeTransport extends EngineTransport {
  readonly sent: Uint8Array[];
  /** Test-only: deliver bytes as if they just arrived from the daemon. */
  receive(chunk: Uint8Array): void;
  /** Test-only: fire the transport's own close, from either side. */
  simulateClose(reason: EngineTransportCloseReason): void;
  /** Test-only: closed on the local side, e.g. by `client.close()`. */
  closedLocally: boolean;
  /** Test-only one-shot: makes the next `send()` throw this instead of
   *  recording a frame, then clears itself. */
  failNextSendWith: Error | undefined;
}

function createFakeTransport(): FakeTransport {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<
    (reason: EngineTransportCloseReason) => void
  >();
  const sent: Uint8Array[] = [];
  let closed = false;

  const transport: FakeTransport = {
    mode: 'socket',
    sent,
    closedLocally: false,
    failNextSendWith: undefined,
    send(bytes) {
      if (closed)
        throw new Error(
          'FakeTransport: send() called after the transport closed',
        );
      if (transport.failNextSendWith) {
        const error = transport.failNextSendWith;
        transport.failNextSendWith = undefined;
        throw error;
      }
      sent.push(bytes);
    },
    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onClose(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    close() {
      transport.closedLocally = true;
      transport.simulateClose({ kind: 'closed-by-us' });
    },
    receive(chunk) {
      for (const cb of dataListeners) cb(chunk);
    },
    simulateClose(reason) {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) cb(reason);
    },
  };
  return transport;
}

/** Decodes one previously-sent frame back into its `WireMessage`. Every
 *  `client.ts` call to `transport.send()` writes exactly one complete
 *  `encodeJsonFrame` result (never a partial frame, never more than one),
 *  so a fresh decoder per entry is enough — this is not testing split-frame
 *  handling, `codec.test.ts` already does that exhaustively. */
function decodeSent(bytes: Uint8Array): WireMessage {
  const decoder = createFrameDecoder();
  const messages = decoder.push(bytes);
  if (messages.length !== 1) {
    throw new Error(
      `expected exactly one frame in a single send(), got ${messages.length}`,
    );
  }
  return messages[0];
}

function sentMessages(transport: FakeTransport): WireMessage[] {
  return transport.sent.map(decodeSent);
}

function respond(transport: FakeTransport, message: WireMessage): void {
  transport.receive(encodeJsonFrame(message));
}

/** Finds the `id` the client used for the one outstanding `call`/`attach`/
 *  `snapshot` request matching `predicate` — used so tests correlate a
 *  response without hard-coding an id the client generated itself. */
function findSentId(
  transport: FakeTransport,
  predicate: (message: WireMessage) => boolean,
): string {
  const found = sentMessages(transport).find(
    (message): message is WireMessage & { id: string } =>
      'id' in message && predicate(message),
  );
  if (!found) throw new Error('no matching sent message with an id found');
  return found.id;
}

describe('call', () => {
  it('sends a call frame and resolves with the daemon result value', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const promise = client.call('health');
    const sent = sentMessages(transport);
    expect(sent).toHaveLength(1);
    // No `input` key at all, not an `input: undefined` key — see
    // `codec.ts`'s own comment on `WireCallMessage.input` being OMITTED
    // (not nulled) for a void procedure like `health`.
    expect(sent[0]).toMatchObject({ kind: 'call', path: 'health' });
    expect(sent[0]).not.toHaveProperty('input');
    const { id } = sent[0] as { id: string };
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    respond(transport, {
      kind: 'result',
      id,
      ok: true,
      value: { status: 'ok' },
    });

    await expect(promise).resolves.toEqual({ status: 'ok' });
  });

  it('passes the input through to the call frame untouched', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const promise = client.call('initialize', { protocolVersion: '1.0.0' });
    const [sent] = sentMessages(transport);
    expect(sent).toMatchObject({
      kind: 'call',
      path: 'initialize',
      input: { protocolVersion: '1.0.0' },
    });

    respond(transport, {
      kind: 'result',
      id: (sent as { id: string }).id,
      ok: true,
      value: {},
    });
    await promise;
  });

  it("rejects with EngineCallError carrying the daemon's own code, message, and cause on ok:false", async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const promise = client.call('acp.start');
    const id = findSentId(transport, (m) => m.kind === 'call');
    respond(transport, {
      kind: 'result',
      id,
      ok: false,
      code: 'NOT_FOUND',
      message: 'No such session',
      cause: { detail: 'session-7' },
    });

    await expect(promise).rejects.toMatchObject({
      name: 'EngineCallError',
      path: 'acp.start',
      code: 'NOT_FOUND',
      message: 'No such session',
      cause: { detail: 'session-7' },
    });
    await expect(promise).rejects.toBeInstanceOf(EngineCallError);
  });

  it('correlates results by id, not by send order — an out-of-order reply still resolves the right call', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const first = client.call('health');
    const second = client.call('acp.start', { workspaceId: 'w1' });
    const [firstSent, secondSent] = sentMessages(transport) as Array<{
      id: string;
    }>;
    expect(firstSent.id).not.toBe(secondSent.id);

    // The second call's reply arrives first.
    respond(transport, {
      kind: 'result',
      id: secondSent.id,
      ok: true,
      value: 'second-value',
    });
    respond(transport, {
      kind: 'result',
      id: firstSent.id,
      ok: true,
      value: 'first-value',
    });

    await expect(first).resolves.toBe('first-value');
    await expect(second).resolves.toBe('second-value');
  });

  it('ignores a result for an id nobody is waiting on, rather than throwing', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const promise = client.call('health');
    const id = findSentId(transport, (m) => m.kind === 'call');

    expect(() =>
      respond(transport, {
        kind: 'result',
        id: 'no-such-id',
        ok: true,
        value: 'stray',
      }),
    ).not.toThrow();

    respond(transport, { kind: 'result', id, ok: true, value: 'real' });
    await expect(promise).resolves.toBe('real');
  });

  it('times out, sends a cancel for the same id, and rejects with code "TIMEOUT"', async () => {
    jest.useFakeTimers();
    try {
      const transport = createFakeTransport();
      const client = createWireClient(transport);

      const promise = client.call('health', undefined, { timeoutMs: 1_000 });
      const id = findSentId(transport, (m) => m.kind === 'call');

      // Deliberately NOT awaited here — the assertion needs the timer,
      // advanced two lines below, to actually fire the rejection; awaiting
      // eagerly would deadlock waiting on a promise nothing has triggered
      // yet. `await assertion` afterward is what actually resolves this.
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'EngineCallError',
        path: 'health',
        code: 'TIMEOUT',
      });
      jest.advanceTimersByTime(1_000);
      await assertion;

      const cancelSent = sentMessages(transport).find(
        (m) => m.kind === 'cancel',
      );
      expect(cancelSent).toEqual({ kind: 'cancel', id });

      // A result that arrives late, after the timeout already settled the
      // promise, must not resolve it a second time or throw.
      expect(() =>
        respond(transport, { kind: 'result', id, ok: true, value: 'late' }),
      ).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never starts a timer when timeoutMs is omitted', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const promise = client.call('health');
    const id = findSentId(transport, (m) => m.kind === 'call');
    respond(transport, { kind: 'result', id, ok: true, value: 'ok' });
    await promise;
    // No assertion beyond "this resolves and nothing else fires" — a
    // lingering unref'd timer would still be harmless, but this documents
    // the no-timeoutMs path is exercised at all.
  });

  it('rejects a call issued while the transport is mid-flight with code "DISCONNECTED" when the transport closes', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const promise = client.call('health');
    transport.simulateClose({ kind: 'peer-closed' });

    await expect(promise).rejects.toMatchObject({
      name: 'EngineCallError',
      path: 'health',
      code: 'DISCONNECTED',
    });
  });

  it('rejects immediately, with no frame sent, once the client is already closed', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    client.close();
    transport.sent.length = 0; // drop whatever close() itself may have sent

    await expect(client.call('health')).rejects.toMatchObject({
      code: 'DISCONNECTED',
      path: 'health',
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('rejects with code "DISCONNECTED" when the transport throws synchronously on send, matching EngineTransport.send\'s own "throws if closed" contract', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    transport.failNextSendWith = new Error('socket buffer full');

    await expect(client.call('health')).rejects.toMatchObject({
      code: 'DISCONNECTED',
      path: 'health',
      message: 'socket buffer full',
    });
  });
});

describe('binary-frame tolerance', () => {
  it('a stray blob-chunk frame on the wire does not disturb a pending call', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);

    const promise = client.call('health');
    const id = findSentId(transport, (m) => m.kind === 'call');

    // Hand-build a binary frame exactly as `codec.test.ts` does — the
    // header carries no `data` field, the payload is a separate raw
    // length-prefixed body, per `codec.ts`'s own documented layout.
    const header = new TextEncoder().encode(
      JSON.stringify({ kind: 'blob-chunk', channel: 'c', seq: 0 }),
    );
    const body = new Uint8Array([9, 9, 9]);
    const frame = new Uint8Array(5 + header.byteLength + 4 + body.byteLength);
    frame[0] = 0x01;
    frame[4] = header.byteLength; // header well under 255 bytes
    frame.set(header, 5);
    const bodyLenOffset = 5 + header.byteLength;
    frame[bodyLenOffset + 3] = body.byteLength;
    frame.set(body, bodyLenOffset + 4);

    transport.receive(frame);
    respond(transport, { kind: 'result', id, ok: true, value: 'still-fine' });

    await expect(promise).resolves.toBe('still-fine');
  });
});

describe('attach', () => {
  function setup() {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const onSnapshot = jest.fn();
    const onUpdate = jest.fn();
    const onGap = jest.fn();
    const onError = jest.fn();
    return { transport, client, onSnapshot, onUpdate, onGap, onError };
  }

  it('sends both an attach and a snapshot request for the topic', () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    // Intentionally not awaited — both tests only need the frames this
    // call sends, never its resolution.
    client.attach('topic-1', { onSnapshot, onUpdate });

    const sent = sentMessages(transport);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attach', topic: 'topic-1' }),
        expect.objectContaining({ kind: 'snapshot', topic: 'topic-1' }),
      ]),
    );
    expect(sent).toHaveLength(2);
  });

  it('does not resolve until BOTH the attach ack and the snapshot value have arrived', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    let resolved = false;
    const promise = client
      .attach('topic-1', { onSnapshot, onUpdate })
      .then((detach) => {
        resolved = true;
        return detach;
      });

    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');

    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(onSnapshot).not.toHaveBeenCalled();

    respond(transport, {
      kind: 'result',
      id: snapshotId,
      ok: true,
      value: { count: 0 },
    });
    await promise;
    expect(resolved).toBe(true);
    expect(onSnapshot).toHaveBeenCalledWith({ count: 0 });
  });

  it('resolves correctly when the snapshot value arrives before the attach ack, the other race order', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate });

    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');

    respond(transport, {
      kind: 'result',
      id: snapshotId,
      ok: true,
      value: { count: 1 },
    });
    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });

    const detach = await promise;
    expect(typeof detach).toBe('function');
    expect(onSnapshot).toHaveBeenCalledWith({ count: 1 });
  });

  it('buffers an update that arrives before the snapshot and delivers it, in order, right after onSnapshot', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const deliveryOrder: string[] = [];
    onSnapshot.mockImplementation(() => deliveryOrder.push('snapshot'));
    onUpdate.mockImplementation(() => deliveryOrder.push('update'));

    const promise = client.attach('topic-1', { onSnapshot, onUpdate });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');

    // The daemon acks the attach, and — before this client has processed
    // the snapshot reply — pushes an update. The update must not reach
    // `onUpdate` before `onSnapshot` has established the base value it
    // applies against.
    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    respond(transport, {
      kind: 'update',
      topic: 'topic-1',
      update: { delta: 1 },
    });
    await Promise.resolve();
    expect(onUpdate).not.toHaveBeenCalled();

    respond(transport, {
      kind: 'result',
      id: snapshotId,
      ok: true,
      value: { count: 0 },
    });
    await promise;

    expect(deliveryOrder).toEqual(['snapshot', 'update']);
    expect(onUpdate).toHaveBeenCalledWith({ delta: 1 });
  });

  it('delivers an update directly once fully established, with no buffering delay', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');
    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    respond(transport, {
      kind: 'result',
      id: snapshotId,
      ok: true,
      value: { count: 0 },
    });
    await promise;

    respond(transport, {
      kind: 'update',
      topic: 'topic-1',
      update: { delta: 2 },
    });
    expect(onUpdate).toHaveBeenCalledWith({ delta: 2 });
  });

  it('routes topic-gap to onGap once attached', async () => {
    const { transport, client, onSnapshot, onUpdate, onGap } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate, onGap });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');
    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    respond(transport, { kind: 'result', id: snapshotId, ok: true, value: {} });
    await promise;

    respond(transport, { kind: 'topic-gap', topic: 'topic-1' });
    expect(onGap).toHaveBeenCalledTimes(1);
  });

  it('routes topic-error to onError, and stops delivering updates once retrying is false', async () => {
    const { transport, client, onSnapshot, onUpdate, onError } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate, onError });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');
    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    respond(transport, { kind: 'result', id: snapshotId, ok: true, value: {} });
    await promise;

    respond(transport, {
      kind: 'topic-error',
      topic: 'topic-1',
      error: { code: 'HANDLER_ERROR', message: 'lost the source' },
      retrying: false,
    });
    expect(onError).toHaveBeenCalledWith(
      { code: 'HANDLER_ERROR', message: 'lost the source' },
      false,
    );

    // The topic is gone now — a further update must not reach onUpdate and
    // must not throw.
    onUpdate.mockClear();
    expect(() =>
      respond(transport, { kind: 'update', topic: 'topic-1', update: {} }),
    ).not.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('rejects the whole attach() when the attach request itself fails, sending no detach', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');

    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: false,
      code: 'UNKNOWN_TOPIC',
      message: 'no such topic',
    });

    await expect(promise).rejects.toMatchObject({
      code: 'UNKNOWN_TOPIC',
      path: 'attach:topic-1',
    });
    expect(sentMessages(transport).some((m) => m.kind === 'detach')).toBe(
      false,
    );
  });

  it('rejects the whole attach() and sends a cleanup detach when the snapshot half fails after the attach half succeeded', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');

    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    respond(transport, {
      kind: 'result',
      id: snapshotId,
      ok: false,
      code: 'HANDLER_ERROR',
      message: 'boom',
    });

    await expect(promise).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
      path: 'attach:topic-1',
    });
    expect(sentMessages(transport)).toContainEqual({
      kind: 'detach',
      topic: 'topic-1',
    });
  });

  it('refuses a second concurrent attach to the same topic without sending any frame for it', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    // Intentionally not awaited — both tests only need the frames this
    // call sends, never its resolution.
    client.attach('topic-1', { onSnapshot, onUpdate });
    const framesAfterFirst = transport.sent.length;

    await expect(
      client.attach('topic-1', { onSnapshot, onUpdate }),
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      path: 'attach:topic-1',
    });
    expect(transport.sent).toHaveLength(framesAfterFirst);
  });

  it('allows attaching again once the first attach has been detached', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const first = client.attach('topic-1', { onSnapshot, onUpdate });
    const firstAttachId = findSentId(transport, (m) => m.kind === 'attach');
    const firstSnapshotId = findSentId(transport, (m) => m.kind === 'snapshot');
    respond(transport, {
      kind: 'result',
      id: firstAttachId,
      ok: true,
      value: undefined,
    });
    respond(transport, {
      kind: 'result',
      id: firstSnapshotId,
      ok: true,
      value: {},
    });
    const detach = await first;
    detach();

    const second = client.attach('topic-1', { onSnapshot, onUpdate });
    // The first attach's ids are already spent (`findSentId` would return
    // the stale one again) — `sentMessages` now carries both attempts, so
    // this reaches past the first attach/snapshot/detach frames to the
    // fresh pair the second `attach()` call just sent.
    const secondAttachId = sentMessages(transport)
      .filter((m) => m.kind === 'attach')
      .map((m) => (m as { id: string }).id)
      .find((id) => id !== firstAttachId);
    const secondSnapshotId = sentMessages(transport)
      .filter((m) => m.kind === 'snapshot')
      .map((m) => (m as { id: string }).id)
      .find((id) => id !== firstSnapshotId);
    if (!secondAttachId || !secondSnapshotId) {
      throw new Error(
        'expected the second attach() call to have sent fresh attach/snapshot ids',
      );
    }
    respond(transport, {
      kind: 'result',
      id: secondAttachId,
      ok: true,
      value: undefined,
    });
    respond(transport, {
      kind: 'result',
      id: secondSnapshotId,
      ok: true,
      value: {},
    });

    await expect(second).resolves.toEqual(expect.any(Function));
  });

  it('detach sends exactly one detach frame, even if called more than once', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate });
    const attachId = findSentId(transport, (m) => m.kind === 'attach');
    const snapshotId = findSentId(transport, (m) => m.kind === 'snapshot');
    respond(transport, {
      kind: 'result',
      id: attachId,
      ok: true,
      value: undefined,
    });
    respond(transport, { kind: 'result', id: snapshotId, ok: true, value: {} });
    const detach = await promise;

    detach();
    detach();

    const detachFrames = sentMessages(transport).filter(
      (m) => m.kind === 'detach',
    );
    expect(detachFrames).toHaveLength(1);
  });

  it('rejects immediately, with no frame sent, once the client is already closed', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    client.close();
    transport.sent.length = 0;

    await expect(
      client.attach('topic-1', { onSnapshot, onUpdate }),
    ).rejects.toMatchObject({
      code: 'DISCONNECTED',
      path: 'attach:topic-1',
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('rejects a still-establishing attach with code "disconnected" if the transport closes first', async () => {
    const { transport, client, onSnapshot, onUpdate } = setup();
    const promise = client.attach('topic-1', { onSnapshot, onUpdate });
    transport.simulateClose({ kind: 'peer-closed' });

    await expect(promise).rejects.toMatchObject({
      code: 'DISCONNECTED',
      path: 'attach:topic-1',
    });
  });
});

describe('onDisconnect / close', () => {
  it('close() rejects every pending call with code "disconnected"', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const first = client.call('health');
    const second = client.call('acp.start');

    client.close();

    await expect(first).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await expect(second).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('close() calls transport.close() so the underlying byte stream actually tears down', () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    expect(transport.closedLocally).toBe(false);
    client.close();
    expect(transport.closedLocally).toBe(true);
  });

  it('close() is idempotent — a second call does not throw or double-fire onDisconnect', () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const cb = jest.fn();
    client.onDisconnect(cb);

    client.close();
    expect(() => client.close()).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onDisconnect fires with the transport's own close reason when the peer goes away", () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const cb = jest.fn();
    client.onDisconnect(cb);

    transport.simulateClose({ kind: 'child-exited', code: 1, signal: null });

    expect(cb).toHaveBeenCalledWith({
      kind: 'child-exited',
      code: 1,
      signal: null,
    });
  });

  it('an unsubscribed onDisconnect listener is not called', () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const cb = jest.fn();
    const unsubscribe = client.onDisconnect(cb);
    unsubscribe();

    transport.simulateClose({ kind: 'peer-closed' });

    expect(cb).not.toHaveBeenCalled();
  });

  it('onDisconnect registered after the client already closed returns a no-op unsubscribe and never fires', () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    client.close();

    const cb = jest.fn();
    const unsubscribe = client.onDisconnect(cb);
    expect(() => unsubscribe()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it('a malformed frame from the daemon (decoder throws) closes the client and rejects pending calls', async () => {
    const transport = createFakeTransport();
    const client = createWireClient(transport);
    const promise = client.call('health');
    const cb = jest.fn();
    client.onDisconnect(cb);

    // A JSON-frame header declaring an impossibly large body length — the
    // same class of corruption `codec.test.ts` exercises directly against
    // the decoder; this proves `client.ts` actually reacts to it, not just
    // that `FrameDecoder.push` itself throws.
    const bogus = new Uint8Array(5);
    bogus[0] = 0x00;
    bogus[1] = 0x7f;
    bogus[2] = 0xff;
    bogus[3] = 0xff;
    bogus[4] = 0xff;
    transport.receive(bogus);

    await expect(promise).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ kind: 'error' });
  });
});
