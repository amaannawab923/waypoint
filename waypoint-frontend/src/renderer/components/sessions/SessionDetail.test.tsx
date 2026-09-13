import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { resumeRun, stopRun } from '@/data/engineApi';
import { patchSessionRun, refreshSessions } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun } from '@/types/agentRuns';
import { SessionDetail } from './SessionDetail';

// The header's W4 additions — Resume for an interrupted run and the
// failure sentence — with the two heavy panes stubbed; the transcript and
// the diff have their own tests.
jest.mock('./SessionTranscript', () => ({
  SessionTranscript: () => <div data-testid="transcript" />,
}));
jest.mock('./DiffPane', () => ({
  DiffPane: () => <div data-testid="diff" />,
}));
jest.mock('@/lib/useTicketLabel', () => ({
  useTicketSummary: () => null,
}));
jest.mock('@/data/engineApi', () => ({
  resumeRun: jest.fn(),
  stopRun: jest.fn(),
  revealRunWorktree: jest.fn(),
  openRunPullRequest: jest.fn(),
  getHomeDir: jest.fn(async () => '/Users/me'),
}));
jest.mock('@/lib/sessionsStore', () => ({
  patchSessionRun: jest.fn(),
  refreshSessions: jest.fn(async () => {}),
}));
jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));
jest.mock('@/data/api', () => ({ renameAgentRun: jest.fn() }));

const run = (over: Partial<AgentRun>): AgentRun =>
  ({
    id: 'run-abc1234',
    status: 'running',
    providerId: 'claude',
    entry: 'independent',
    ticketId: null,
    projectId: 'proj-1',
    title: null,
    isolation: 'worktree',
    cwd: '/wt/run-abc1234',
    autoApprove: false,
    branch: 'session/abc1234',
    baseRef: 'main',
    worktreePath: '/wt/run-abc1234',
    errorKind: null,
    errorMessage: null,
    prUrl: null,
    createdAt: '2026-09-12T10:00:00Z',
    startedAt: null,
    updatedAt: '2026-09-12T10:00:00Z',
    ...over,
  }) as AgentRun;

function renderDetail(r: AgentRun) {
  return render(
    <MemoryRouter>
      <SessionDetail run={r} narrow={false} onBack={jest.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('SessionDetail (W4)', () => {
  it('names the run by its title before its branch', () => {
    renderDetail(run({ title: 'Fix the flaky test' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Fix the flaky test',
    );
  });

  it('shows Resume only for an interrupted run, beside Stop', () => {
    const { rerender } = renderDetail(run({ status: 'running' }));
    expect(
      screen.queryByRole('button', { name: /Resume/ }),
    ).not.toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <SessionDetail
          run={run({ status: 'interrupted' })}
          narrow={false}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('Resume is disabled, with the reason, when the run has no folder', () => {
    renderDetail(run({ status: 'interrupted', worktreePath: null, cwd: null }));
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAttribute(
      'title',
      'This run has no folder to resume in.',
    );
  });

  it('a direct run reads "in ~/folder", is named by its folder, and carries the auto mark (W4b)', async () => {
    renderDetail(
      run({
        isolation: 'directory',
        cwd: '/Users/me/code/compass-web',
        worktreePath: null,
        branch: null,
        baseRef: null,
        autoApprove: true,
      }),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'compass-web',
    );
    await waitFor(() =>
      expect(screen.getByText('~/code/compass-web')).toBeInTheDocument(),
    );
    expect(document.querySelector('[data-auto-mark]')).toHaveTextContent(
      'auto',
    );
    expect(screen.getByRole('tab', { name: /Changes/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /^Diff/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show in Finder' }),
    ).toBeInTheDocument();
  });

  it('loaded: patches the run to running and re-reads, no toast', async () => {
    (resumeRun as jest.Mock).mockResolvedValue({
      outcome: 'loaded',
      status: 'running',
    });
    renderDetail(run({ status: 'interrupted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(refreshSessions).toHaveBeenCalled());
    expect(resumeRun).toHaveBeenCalledWith('run-abc1234');
    expect(patchSessionRun).toHaveBeenCalledWith('run-abc1234', {
      status: 'running',
    });
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('replaced-by-new: says so', async () => {
    (resumeRun as jest.Mock).mockResolvedValue({
      outcome: 'replaced-by-new',
      status: 'running',
    });
    renderDetail(run({ status: 'interrupted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(refreshSessions).toHaveBeenCalled());
    expect(patchSessionRun).toHaveBeenCalledWith('run-abc1234', {
      status: 'running',
    });
    expect(showErrorToast).toHaveBeenCalledWith(
      expect.stringContaining('could not restore the previous conversation'),
    );
  });

  it("a refused resume shows main's sentence and re-reads (the run is back to interrupted there)", async () => {
    (resumeRun as jest.Mock).mockRejectedValue(
      new Error('acp.start: auth-required'),
    );
    renderDetail(run({ status: 'interrupted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith('acp.start: auth-required'),
    );
    expect(patchSessionRun).not.toHaveBeenCalled();
    expect(refreshSessions).toHaveBeenCalled();
  });

  it('a failed run shows its error kind and message under the meta row', () => {
    renderDetail(
      run({
        status: 'failed',
        errorKind: 'start',
        errorMessage: 'acp.start: spawn-failed: claude not found',
      }),
    );
    expect(document.querySelector('[data-run-error]')).toHaveTextContent(
      'Session start: acp.start: spawn-failed: claude not found',
    );
    expect(
      screen.queryByRole('button', { name: 'Stop' }),
    ).not.toBeInTheDocument();
  });

  it('Stop still works as in W3', async () => {
    (stopRun as jest.Mock).mockResolvedValue({
      outcome: 'stopped',
      status: 'cancelled',
    });
    renderDetail(run({ status: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(patchSessionRun).toHaveBeenCalledWith('run-abc1234', {
        status: 'cancelled',
      }),
    );
  });
});

describe('rename (W5a)', () => {
  it('renames from the header on Enter, through the ledger, and patches the store; Escape leaves it', async () => {
    const { renameAgentRun } = jest.requireMock('@/data/api') as {
      renameAgentRun: jest.Mock;
    };
    renameAgentRun.mockResolvedValue({ id: 'run-1', title: 'Guard the write' });
    renderDetail(run({ id: 'run-1', title: 'ROAD-116 · Fix' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Run title' });
    expect(input).toHaveValue('ROAD-116 · Fix');
    fireEvent.change(input, { target: { value: '  Guard the write  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(renameAgentRun).toHaveBeenCalledWith('run-1', 'Guard the write'),
    );
    await waitFor(() =>
      expect(patchSessionRun).toHaveBeenCalledWith('run-1', {
        title: 'Guard the write',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const again = screen.getByRole('textbox', { name: 'Run title' });
    fireEvent.change(again, { target: { value: 'nope' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(
      screen.queryByRole('textbox', { name: 'Run title' }),
    ).not.toBeInTheDocument();
    expect(renameAgentRun).toHaveBeenCalledTimes(1);
  });
});

describe('Open PR (W6)', () => {
  it('offers Open PR on a finished writing run without a PR; opening patches the link in; a failure is a toast', async () => {
    const { openRunPullRequest } = jest.requireMock('@/data/engineApi') as {
      openRunPullRequest: jest.Mock;
    };
    openRunPullRequest.mockResolvedValueOnce({
      kind: 'opened',
      url: 'https://github.com/o/r/pull/61',
    });
    renderDetail(
      run({
        id: 'run-1',
        entry: 'dispatched',
        intent: 'fix',
        modeId: 'bypassPermissions',
        branch: 'agent/ROAD-1',
        status: 'needs-review',
        prUrl: null,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));
    await waitFor(() =>
      expect(openRunPullRequest).toHaveBeenCalledWith('run-1'),
    );
    await waitFor(() =>
      expect(patchSessionRun).toHaveBeenCalledWith('run-1', {
        prUrl: 'https://github.com/o/r/pull/61',
      }),
    );

    openRunPullRequest.mockResolvedValueOnce({
      kind: 'failed',
      stage: 'push',
      message: 'denied',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith('Push failed: denied'),
    );
  });

  it('no Open PR for a plan-mode run, a run with a PR, or a run still running', () => {
    renderDetail(
      run({
        entry: 'dispatched',
        intent: 'investigate',
        modeId: 'plan',
        branch: 'agent/x',
        status: 'needs-review',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Open PR' }),
    ).not.toBeInTheDocument();
    renderDetail(
      run({
        entry: 'dispatched',
        intent: 'fix',
        modeId: null,
        branch: 'agent/y',
        status: 'done',
        prUrl: 'https://github.com/o/r/pull/1',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Open PR' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Pull request ↗')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/1',
    );
    renderDetail(
      run({
        entry: 'dispatched',
        intent: 'fix',
        modeId: null,
        branch: 'agent/z',
        status: 'running',
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Open PR' }),
    ).not.toBeInTheDocument();
  });
});
