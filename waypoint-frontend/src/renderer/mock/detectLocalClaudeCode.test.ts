import { detectLocalClaudeCode } from './api';

// W1.2: this used to unconditionally resolve `{status:'connected',
// version:'2.4.1'}` after a fake delay — see
// docs/design/waypoint-revamp-architecture.md §1.4. These tests exercise
// the real Probe<T> construction from what window.electron.copilot.detect()
// (the Electron main-process `claude --version` probe) actually reports.
describe('detectLocalClaudeCode', () => {
  const mockDetect = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    (window as unknown as { electron: typeof window.electron }).electron = {
      copilot: { detect: mockDetect },
    } as unknown as typeof window.electron;
  });

  it('constructs a `present` probe only from a real version and path', async () => {
    mockDetect.mockResolvedValueOnce({
      ok: true,
      version: '1.2.3',
      path: '/opt/homebrew/bin/claude',
    });

    const probe = await detectLocalClaudeCode();

    expect(probe.state).toBe('present');
    if (probe.state !== 'present') throw new Error('expected present');
    expect(probe.value).toEqual({
      version: '1.2.3',
      path: '/opt/homebrew/bin/claude',
    });
    expect(probe.via).toBe('claude --version');
    expect(typeof probe.observedAt).toBe('string');
  });

  it('constructs an `absent` probe from a clean not-found result', async () => {
    mockDetect.mockResolvedValueOnce({
      ok: false,
      reason: 'not-found',
      message: '"claude" was not found on PATH.',
    });

    const probe = await detectLocalClaudeCode();

    expect(probe).toMatchObject({
      state: 'absent',
      reason: '"claude" was not found on PATH.',
      via: 'claude --version',
    });
  });

  it('constructs an `error` probe from a probe-level failure (e.g. a timeout)', async () => {
    mockDetect.mockResolvedValueOnce({
      ok: false,
      reason: 'error',
      message: 'Timed out waiting for "claude --version" after 5s.',
    });

    const probe = await detectLocalClaudeCode();

    expect(probe).toMatchObject({
      state: 'error',
      reason: 'Timed out waiting for "claude --version" after 5s.',
      via: 'claude --version',
    });
  });

  it('degrades to `error` rather than throwing when the IPC call itself rejects', async () => {
    mockDetect.mockRejectedValueOnce(new Error('IPC unavailable'));

    const probe = await detectLocalClaudeCode();

    expect(probe).toMatchObject({
      state: 'error',
      reason: 'IPC unavailable',
      via: 'claude --version',
    });
  });
});
