import { DaemonApiError } from './daemonApi';
import { registerConversation } from './registerConversation';

const run = {
  id: 'run-abc1234',
  providerId: 'claude',
  title: 'Fix the thing',
  createdAt: '2026-09-12T00:00:00.000Z',
};

function logger() {
  return { warn: jest.fn() };
}

describe('registerConversation', () => {
  it('registers the run with its own creation time, and says nothing when the index agrees', async () => {
    const daemon = {
      createConversation: jest.fn(async () => ({ mismatch: [] })),
    };
    const log = logger();
    await registerConversation(daemon, log, run, '/wt/run-abc1234');
    expect(daemon.createConversation).toHaveBeenCalledWith({
      conversationId: 'run-abc1234',
      providerId: 'claude',
      cwd: '/wt/run-abc1234',
      createdAt: Date.parse('2026-09-12T00:00:00.000Z'),
      title: 'Fix the thing',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('names the immutable fields an existing record disagrees on, without throwing', async () => {
    const daemon = {
      createConversation: jest.fn(async () => ({ mismatch: ['cwd'] })),
    };
    const log = logger();
    await expect(
      registerConversation(daemon, log, run, '/wt/elsewhere'),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'engine: conversation already registered with different immutable fields',
      { runId: 'run-abc1234', fields: ['cwd'] },
    );
  });

  it('logs a real failure and resolves — the caller starts the session regardless', async () => {
    const daemon = {
      createConversation: jest.fn(async () => {
        throw new DaemonApiError(
          'conversations.create',
          null,
          'conversations.create: no such procedure',
        );
      }),
    };
    const log = logger();
    await expect(
      registerConversation(daemon, log, run, '/wt/run-abc1234'),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'engine: conversation registration failed',
      {
        runId: 'run-abc1234',
        message: 'conversations.create: no such procedure',
      },
    );
  });

  it('falls back to now for a run whose creation time does not parse', async () => {
    const daemon = {
      createConversation: jest.fn(async (input: { createdAt: number }) => ({
        mismatch: [] as string[],
        seen: input,
      })),
    };
    const before = Date.now();
    await registerConversation(
      daemon,
      logger(),
      { ...run, createdAt: 'not a date' },
      '/wt/run-abc1234',
    );
    expect(
      daemon.createConversation.mock.calls[0][0].createdAt,
    ).toBeGreaterThanOrEqual(before);
  });
});
