import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { stopRun } from '@/data/engineApi';
import { patchSessionRun } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun } from '@/types/agentRuns';
import { SessionDetail } from './SessionDetail';

// The header — Stop, the failure sentence, rename, Open PR — with the two
// heavy panes stubbed; the transcript and the diff have their own tests.
// Never-lock (2026-09-20): there is no Resume button any more; a run that
// is not live is continued by messaging it.
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

  // W5c: the verdict finalize read from the report, beside the status.
  it('shows the verdict chip once the run has one, and nothing before', () => {
    const { rerender, container } = renderDetail(
      run({ status: 'running', entry: 'dispatched', intent: 'investigate' }),
    );
    expect(container.querySelector('[data-verdict-chip]')).toBeNull();
    rerender(
      <MemoryRouter>
        <SessionDetail
          run={run({
            status: 'needs-review',
            entry: 'dispatched',
            intent: 'investigate',
            verdict: 'not-a-bug',
          })}
          narrow={false}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-verdict-chip]')).toHaveTextContent(
      'not a bug',
    );
  });

  it.each([
    'queued',
    'provisioning',
    'running',
    'blocked',
    'finishing',
    'needs-review',
    'done',
    'interrupted',
    'failed',
    'cancelled',
  ] as const)(
    'never offers a Resume button for a %s run (never-lock)',
    (status) => {
      renderDetail(run({ status, worktreePath: null, cwd: null }));
      expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
      expect(screen.queryByText(/no folder to resume/)).toBeNull();
    },
  );

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

    // Never-lock: a branch whose PR is still open gets its new commits
    // pushed to it — `updated` patches the link in the same way.
    (patchSessionRun as jest.Mock).mockClear();
    openRunPullRequest.mockResolvedValueOnce({
      kind: 'updated',
      url: 'https://github.com/o/r/pull/61',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));
    await waitFor(() =>
      expect(patchSessionRun).toHaveBeenCalledWith('run-1', {
        prUrl: 'https://github.com/o/r/pull/61',
      }),
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
