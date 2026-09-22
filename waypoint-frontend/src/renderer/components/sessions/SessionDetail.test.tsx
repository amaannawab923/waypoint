import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  closeRun,
  closeRunPreview,
  getRunWorktreeHealth,
  stopRun,
} from '@/data/engineApi';
import { patchSessionRun } from '@/lib/sessionsStore';
import { showErrorToast, showInfoToast } from '@/lib/toast';
import type { AgentRun } from '@/types/agentRuns';
import { closeRunQuestion, SessionDetail } from './SessionDetail';

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
  closeRunPreview: jest.fn(),
  closeRun: jest.fn(),
  getRunWorktreeHealth: jest.fn(async () => ({ kind: 'unknown' })),
  getHomeDir: jest.fn(async () => '/Users/me'),
}));
jest.mock('@/lib/sessionsStore', () => ({
  patchSessionRun: jest.fn(),
  refreshSessions: jest.fn(async () => {}),
}));
jest.mock('@/lib/toast', () => ({
  showErrorToast: jest.fn(),
  showInfoToast: jest.fn(),
}));
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

// Customer feedback round 1, Fix 8: a finished run's worktree and branch,
// gone on request — with a confirm that says what is lost.
describe('Close run', () => {
  it('is offered on a finished worktree run, not a live one or a direct-folder one', () => {
    const { rerender } = renderDetail(run({ status: 'done' }));
    expect(
      screen.getByRole('button', { name: 'Close run' }),
    ).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <SessionDetail
          run={run({ status: 'running' })}
          narrow={false}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Close run' })).toBeNull();
    rerender(
      <MemoryRouter>
        <SessionDetail
          run={run({
            status: 'done',
            isolation: 'directory',
            worktreePath: null,
          })}
          narrow={false}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Close run' })).toBeNull();
  });

  it('asks with the preview’s facts, and removes only on yes', async () => {
    (closeRunPreview as jest.Mock).mockResolvedValue({
      branch: 'session/abc1234',
      worktreePath: '/wt/run-abc1234',
      unpushedCommits: 2,
      uncommittedFiles: 0,
      hasPullRequest: false,
      branchWillBeDeleted: true,
    });
    (closeRun as jest.Mock).mockResolvedValue({
      worktreeRemoved: true,
      branchDeleted: true,
      branchKeptBecause: null,
    });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail(run({ status: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close run' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toBe(
      'Delete the worktree for session/abc1234? Its 2 commits were never pushed and will be lost. The transcript stays in Waypoint; the diff will not be available once the worktree is gone.',
    );
    expect(closeRun).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close run' }));
    await waitFor(() => expect(closeRun).toHaveBeenCalledWith('run-abc1234'));
    await waitFor(() =>
      expect(showInfoToast).toHaveBeenCalledWith(
        'Worktree and branch session/abc1234 deleted.',
      ),
    );
    // Once closed, there is nothing left to close or reveal.
    expect(screen.queryByRole('button', { name: 'Close run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show in Finder' })).toBeNull();
    confirm.mockRestore();
  });

  it('a refused close is a toast', async () => {
    (closeRunPreview as jest.Mock).mockRejectedValue(
      new Error(
        'A proposal from this run is still waiting in Review; decide it first.',
      ),
    );
    renderDetail(run({ status: 'needs-review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close run' }));
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'A proposal from this run is still waiting in Review; decide it first.',
      ),
    );
  });
});

// Customer feedback round 1, finding A: ROAD-61's header showed a live
// branch line and an enabled Open PR while its parent repository was gone
// — the facts came from the ledger's row alone.
describe('worktree health (finding A)', () => {
  // `clearAllMocks` keeps implementations; a per-test answer must not
  // outlive its test (the Open PR tests below expect an unknown health).
  afterEach(() => {
    (getRunWorktreeHealth as jest.Mock).mockReset();
    (getRunWorktreeHealth as jest.Mock).mockResolvedValue({ kind: 'unknown' });
  });
  const finished = () =>
    run({
      status: 'done',
      entry: 'dispatched',
      modeId: 'default',
      branch: 'feat/road-61-list',
    });

  it('shows the stored facts until git answers, then the live branch', async () => {
    (getRunWorktreeHealth as jest.Mock).mockResolvedValue({
      kind: 'ok',
      branch: 'feat/road-61-list-renamed',
    });
    renderDetail(finished());
    expect(document.querySelector('[data-run-facts]')).toHaveTextContent(
      'feat/road-61-list',
    );
    await waitFor(() =>
      expect(document.querySelector('[data-run-facts]')).toHaveTextContent(
        'feat/road-61-list-renamed',
      ),
    );
    expect(screen.getByRole('button', { name: 'Open PR' })).toBeEnabled();
  });

  it('an orphaned worktree says so on the facts line and disables Open PR with the reason', async () => {
    (getRunWorktreeHealth as jest.Mock).mockResolvedValue({
      kind: 'orphaned',
      reason: 'fatal: not a git repository',
    });
    renderDetail(finished());
    const orphan = await screen.findByText(
      'worktree orphaned — its parent repository is gone',
    );
    expect(orphan).toHaveAttribute('title', 'fatal: not a git repository');
    const openPr = screen.getByRole('button', { name: 'Open PR' });
    expect(openPr).toBeDisabled();
    expect(openPr).toHaveAttribute(
      'title',
      "Can't open a PR — this worktree's repository is gone. fatal: not a git repository",
    );
    expect(getRunWorktreeHealth).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a direct-folder run', () => {
    renderDetail(
      run({ status: 'done', isolation: 'directory', worktreePath: null }),
    );
    expect(getRunWorktreeHealth).not.toHaveBeenCalled();
  });
});

describe('closeRunQuestion', () => {
  const STAYS =
    'The transcript stays in Waypoint; the diff will not be available once the worktree is gone.';

  it('says what is lost: nothing, the unpushed commits, or that the branch stays for its PR', () => {
    expect(
      closeRunQuestion({
        branch: 'b',
        unpushedCommits: 0,
        uncommittedFiles: 0,
        hasPullRequest: false,
      }),
    ).toBe(`Delete the worktree and branch for b? ${STAYS}`);
    expect(
      closeRunQuestion({
        branch: 'b',
        unpushedCommits: null,
        uncommittedFiles: null,
        hasPullRequest: false,
      }),
    ).toBe(`Delete the worktree and branch for b? ${STAYS}`);
    expect(
      closeRunQuestion({
        branch: 'b',
        unpushedCommits: 1,
        uncommittedFiles: 0,
        hasPullRequest: false,
      }),
    ).toBe(
      `Delete the worktree for b? Its 1 commit was never pushed and will be lost. ${STAYS}`,
    );
    expect(
      closeRunQuestion({
        branch: 'b',
        unpushedCommits: 0,
        uncommittedFiles: 0,
        hasPullRequest: true,
      }),
    ).toBe(
      `Delete the worktree for b? The branch stays — it still has an open pull request. ${STAYS}`,
    );
  });

  // B2 (PR #88 review): the old confirm claimed "The transcript and diff
  // stay in Waypoint" — false, since runs:diff computes live from the
  // worktree Close just deleted. Every variant now says only what stays.
  it('never claims the diff stays', () => {
    for (const preview of [
      {
        branch: 'b',
        unpushedCommits: 0,
        uncommittedFiles: 0,
        hasPullRequest: false,
      },
      {
        branch: 'b',
        unpushedCommits: 2,
        uncommittedFiles: 0,
        hasPullRequest: false,
      },
      {
        branch: 'b',
        unpushedCommits: 0,
        uncommittedFiles: 0,
        hasPullRequest: true,
      },
      {
        branch: 'b',
        unpushedCommits: 0,
        uncommittedFiles: 4,
        hasPullRequest: false,
      },
    ]) {
      const question = closeRunQuestion(preview);
      expect(question).not.toMatch(/diff stay/i);
      expect(question).toContain(
        'the diff will not be available once the worktree is gone',
      );
    }
  });

  // B1 (PR #88 review): CLOSABLE includes failed/cancelled/interrupted,
  // where uncommitted work is the norm, not the exception — the confirm
  // must name it, whether or not a pull request or unpushed commits are
  // also in play.
  it('names uncommitted files that would be lost, alongside or instead of unpushed commits', () => {
    expect(
      closeRunQuestion({
        branch: 'agent/PL-12',
        unpushedCommits: 0,
        uncommittedFiles: 3,
        hasPullRequest: false,
      }),
    ).toBe(
      `Delete the worktree for agent/PL-12? 3 uncommitted changes were never committed and will be lost. ${STAYS}`,
    );
    expect(
      closeRunQuestion({
        branch: 'agent/PL-12',
        unpushedCommits: 0,
        uncommittedFiles: 1,
        hasPullRequest: false,
      }),
    ).toBe(
      `Delete the worktree for agent/PL-12? 1 uncommitted change was never committed and will be lost. ${STAYS}`,
    );
    // Alongside unpushed commits.
    expect(
      closeRunQuestion({
        branch: 'agent/PL-12',
        unpushedCommits: 2,
        uncommittedFiles: 1,
        hasPullRequest: false,
      }),
    ).toBe(
      `Delete the worktree for agent/PL-12? Its 2 commits were never pushed and will be lost. 1 uncommitted change was never committed and will be lost. ${STAYS}`,
    );
    // A pull request keeps the branch, but does not exempt uncommitted
    // work — the PR only reflects what was pushed.
    expect(
      closeRunQuestion({
        branch: 'agent/PL-12',
        unpushedCommits: 0,
        uncommittedFiles: 2,
        hasPullRequest: true,
      }),
    ).toBe(
      `Delete the worktree for agent/PL-12? The branch stays — it still has an open pull request. 2 uncommitted changes were never committed and will be lost. ${STAYS}`,
    );
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
