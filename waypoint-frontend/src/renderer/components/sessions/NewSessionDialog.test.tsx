import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { detectLocalClaudeCode, getWorkspace } from '@/data/api';
import {
  chooseFolder,
  listRecentFolders,
  listRunBranches,
  startRun,
} from '@/data/engineApi';
import { useSessionsSnapshot } from '@/lib/sessionsStore';
import type { AgentRun, SessionFolder } from '@/types/agentRuns';
import {
  autoApproveSentence,
  defaultAutoApprove,
  defaultIsolation,
  LAST_FOLDER_KEY,
  NewSessionDialog,
} from './NewSessionDialog';

jest.mock('@/data/engineApi', () => ({
  chooseFolder: jest.fn(),
  listRecentFolders: jest.fn(),
  listRunBranches: jest.fn(),
  startRun: jest.fn(),
}));
jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));
jest.mock('@/lib/sessionsStore', () => ({ useSessionsSnapshot: jest.fn() }));

const folder = (over: Partial<SessionFolder>): SessionFolder => ({
  handle: 'f-1',
  path: '/Users/me/code/waypoint',
  displayPath: '~/code/waypoint',
  name: 'waypoint',
  kind: 'repo',
  projectId: 'proj-wp',
  projectName: 'Waypoint',
  lastAutoApprove: null,
  lastUsedAt: null,
  ...over,
});
const REPO = folder({});
const PLAIN = folder({
  handle: 'f-2',
  path: '/Users/me/notes',
  displayPath: '~/notes',
  name: 'notes',
  kind: 'folder',
  projectId: null,
  projectName: null,
});

const RUNNING = { kind: 'running', since: 1 } as never;
const STOPPED = { kind: 'stopped', installDir: '/x', version: '1' } as never;

function renderDialog(engine: unknown = RUNNING, onClose = jest.fn()) {
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <Routes>
        <Route
          path="/sessions"
          element={
            <NewSessionDialog open onClose={onClose} engine={engine as never} />
          }
        />
        <Route path="/sessions/:runId" element={<div>session page</div>} />
        <Route path="/machine" element={<div>machine page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

const startButton = () => screen.getByRole('button', { name: 'Start session' });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  (useSessionsSnapshot as jest.Mock).mockReturnValue({ runs: [] });
  (listRecentFolders as jest.Mock).mockResolvedValue([REPO, PLAIN]);
  (listRunBranches as jest.Mock).mockResolvedValue({
    branches: ['feat/x', 'main'],
    suggested: 'main',
  });
  (getWorkspace as jest.Mock).mockResolvedValue({
    defaultAgentProvider: 'claude',
  });
  (detectLocalClaudeCode as jest.Mock).mockResolvedValue({ state: 'present' });
});

describe('the defaults fall out of the folder', () => {
  it('a repository → worktree + auto-approve on; a plain folder → direct + off; the last choice wins', () => {
    expect(defaultIsolation(REPO)).toBe('worktree');
    expect(defaultIsolation(PLAIN)).toBe('directory');
    expect(defaultAutoApprove(REPO, 'worktree')).toBe(true);
    expect(defaultAutoApprove(REPO, 'directory')).toBe(false);
    expect(defaultAutoApprove(PLAIN, 'directory')).toBe(false);
    expect(
      defaultAutoApprove(folder({ lastAutoApprove: true }), 'directory'),
    ).toBe(true);
    expect(
      defaultAutoApprove(folder({ lastAutoApprove: false }), 'worktree'),
    ).toBe(false);
    expect(autoApproveSentence('worktree')).toMatch(/own copy/);
    expect(autoApproveSentence('directory')).toMatch(
      /edits this folder directly/,
    );
  });
});

describe('NewSessionDialog', () => {
  it('lists the folders main offers, preselects the first, reads its branches, and defaults a repo to worktree + auto-approve', async () => {
    renderDialog();
    const options = await screen.findAllByRole('radio');
    expect(options[0]).toHaveTextContent('waypoint');
    expect(options[0]).toHaveTextContent('Waypoint');
    expect(options[0]).toHaveTextContent('~/code/waypoint');
    expect(options[0]).toHaveTextContent('git repo');
    expect(options[1]).toHaveTextContent('notes');
    expect(options[1]).toHaveTextContent('folder');
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(listRunBranches).toHaveBeenCalledWith('f-1'));
    await waitFor(() =>
      expect(screen.getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(
      document.querySelector('[data-auto-approve-sentence]'),
    ).toHaveTextContent(/own copy/);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Base branch')).toHaveValue('main'),
    );
    expect(screen.getByLabelText('Work in')).toHaveValue('worktree');
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('a plain folder: direct, auto-approve off with the warning sentence, no Advanced fold, no branch read', async () => {
    (listRecentFolders as jest.Mock).mockResolvedValue([PLAIN, REPO]);
    renderDialog();
    await screen.findAllByRole('radio');
    await waitFor(() =>
      expect(
        document.querySelector('[data-auto-approve-sentence]'),
      ).toHaveTextContent(/edits this folder directly/),
    );
    expect(listRunBranches).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.queryByRole('button', { name: /Advanced/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('remembers the last folder; switching folders re-defaults; a touched auto-approve survives an isolation flip', async () => {
    window.localStorage.setItem(LAST_FOLDER_KEY, PLAIN.path);
    renderDialog();
    const options = await screen.findAllByRole('radio');
    expect(options[1]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(options[0]);
    await waitFor(() =>
      expect(screen.getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    fireEvent.change(screen.getByLabelText('Work in'), {
      target: { value: 'directory' },
    });
    expect(
      document.querySelector('[data-auto-approve-sentence]'),
    ).toHaveTextContent(/edits this folder directly/);
    fireEvent.change(screen.getByLabelText('Work in'), {
      target: { value: 'worktree' },
    });
    // Set by the person: not re-defaulted to on.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('Browse… adds the picked folder at the top and selects it; a cancelled picker changes nothing', async () => {
    const picked = folder({
      handle: 'f-9',
      path: '/Users/me/scratch',
      displayPath: '~/scratch',
      name: 'scratch',
      kind: 'folder',
      projectId: null,
      projectName: null,
    });
    (chooseFolder as jest.Mock)
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false, folder: picked });
    renderDialog();
    await screen.findAllByRole('radio');
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(chooseFolder).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3));
    const options = screen.getAllByRole('radio');
    expect(options[0]).toHaveTextContent('scratch');
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('warns about a live session already in the folder', async () => {
    (useSessionsSnapshot as jest.Mock).mockReturnValue({
      runs: [
        { id: 'run-1', status: 'running', cwd: REPO.path } as AgentRun,
        { id: 'run-2', status: 'cancelled', cwd: REPO.path } as AgentRun,
      ],
    });
    renderDialog();
    await screen.findAllByRole('radio');
    expect(
      screen.getByText('A session is already running in this folder.'),
    ).toBeInTheDocument();
  });

  it('starts with the folder handle, the current member, the defaults and the first message; remembers the folder; navigates', async () => {
    (startRun as jest.Mock).mockResolvedValue({
      id: 'run-new1',
      status: 'provisioning',
    });
    const onClose = renderDialog();
    await screen.findAllByRole('radio');
    await waitFor(() => expect(startButton()).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/First message/), {
      target: { value: '  Fix the flaky test\nIt fails on CI.  ' },
    });
    fireEvent.click(startButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(startRun).toHaveBeenCalledWith({
      folder: 'f-1',
      ownerMemberId: 'mem-1',
      providerId: 'claude',
      isolation: 'worktree',
      autoApprove: true,
      baseRef: 'main',
      firstMessage: 'Fix the flaky test\nIt fails on CI.',
    });
    expect(window.localStorage.getItem(LAST_FOLDER_KEY)).toBe(REPO.path);
    expect(screen.getByText('session page')).toBeInTheDocument();
  });

  it('a direct start sends no base branch and no message when none was typed', async () => {
    (listRecentFolders as jest.Mock).mockResolvedValue([PLAIN]);
    (startRun as jest.Mock).mockResolvedValue({
      id: 'run-d',
      status: 'provisioning',
    });
    renderDialog();
    await screen.findAllByRole('radio');
    await waitFor(() => expect(startButton()).toBeEnabled());
    fireEvent.click(startButton());
    await waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'f-2',
        isolation: 'directory',
        autoApprove: false,
        baseRef: null,
        firstMessage: null,
      }),
    );
  });

  it("a refused start shows main's sentence inline and keeps the form", async () => {
    (startRun as jest.Mock).mockRejectedValue(
      new Error('main is not a local branch of ~/code/waypoint.'),
    );
    const onClose = renderDialog();
    await screen.findAllByRole('radio');
    await waitFor(() => expect(startButton()).toBeEnabled());
    fireEvent.click(startButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'main is not a local branch of ~/code/waypoint.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a provider this machine does not have keeps Start disabled with the sentence', async () => {
    (detectLocalClaudeCode as jest.Mock).mockResolvedValue({ state: 'absent' });
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No supported provider is installed on this machine.',
    );
    await screen.findAllByRole('radio');
    expect(startButton()).toBeDisabled();
  });

  it('with no folders yet it says to Browse', async () => {
    (listRecentFolders as jest.Mock).mockResolvedValue([]);
    renderDialog();
    expect(
      await screen.findByText(/No folder yet — Browse…/),
    ).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
  });

  it('with the engine stopped the form is replaced by the way to start it', () => {
    renderDialog(STOPPED);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(listRecentFolders).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open This machine' }));
    expect(screen.getByText('machine page')).toBeInTheDocument();
  });

  it('Escape closes it', () => {
    const onClose = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
