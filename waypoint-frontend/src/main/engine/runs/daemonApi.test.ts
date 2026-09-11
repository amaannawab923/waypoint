import { EngineCallError, type WireClient } from '../types';
import {
  createDaemonRunsApi,
  DaemonApiError,
  hostAbsolutePath,
  liveTopic,
  readSnapshot,
} from './daemonApi';

type Handlers = Parameters<WireClient['attach']>[1];

/** A WireClient whose `call` answers from a table and whose `attach` pushes
 *  the snapshot for a topic (in the daemon's `{generation, sequence,
 *  timestamp, data}` envelope) as soon as it is asked. */
function fakeClient(options: {
  calls?: Record<string, unknown | ((input: unknown) => unknown)>;
  snapshots?: Record<string, unknown>;
  topicErrors?: Record<string, { error: unknown; retrying: boolean }>;
}) {
  const detached: string[] = [];
  const client: WireClient = {
    call: jest.fn(async (path: string, input?: unknown) => {
      const answer = options.calls?.[path];
      if (answer === undefined)
        throw new EngineCallError(
          path,
          'UNKNOWN_PROCEDURE',
          `no such procedure ${path}`,
        );
      return typeof answer === 'function'
        ? (answer as (i: unknown) => unknown)(input)
        : answer;
    }) as WireClient['call'],
    attach: jest.fn(async (topic: string, handlers: Handlers) => {
      const failure = options.topicErrors?.[topic];
      if (failure) {
        queueMicrotask(() =>
          handlers.onError?.(failure.error as never, failure.retrying),
        );
      } else if (topic in (options.snapshots ?? {})) {
        queueMicrotask(() =>
          handlers.onSnapshot({
            generation: 1,
            sequence: 0,
            timestamp: 1,
            data: options.snapshots![topic],
          }),
        );
      }
      return () => detached.push(topic);
    }),
    onDisconnect: jest.fn(() => () => {}),
    close: jest.fn(),
  };
  return { client, detached };
}

const REPO_RECORD = {
  id: 'repo-1',
  kind: 'repository',
  path: '/private/r',
  parentId: null,
  observedStatus: 'present',
  creation: null,
  lastCreateOutcome: null,
};

describe('hostAbsolutePath / liveTopic', () => {
  it('splits a posix path into the daemon’s structured form and sorts keys into the topic', () => {
    expect(hostAbsolutePath('/private/tmp/repo/')).toEqual({
      root: { kind: 'posix' },
      segments: ['private', 'tmp', 'repo'],
    });
    expect(() => hostAbsolutePath('relative/x')).toThrow(
      'Not an absolute path',
    );
    // Observed live: this exact string is what the daemon answered a refs snapshot for.
    expect(
      liveTopic('git.repository.model.refs', {
        repository: hostAbsolutePath('/tmp/wpw2/repo'),
      }),
    ).toBe(
      'git.repository.model.refs|{"repository":{"root":{"kind":"posix"},"segments":["tmp","wpw2","repo"]}}',
    );
    expect(liveTopic('acp.sessions.list')).toBe('acp.sessions.list');
    // Key order in the input does not change the topic.
    expect(liveTopic('x', { b: 1, a: { d: 1, c: 2 } })).toBe(
      'x|{"a":{"c":2,"d":1},"b":1}',
    );
  });
});

describe('readSnapshot', () => {
  it('resolves with the envelope’s data and detaches afterwards', async () => {
    const { client, detached } = fakeClient({
      snapshots: {
        'acp.sessions.list': { 'run-1': { conversationId: 'run-1' } },
      },
    });

    const data = await readSnapshot(client, 'acp.sessions.list');

    expect(data).toEqual({ 'run-1': { conversationId: 'run-1' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(detached).toEqual(['acp.sessions.list']);
  });

  it('rejects when the topic fails for good, ignores a retrying error, and times out when nothing arrives', async () => {
    const dead = fakeClient({
      topicErrors: { t: { error: { code: 'UNKNOWN_TOPIC' }, retrying: false } },
    });
    await expect(readSnapshot(dead.client, 't')).rejects.toBeInstanceOf(
      DaemonApiError,
    );

    const silent = fakeClient({});
    await expect(readSnapshot(silent.client, 'quiet', 20)).rejects.toThrow(
      'No snapshot of quiet within 20ms',
    );
  });
});

describe('createDaemonRunsApi', () => {
  it('registerRepository returns the new record, or the one already registered for that path', async () => {
    const fresh = createDaemonRunsApi(
      fakeClient({
        calls: {
          'workspaceRegistry.createWorkspace': {
            success: true,
            data: REPO_RECORD,
          },
        },
      }).client,
    );
    expect(await fresh.registerRepository('repo-1', '/r')).toEqual(REPO_RECORD);

    const taken = createDaemonRunsApi(
      fakeClient({
        calls: {
          'workspaceRegistry.createWorkspace': {
            success: false,
            error: {
              type: 'already-registered',
              record: { ...REPO_RECORD, id: 'repo-older' },
            },
          },
        },
      }).client,
    );
    expect((await taken.registerRepository('repo-1', '/r')).id).toBe(
      'repo-older',
    );

    const missing = createDaemonRunsApi(
      fakeClient({
        calls: {
          'workspaceRegistry.createWorkspace': {
            success: false,
            error: { type: 'path-not-found', path: '/r' },
          },
        },
      }).client,
    );
    await expect(missing.registerRepository('repo-1', '/r')).rejects.toThrow(
      'workspaceRegistry.createWorkspace: path-not-found',
    );
  });

  it('createWorktree sends the daemon’s input shape with a long timeout and surfaces stage failures with their detail', async () => {
    const { client } = fakeClient({
      calls: {
        'workspaceRegistry.createWorktree': (input: unknown) => ({
          success: false,
          error: {
            type: 'stage-failed',
            stage: 'add-worktree',
            message: `git worktree add ${(input as { path: string }).path} failed`,
          },
        }),
      },
    });
    const api = createDaemonRunsApi(client);

    const failure = await api
      .createWorktree({
        workspaceId: 'run-1',
        repositoryId: 'repo-1',
        branch: 'agent/T-1',
        baseRef: 'main',
        path: '/wt/run-1',
      })
      .catch((e) => e);

    expect(failure).toBeInstanceOf(DaemonApiError);
    expect(failure.detail).toEqual({
      type: 'stage-failed',
      stage: 'add-worktree',
      message: 'git worktree add /wt/run-1 failed',
    });
    expect(client.call).toHaveBeenCalledWith(
      'workspaceRegistry.createWorktree',
      {
        workspaceId: 'run-1',
        repositoryId: 'repo-1',
        branch: 'agent/T-1',
        baseRef: 'main',
        path: '/wt/run-1',
        preservePatterns: [],
      },
      { timeoutMs: 300_000 },
    );
  });

  it('deleteWorktree passes deleteBranch through; a transport-level failure becomes a DaemonApiError', async () => {
    const { client } = fakeClient({
      calls: { 'workspaceRegistry.deleteWorktree': { success: true } },
    });
    const api = createDaemonRunsApi(client);

    await api.deleteWorktree('run-1', { deleteBranch: true });
    expect(client.call).toHaveBeenCalledWith(
      'workspaceRegistry.deleteWorktree',
      { workspaceId: 'run-1', deleteBranch: true },
      { timeoutMs: 120_000 },
    );

    const gone = createDaemonRunsApi(fakeClient({}).client);
    await expect(gone.killSession('run-1')).rejects.toThrow(
      'acp.kill: no such procedure acp.kill',
    );
  });

  it('listLocalBranches reads the refs live model for the structured repo path and keeps only local branches', async () => {
    const topic = liveTopic('git.repository.model.refs', {
      repository: hostAbsolutePath('/private/r'),
    });
    const { client } = fakeClient({
      snapshots: {
        [topic]: {
          branches: [
            { type: 'local', branch: 'main', oid: 'a' },
            {
              type: 'remote',
              branch: 'main',
              remote: { name: 'origin', url: '' },
              oid: 'a',
            },
            { type: 'local', branch: 'agent/T-1', oid: 'b' },
          ],
          tags: [],
        },
      },
    });

    expect(
      await createDaemonRunsApi(client).listLocalBranches('/private/r'),
    ).toEqual(['main', 'agent/T-1']);
  });

  it('listSessions and listWorkspaceRecords read their list snapshots', async () => {
    const { client } = fakeClient({
      snapshots: {
        'acp.sessions.list': {
          'run-1': { conversationId: 'run-1', providerId: 'claude' },
        },
        'workspaceRegistry.records.list': {
          'run-1': { id: 'run-1', kind: 'worktree' },
        },
      },
    });
    const api = createDaemonRunsApi(client);

    expect(Object.keys(await api.listSessions())).toEqual(['run-1']);
    expect((await api.listWorkspaceRecords())['run-1'].kind).toBe('worktree');
  });
});
