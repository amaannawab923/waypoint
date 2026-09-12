import type { EngineSupervisor } from './supervisor';
import { registerTopicsIpc, type TopicsIpcHost } from './topicsIpc';
import {
  ENGINE_IPC,
  EngineCallError,
  isAllowedTopic,
  type EngineStatus,
  type WireClient,
} from './types';
import { liveTopic } from './wire/topics';

type Handlers = Parameters<WireClient['attach']>[1];

/** A WireClient whose attach hands the handlers back so a test can push
 *  snapshots, updates and errors as the daemon would. */
function fakeClient() {
  const topics = new Map<string, Handlers[]>();
  const detached: string[] = [];
  const client: WireClient = {
    call: jest.fn(async (path: string) => ({
      echoed: path,
    })) as WireClient['call'],
    snapshot: jest.fn(async (topic: string) => ({
      generation: 1,
      sequence: 0,
      timestamp: 9,
      data: { topic, fresh: true },
    })) as WireClient['snapshot'],
    attach: jest.fn(async (topic: string, handlers: Handlers) => {
      topics.set(topic, [...(topics.get(topic) ?? []), handlers]);
      queueMicrotask(() =>
        handlers.onSnapshot({
          generation: 1,
          sequence: 0,
          timestamp: 1,
          data: { topic },
        }),
      );
      return () => detached.push(topic);
    }),
    onDisconnect: jest.fn(() => () => {}),
    close: jest.fn(),
  };
  return {
    client,
    detached,
    push: (topic: string, update: unknown) =>
      topics.get(topic)?.forEach((h) => h.onUpdate(update)),
    fail: (topic: string, retrying: boolean) =>
      topics
        .get(topic)
        ?.forEach((h) =>
          h.onError?.({ code: 'UNKNOWN_TOPIC', message: 'gone' }, retrying),
        ),
  };
}

function fakeSupervisor(client: WireClient | null) {
  let status: EngineStatus = client
    ? ({ kind: 'running', since: 1 } as unknown as EngineStatus)
    : { kind: 'stopped', installDir: '/u', version: '0.1.0' };
  const listeners = new Set<(s: EngineStatus) => void>();
  const supervisor: EngineSupervisor & { emit: (s: EngineStatus) => void } = {
    getStatus: () => status,
    install: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    health: jest.fn(),
    client: () => (status.kind === 'running' ? client : null),
    onStatusChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: jest.fn(),
    emit: (next) => {
      status = next;
      listeners.forEach((cb) => cb(next));
    },
  };
  return supervisor;
}

function fakeHost() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const host: TopicsIpcHost = {
    handle: (channel, handler) => handlers.set(channel, handler),
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  // Like ipcMain.handle: a synchronous throw inside a handler reaches the
  // renderer as a rejected invoke, never as a throw from `invoke` itself.
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(...args));
  return { host, sent, invoke, handlers };
}

const logger = { warn: jest.fn() };
const ACTIVE_TURN = 'acp.session.activeTurn|{"conversationId":"run-abc1234"}';

beforeEach(() => jest.clearAllMocks());

describe('registerTopicsIpc', () => {
  it('subscribe attaches on the live client, answers with the first snapshot, and forwards updates by subscription id', async () => {
    const daemon = fakeClient();
    const { host, sent, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });

    const sub = (await invoke(ENGINE_IPC.topicSubscribe, ACTIVE_TURN)) as {
      subscriptionId: string;
      snapshot: unknown;
    };

    expect(sub.subscriptionId).toBe('sub-1');
    expect(sub.snapshot).toEqual({
      generation: 1,
      sequence: 0,
      timestamp: 1,
      data: { topic: ACTIVE_TURN },
    });
    expect(daemon.client.attach).toHaveBeenCalledWith(
      ACTIVE_TURN,
      expect.anything(),
    );

    daemon.push(ACTIVE_TURN, {
      generation: 1,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [],
    });
    expect(sent).toEqual([
      {
        channel: ENGINE_IPC.topicUpdate,
        payload: {
          subscriptionId: 'sub-1',
          update: {
            generation: 1,
            baseSequence: 0,
            sequence: 1,
            timestamp: 2,
            delta: [],
          },
        },
      },
    ]);
  });

  it('refuses a topic outside the allowlist before touching the daemon', async () => {
    const daemon = fakeClient();
    const { host, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });

    for (const topic of [
      'acp.session.activeTurn|{"conversationId":"conv-notours"}',
      'git.repository.model.refs|{"repository":{}}',
      'acp.getHistory',
      42,
    ]) {
      await expect(invoke(ENGINE_IPC.topicSubscribe, topic)).rejects.toThrow(
        'Topic is not available to the renderer',
      );
    }
    expect(daemon.client.attach).not.toHaveBeenCalled();
  });

  it('judges topics by rebuilding them with liveTopic, so a re-encoded key or an extra key field is refused', () => {
    expect(isAllowedTopic('workspaceRegistry.records.list')).toBe(true);
    // Main's live ledger follower holds the one attachment a Wire client
    // allows on the session list; the renderer reads the ledger instead.
    expect(isAllowedTopic('acp.sessions.list')).toBe(false);
    expect(
      isAllowedTopic(
        liveTopic('acp.session.activeTurn', { conversationId: 'run-abc1234' }),
      ),
    ).toBe(true);
    // Not exactly what liveTopic produces: spacing, key order, extra keys.
    expect(
      isAllowedTopic(
        'acp.session.activeTurn|{ "conversationId": "run-abc1234" }',
      ),
    ).toBe(false);
    expect(
      isAllowedTopic(
        'acp.session.activeTurn|{"conversationId":"run-abc1234","x":1}',
      ),
    ).toBe(false);
    expect(
      isAllowedTopic('acp.session.activeTurn|{"conversationId":"conv-1"}'),
    ).toBe(false);
    expect(
      isAllowedTopic('acp.session.secrets|{"conversationId":"run-abc1234"}'),
    ).toBe(false);
    expect(isAllowedTopic('acp.session.activeTurn|not json')).toBe(false);
    expect(isAllowedTopic('git.repository.model.refs|{"repository":{}}')).toBe(
      false,
    );
  });

  it('refuses to subscribe when the engine is not running', async () => {
    const { host, invoke } = fakeHost();
    registerTopicsIpc({ supervisor: fakeSupervisor(null), host, logger });

    await expect(
      invoke(ENGINE_IPC.topicSubscribe, 'workspaceRegistry.records.list'),
    ).rejects.toThrow('The agent engine is not running.');
  });

  it('unsubscribe detaches and stops forwarding; a second unsubscribe is a no-op', async () => {
    const daemon = fakeClient();
    const { host, sent, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });
    const sub = (await invoke(
      ENGINE_IPC.topicSubscribe,
      'workspaceRegistry.records.list',
    )) as { subscriptionId: string };

    await invoke(ENGINE_IPC.topicUnsubscribe, sub.subscriptionId);
    await invoke(ENGINE_IPC.topicUnsubscribe, sub.subscriptionId);
    daemon.push('workspaceRegistry.records.list', {
      generation: 1,
      baseSequence: 0,
      sequence: 1,
      timestamp: 2,
      delta: [],
    });

    expect(daemon.detached).toEqual(['workspaceRegistry.records.list']);
    expect(sent).toEqual([]);
    await expect(invoke(ENGINE_IPC.topicUnsubscribe, '../x')).rejects.toThrow(
      'Not a subscription id',
    );
  });

  it('snapshot answers a fresh bare snapshot of the subscription’s topic without touching the attachment (the resync path)', async () => {
    const daemon = fakeClient();
    const { host, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });
    const sub = (await invoke(ENGINE_IPC.topicSubscribe, ACTIVE_TURN)) as {
      subscriptionId: string;
    };

    const fresh = await invoke(ENGINE_IPC.topicSnapshot, sub.subscriptionId);

    expect(fresh).toEqual({
      generation: 1,
      sequence: 0,
      timestamp: 9,
      data: { topic: ACTIVE_TURN, fresh: true },
    });
    expect(daemon.client.snapshot).toHaveBeenCalledWith(ACTIVE_TURN, {
      timeoutMs: 10_000,
    });
    expect(daemon.client.attach).toHaveBeenCalledTimes(1);
    expect(daemon.detached).toEqual([]);
    await expect(invoke(ENGINE_IPC.topicSnapshot, 'sub-99')).rejects.toThrow(
      'No such subscription: sub-99',
    );
  });

  it('tells the renderer when a topic fails for good, and ignores a retrying error', async () => {
    const daemon = fakeClient();
    const { host, sent, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });
    const sub = (await invoke(ENGINE_IPC.topicSubscribe, ACTIVE_TURN)) as {
      subscriptionId: string;
    };

    daemon.fail(ACTIVE_TURN, true);
    expect(sent).toEqual([]);
    daemon.fail(ACTIVE_TURN, false);

    expect(sent).toEqual([
      {
        channel: ENGINE_IPC.topicClosed,
        payload: {
          subscriptionId: sub.subscriptionId,
          reason: {
            kind: 'topic-error',
            code: 'UNKNOWN_TOPIC',
            message: 'gone',
          },
        },
      },
    ]);
    expect(daemon.detached).toEqual([ACTIVE_TURN]);
  });

  it('a topic that fails before its first snapshot rejects the subscribe with the daemon’s error', async () => {
    const daemon = fakeClient();
    (daemon.client.attach as jest.Mock).mockImplementationOnce(
      async (_topic: string, handlers: Handlers) => {
        queueMicrotask(() =>
          handlers.onError?.(
            { code: 'UNKNOWN_TOPIC', message: 'no such topic' },
            false,
          ),
        );
        return () => {};
      },
    );
    const { host, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });

    const failure = await (
      invoke(ENGINE_IPC.topicSubscribe, 'workspaceRegistry.records.list') as Promise<unknown>
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(EngineCallError);
    expect((failure as EngineCallError).code).toBe('UNKNOWN_TOPIC');
  });

  it('closes every subscription as disconnected when the engine stops running', async () => {
    const daemon = fakeClient();
    const supervisor = fakeSupervisor(daemon.client);
    const { host, sent, invoke } = fakeHost();
    registerTopicsIpc({ supervisor, host, logger });
    await invoke(ENGINE_IPC.topicSubscribe, 'workspaceRegistry.records.list');
    await invoke(ENGINE_IPC.topicSubscribe, ACTIVE_TURN);

    supervisor.emit({ kind: 'stopping', since: 2 });

    expect(sent.map((s) => s.payload)).toEqual([
      { subscriptionId: 'sub-1', reason: { kind: 'disconnected' } },
      { subscriptionId: 'sub-2', reason: { kind: 'disconnected' } },
    ]);
    expect(daemon.detached.sort()).toEqual(
      [ACTIVE_TURN, 'workspaceRegistry.records.list'].sort(),
    );
  });

  it('call forwards only allowlisted procedures whose input passes their check', async () => {
    const daemon = fakeClient();
    const { host, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });

    expect(
      await invoke(ENGINE_IPC.call, 'acp.getHistory', {
        conversationId: 'run-abc1234',
        limit: 50,
      }),
    ).toEqual({ echoed: 'acp.getHistory' });
    expect(daemon.client.call).toHaveBeenCalledWith('acp.getHistory', {
      conversationId: 'run-abc1234',
      limit: 50,
    });

    await expect(
      invoke(ENGINE_IPC.call, 'acp.kill', { conversationId: 'run-abc1234' }),
    ).rejects.toThrow('Procedure is not available to the renderer: acp.kill');
    await expect(
      invoke(ENGINE_IPC.call, 'acp.getHistory', {
        conversationId: 'conv-other',
      }),
    ).rejects.toThrow('Input rejected for acp.getHistory.');
    await expect(
      invoke(ENGINE_IPC.call, 'workspaceRegistry.deleteWorktree', {}),
    ).rejects.toThrow('not available');
    expect(daemon.client.call).toHaveBeenCalledTimes(1);
  });

  it('lets the panel prompt, answer a permission and cancel a turn — for our runs, with exactly the fields it sends', async () => {
    const daemon = fakeClient();
    const { host, invoke } = fakeHost();
    registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });

    await invoke(ENGINE_IPC.call, 'acp.sendPrompt', {
      conversationId: 'run-abc1234',
      prompt: { text: 'Run the tests' },
    });
    await invoke(ENGINE_IPC.call, 'acp.sendPrompt', {
      conversationId: 'run-abc1234',
      prompt: { text: 'Then lint' },
      placement: 'queue',
    });
    await invoke(ENGINE_IPC.call, 'acp.resolvePermission', {
      conversationId: 'run-abc1234',
      requestId: 'perm-1',
      optionId: 'allow_once',
    });
    await invoke(ENGINE_IPC.call, 'acp.cancelTurn', {
      conversationId: 'run-abc1234',
    });
    expect(daemon.client.call).toHaveBeenCalledTimes(4);

    const refused: Array<[string, unknown]> = [
      // Not one of our runs.
      ['acp.sendPrompt', { conversationId: 'conv-1', prompt: { text: 'x' } }],
      // Empty text.
      ['acp.sendPrompt', { conversationId: 'run-abc1234', prompt: { text: '' } }],
      // Attachments: the renderer must not name files for the daemon.
      [
        'acp.sendPrompt',
        {
          conversationId: 'run-abc1234',
          prompt: { text: 'x', attachments: [{ id: 'a' }] },
        },
      ],
      [
        'acp.sendPrompt',
        {
          conversationId: 'run-abc1234',
          prompt: { text: 'x', hiddenContext: 'secret' },
        },
      ],
      ['acp.sendPrompt', { conversationId: 'run-abc1234', prompt: 'x' }],
      [
        'acp.sendPrompt',
        { conversationId: 'run-abc1234', prompt: { text: 'x' }, placement: 'now' },
      ],
      ['acp.resolvePermission', { conversationId: 'run-abc1234', requestId: 'p' }],
      [
        'acp.resolvePermission',
        { conversationId: 'run-abc1234', requestId: '', optionId: 'o' },
      ],
      [
        'acp.resolvePermission',
        { conversationId: 'run-abc1234', requestId: 'p', optionId: 'o', extra: 1 },
      ],
      ['acp.cancelTurn', { conversationId: 'run-abc1234', force: true }],
      ['acp.cancelTurn', { conversationId: 'conv-1' }],
    ];
    for (const [procedure, input] of refused) {
      await expect(invoke(ENGINE_IPC.call, procedure, input)).rejects.toThrow(
        `Input rejected for ${procedure}.`,
      );
    }
    // Still nothing the panel is not meant to reach.
    await expect(
      invoke(ENGINE_IPC.call, 'acp.kill', { conversationId: 'run-abc1234' }),
    ).rejects.toThrow('Procedure is not available to the renderer: acp.kill');
    expect(daemon.client.call).toHaveBeenCalledTimes(4);
  });

  it('the returned disposer detaches everything without telling the renderer', async () => {
    const daemon = fakeClient();
    const { host, sent, invoke } = fakeHost();
    const dispose = registerTopicsIpc({
      supervisor: fakeSupervisor(daemon.client),
      host,
      logger,
    });
    await invoke(ENGINE_IPC.topicSubscribe, 'workspaceRegistry.records.list');

    dispose();

    expect(daemon.detached).toEqual(['workspaceRegistry.records.list']);
    expect(sent).toEqual([]);
  });
});
