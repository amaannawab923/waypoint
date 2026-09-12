import {
  callEngineFallible,
  cancelTurn,
  getRunDiff,
  listRunBranches,
  onRunChanged,
  resolvePermission,
  resumeRun,
  revealRunWorktree,
  sendPrompt,
  startRun,
  stopRun,
} from './engineApi';

const engine = {
  call: jest.fn(),
  stopRun: jest.fn(),
  runDiff: jest.fn(),
  revealRunWorktree: jest.fn(),
  onRunChanged: jest.fn(),
  startRun: jest.fn(),
  resumeRun: jest.fn(),
  listRunBranches: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { engine };
});

describe('callEngineFallible', () => {
  it('unwraps a successful envelope to its data', async () => {
    engine.call.mockResolvedValueOnce({
      success: true,
      data: { turns: [], nextCursor: null },
    });
    await expect(
      callEngineFallible('acp.getHistory', { x: 1 }),
    ).resolves.toEqual({ turns: [], nextCursor: null });
    expect(engine.call).toHaveBeenCalledWith('acp.getHistory', { x: 1 });
  });

  it('turns a refusal into a rejection carrying the daemon’s own words', async () => {
    engine.call.mockResolvedValueOnce({
      success: false,
      error: { type: 'session-not-found', message: 'no session run-x' },
    });
    await expect(callEngineFallible('acp.sendPrompt', {})).rejects.toThrow(
      'acp.sendPrompt: session-not-found: no session run-x',
    );
    engine.call.mockResolvedValueOnce('nonsense');
    await expect(callEngineFallible('acp.sendPrompt', {})).rejects.toThrow(
      'acp.sendPrompt answered in an unexpected shape.',
    );
  });
});

describe('the session procedures send exactly the allowlisted shapes', () => {
  it('sendPrompt is text only, resolvePermission is one request and one option, cancelTurn is the id', async () => {
    engine.call.mockResolvedValue({ success: true, data: { queued: false } });
    await expect(sendPrompt('run-a1', 'Run the tests')).resolves.toEqual({
      queued: false,
    });
    await resolvePermission('run-a1', 'perm-1', 'allow_once');
    await cancelTurn('run-a1');
    expect(engine.call.mock.calls).toEqual([
      [
        'acp.sendPrompt',
        { conversationId: 'run-a1', prompt: { text: 'Run the tests' } },
      ],
      [
        'acp.resolvePermission',
        {
          conversationId: 'run-a1',
          requestId: 'perm-1',
          optionId: 'allow_once',
        },
      ],
      ['acp.cancelTurn', { conversationId: 'run-a1' }],
    ]);
  });
});

describe('the W4 run channels', () => {
  it('pass their one argument through and hand back the answer', async () => {
    engine.startRun.mockResolvedValueOnce({
      id: 'run-n1',
      status: 'provisioning',
    });
    engine.resumeRun.mockResolvedValueOnce({
      outcome: 'loaded',
      status: 'running',
    });
    engine.listRunBranches.mockResolvedValueOnce({
      branches: ['main'],
      suggested: 'main',
    });
    const input = {
      folder: 'f-abc',
      ownerMemberId: 'mem-1',
      providerId: 'claude' as const,
      isolation: 'worktree' as const,
      autoApprove: true,
      baseRef: 'main',
      firstMessage: null,
    };
    await expect(startRun(input)).resolves.toMatchObject({ id: 'run-n1' });
    expect(engine.startRun).toHaveBeenCalledWith(input);
    await expect(resumeRun('run-i1')).resolves.toEqual({
      outcome: 'loaded',
      status: 'running',
    });
    await expect(listRunBranches('f-abc')).resolves.toMatchObject({
      suggested: 'main',
    });
  });

  it("strip Electron's IPC wrapper so a refusal is main's own sentence", async () => {
    engine.startRun.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'runs:start': Error: Compass's linked repository (~/x) is not on this machine.",
      ),
    );
    await expect(startRun({} as never)).rejects.toThrow(
      "Compass's linked repository (~/x) is not on this machine.",
    );
    engine.stopRun.mockRejectedValueOnce(new Error('plain'));
    await expect(stopRun('run-a1')).rejects.toThrow('plain');
  });
});

describe('run control', () => {
  it('forwards the run id to main and hands back its answer', async () => {
    engine.stopRun.mockResolvedValueOnce({
      outcome: 'stopped',
      status: 'cancelled',
    });
    engine.runDiff.mockResolvedValueOnce({
      files: [],
      patch: '',
      truncated: false,
    });
    engine.revealRunWorktree.mockResolvedValueOnce(undefined);
    await expect(stopRun('run-a1')).resolves.toEqual({
      outcome: 'stopped',
      status: 'cancelled',
    });
    await expect(getRunDiff('run-a1')).resolves.toMatchObject({ files: [] });
    await revealRunWorktree('run-a1');
    expect(engine.stopRun).toHaveBeenCalledWith('run-a1');
    expect(engine.runDiff).toHaveBeenCalledWith('run-a1');
    expect(engine.revealRunWorktree).toHaveBeenCalledWith('run-a1');

    const off = jest.fn();
    engine.onRunChanged.mockReturnValueOnce(off);
    const cb = jest.fn();
    expect(onRunChanged(cb)).toBe(off);
    expect(engine.onRunChanged).toHaveBeenCalledWith(cb);
  });
});
