import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { detectLocalClaudeCode, getWorkspace } from '@/data/api';
import { listRunBranches, startRun } from '@/data/engineApi';
import { useAllProjects } from '@/lib/projectsStore';
import type { Project } from '@/types/entities';
import { LAST_PROJECT_KEY, NewSessionDialog } from './NewSessionDialog';

jest.mock('@/lib/projectsStore', () => ({ useAllProjects: jest.fn() }));
jest.mock('@/data/engineApi', () => ({
  listRunBranches: jest.fn(),
  startRun: jest.fn(),
}));
jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));

const project = (id: string, name: string, repoPath: string | null): Project =>
  ({ id, name, repoPath, archivedAt: null }) as Project;

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
        <Route path="/projects" element={<div>projects page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  (useAllProjects as jest.Mock).mockReturnValue([
    project('proj-docs', 'Docs', null),
    project('proj-wp', 'Waypoint', '/repos/waypoint'),
    project('proj-api', 'API', '/repos/api'),
  ]);
  (listRunBranches as jest.Mock).mockResolvedValue({
    branches: ['feat/x', 'main'],
    suggested: 'main',
  });
  (getWorkspace as jest.Mock).mockResolvedValue({
    defaultAgentProvider: 'claude',
  });
  (detectLocalClaudeCode as jest.Mock).mockResolvedValue({ state: 'present' });
});

describe('NewSessionDialog', () => {
  it('offers only projects with a linked repository, reads their branches, preselects the suggestion', async () => {
    renderDialog();
    const projectField = screen.getByLabelText('Project') as HTMLSelectElement;
    expect(Array.from(projectField.options).map((o) => o.textContent)).toEqual([
      'Waypoint',
      'API',
    ]);
    expect(listRunBranches).toHaveBeenCalledWith('proj-wp');
    const branch = (await screen.findByLabelText(
      'Base branch',
    )) as HTMLSelectElement;
    await waitFor(() => expect(branch.value).toBe('main'));
    await waitFor(() =>
      expect(screen.getByLabelText('Provider')).toHaveValue('claude'),
    );
    expect(screen.getByLabelText('Provider')).toHaveTextContent(
      'Claude Code · workspace default',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Start session' }),
      ).toBeEnabled(),
    );
  });

  it('a provider this machine does not have keeps Start disabled with the sentence (emdash’s rule)', async () => {
    (detectLocalClaudeCode as jest.Mock).mockResolvedValue({ state: 'absent' });
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No supported provider is installed on this machine.',
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Base branch')).toHaveValue('main'),
    );
    expect(
      screen.getByRole('button', { name: 'Start session' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Provider')).toHaveTextContent(
      '(not installed)',
    );
  });

  it('a workspace that has not chosen a provider gets Waypoint’s default', async () => {
    (getWorkspace as jest.Mock).mockResolvedValue({
      defaultAgentProvider: null,
    });
    renderDialog();
    await waitFor(() =>
      expect(screen.getByLabelText('Provider')).toHaveValue('claude'),
    );
  });

  it('remembers the last project and re-reads branches when the project changes', async () => {
    window.localStorage.setItem(LAST_PROJECT_KEY, 'proj-api');
    renderDialog();
    expect(screen.getByLabelText('Project')).toHaveValue('proj-api');
    expect(listRunBranches).toHaveBeenLastCalledWith('proj-api');
    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: 'proj-wp' },
    });
    await waitFor(() =>
      expect(listRunBranches).toHaveBeenLastCalledWith('proj-wp'),
    );
  });

  it('Start is disabled until the branches are read, and while starting', async () => {
    let resolveBranches: (v: unknown) => void = () => {};
    (listRunBranches as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveBranches = resolve;
      }),
    );
    renderDialog();
    const start = screen.getByRole('button', { name: 'Start session' });
    expect(start).toBeDisabled();
    await act(async () => {
      resolveBranches({ branches: ['main'], suggested: 'main' });
    });
    await waitFor(() => expect(start).toBeEnabled());
  });

  it('starts with the current member, the chosen branch and a trimmed title, remembers the project, navigates', async () => {
    (startRun as jest.Mock).mockResolvedValue({
      id: 'run-new1',
      status: 'provisioning',
    });
    const onClose = renderDialog();
    await waitFor(() =>
      expect(screen.getByLabelText('Base branch')).toHaveValue('main'),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Start session' }),
      ).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('Base branch'), {
      target: { value: 'feat/x' },
    });
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: '  Try the flaky test  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(startRun).toHaveBeenCalledWith({
      projectId: 'proj-wp',
      ownerMemberId: 'mem-1',
      providerId: 'claude',
      baseRef: 'feat/x',
      title: 'Try the flaky test',
    });
    expect(window.localStorage.getItem(LAST_PROJECT_KEY)).toBe('proj-wp');
    expect(screen.getByText('session page')).toBeInTheDocument();
  });

  it("a refused start shows main's sentence inline and keeps the form", async () => {
    (startRun as jest.Mock).mockRejectedValue(
      new Error('main is not a local branch of the linked repository.'),
    );
    const onClose = renderDialog();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Start session' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'main is not a local branch of the linked repository.',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  });

  it('a branch read that fails says so under the field', async () => {
    (listRunBranches as jest.Mock).mockRejectedValue(
      new Error('Waypoint has no linked repository.'),
    );
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Waypoint has no linked repository.',
    );
    expect(
      screen.getByRole('button', { name: 'Start session' }),
    ).toBeDisabled();
  });

  it('with the engine stopped the form is replaced by the way to start it', () => {
    renderDialog(STOPPED);
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();
    expect(listRunBranches).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open This machine' }));
    expect(screen.getByText('machine page')).toBeInTheDocument();
  });

  it('with no linked project it says where to link one', () => {
    (useAllProjects as jest.Mock).mockReturnValue([
      project('proj-docs', 'Docs', null),
    ]);
    renderDialog();
    expect(
      screen.getByText(/No project has a linked repository yet/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start session' }),
    ).not.toBeInTheDocument();
  });

  it('Escape closes it', () => {
    const onClose = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
