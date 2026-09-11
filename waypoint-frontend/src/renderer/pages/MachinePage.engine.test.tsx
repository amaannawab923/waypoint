import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import type { EngineStatus } from '@/types/engine';
import {
  installEngine,
  startEngine,
  stopEngine,
  onEngineStatusChanged,
} from '@/data/engineApi';
import { listProjects, detectLocalClaudeCode } from '@/data/api';
import MachinePage from './MachinePage';

// This file covers only the "Agent engine" section (ROAD-48/51) — the rest
// of MachinePage (repo links, the Claude CLI probe, the data-location note)
// is out of this task's scope and stubbed to the minimum that lets the page
// mount without touching a real backend.
jest.mock('@/data/api', () => ({
  listProjects: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));

jest.mock('@/data/engineApi', () => ({
  installEngine: jest.fn(),
  startEngine: jest.fn(),
  stopEngine: jest.fn(),
  onEngineStatusChanged: jest.fn(),
}));

const NOT_INSTALLED: EngineStatus = {
  kind: 'not-installed',
  installDir: '/Users/max/Library/Application Support/Waypoint/engine/0.1.0',
};
const STOPPED: EngineStatus = {
  kind: 'stopped',
  installDir: '/Users/max/Library/Application Support/Waypoint/engine/0.1.0',
  version: '0.1.0',
};
const RUNNING: EngineStatus = {
  kind: 'running',
  since: 1_000,
  health: {
    status: 'ok',
    version: '0.1.0',
    uptimeMs: 65_000,
    protocolVersion: '1.0.0',
  },
  agreed: {
    protocolVersion: '1.0.0',
    agreedVersion: '1.0.0',
    agreedMinor: 0,
    server: { appVersion: '0.1.0', daemonId: 'daemon-1', startedAt: 1000 },
  },
  transport: 'socket',
};
const INCOMPATIBLE: EngineStatus = {
  kind: 'failed',
  since: 1_000,
  stage: 'initialize',
  message: 'This engine speaks protocol 2.0.0; Waypoint speaks 1.0.0.',
  incompatible: {
    type: 'protocol-incompatible',
    action: 'upgrade Waypoint',
    clientProtocolVersion: '1.0.0',
    serverProtocolVersion: '2.0.0',
  },
};
const START_FAILED: EngineStatus = {
  kind: 'failed',
  since: 1_000,
  stage: 'start',
  message: 'could not run engine launcher: ENOENT',
};

/** Captures the callback registered with onEngineStatusChanged so a test
 *  can simulate a live push, matching the real bridge's push-channel shape. */
function capturePushCallback(): { push: (status: EngineStatus) => void } {
  let cb: ((status: EngineStatus) => void) | null = null;
  jest.mocked(onEngineStatusChanged).mockImplementation((handler) => {
    cb = handler;
    return jest.fn();
  });
  return {
    push: (status) => {
      if (!cb) throw new Error('onEngineStatusChanged was never called');
      act(() => cb!(status));
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(detectLocalClaudeCode).mockResolvedValue({
    state: 'absent',
    reason: '"claude" was not found on PATH.',
    observedAt: new Date().toISOString(),
    via: 'claude --version',
  });
  jest.mocked(onEngineStatusChanged).mockReturnValue(jest.fn());
});

/**
 * Renders the full page (this section lives inside MachinePage, not as its
 * own route) and flushes the other, unrelated `useAsync` fetches
 * (listProjects, detectLocalClaudeCode) this test file stubs to an empty/
 * absent result — wrapped in `act` so their state updates settle before any
 * assertion, rather than warning as an unwrapped update mid-test.
 */
async function mount(): Promise<void> {
  await act(async () => {
    render(<MachinePage />);
  });
}

describe('MachinePage — Agent engine section', () => {
  it('shows the pinned engine name, version, and commit', async () => {
    jest.mocked(installEngine).mockResolvedValue(STOPPED);
    await mount();

    expect(
      await screen.findByText('emdash-workspace-server 0.1.0 · 9b102a5f3'),
    ).toBeInTheDocument();
  });

  it('shows a loading skeleton before install() has answered', async () => {
    jest.mocked(installEngine).mockReturnValue(new Promise(() => {}));
    await mount();

    expect(screen.getByText('Agent engine')).toBeInTheDocument();
    expect(
      screen.queryByText(
        /Not installed|Installed|Running|Starting|Stopping|Failed/,
      ),
    ).not.toBeInTheDocument();
  });

  it('calls install() on mount to get a truthful first reading, not a fabricated default', async () => {
    jest.mocked(installEngine).mockResolvedValue(NOT_INSTALLED);
    await mount();

    await screen.findByText(`Not installed at ${NOT_INSTALLED.installDir}`);
    expect(installEngine).toHaveBeenCalledTimes(1);
  });

  it('not-installed: shows "Not installed at <dir>" and a Check installation action', async () => {
    jest.mocked(installEngine).mockResolvedValue(NOT_INSTALLED);
    await mount();

    expect(
      await screen.findByText(`Not installed at ${NOT_INSTALLED.installDir}`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Check installation' }),
    ).toBeInTheDocument();
  });

  it('stopped: shows the installed version and a Start action that calls startEngine()', async () => {
    jest.mocked(installEngine).mockResolvedValue(STOPPED);
    jest.mocked(startEngine).mockResolvedValue(RUNNING);
    await mount();

    expect(
      await screen.findByText('Installed (version 0.1.0) — not running.'),
    ).toBeInTheDocument();
    const startButton = screen.getByRole('button', { name: 'Start' });

    await act(async () => {
      startButton.click();
      await Promise.resolve();
    });

    expect(startEngine).toHaveBeenCalledTimes(1);
  });

  it('running: shows version and uptime, and a Stop action that calls stopEngine()', async () => {
    jest.mocked(installEngine).mockResolvedValue(RUNNING);
    jest.mocked(stopEngine).mockResolvedValue(STOPPED);
    await mount();

    // 65_000ms = 1m 5s.
    expect(
      await screen.findByText('Running · version 0.1.0 · up for 1m 5s'),
    ).toBeInTheDocument();
    const stopButton = screen.getByRole('button', { name: 'Stop' });

    await act(async () => {
      stopButton.click();
      await Promise.resolve();
    });

    expect(stopEngine).toHaveBeenCalledTimes(1);
  });

  it('disables the action button while a click is in flight', async () => {
    jest.mocked(installEngine).mockResolvedValue(STOPPED);
    let resolveStart: (status: EngineStatus) => void = () => {};
    jest.mocked(startEngine).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await mount();
    const startButton = await screen.findByRole('button', { name: 'Start' });

    act(() => startButton.click());

    expect(
      await screen.findByRole('button', { name: 'Working…' }),
    ).toBeDisabled();

    await act(async () => {
      resolveStart(RUNNING);
      await Promise.resolve();
    });
  });

  it('protocol-incompatible failure: names both protocol versions, says "update Waypoint", and offers no retry', async () => {
    jest.mocked(installEngine).mockResolvedValue(INCOMPATIBLE);
    await mount();

    expect(
      await screen.findByText(
        'This engine speaks protocol 2.0.0; Waypoint speaks 1.0.0 — update Waypoint.',
      ),
    ).toBeInTheDocument();
    // "Upgrade, don't retry" (supervisor.ts's own decision) — no button that
    // could suggest trying the same mismatched handshake again.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('No action available')).toBeInTheDocument();
  });

  it('a non-incompatible failure shows the real message and a Retry action', async () => {
    jest.mocked(installEngine).mockResolvedValue(START_FAILED);
    await mount();

    expect(
      await screen.findByText('Failed: could not run engine launcher: ENOENT'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('updates live when the supervisor pushes a status change, with no user action', async () => {
    jest.mocked(installEngine).mockResolvedValue(STOPPED);
    const { push } = capturePushCallback();
    await mount();
    await screen.findByText('Installed (version 0.1.0) — not running.');

    push({ kind: 'starting', since: 2_000 });

    expect(await screen.findByText('Starting…')).toBeInTheDocument();
    expect(screen.getByText('In progress…')).toBeInTheDocument();
  });
});
