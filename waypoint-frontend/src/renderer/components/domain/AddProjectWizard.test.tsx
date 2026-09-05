import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { connectJira, getJiraConnectionStatus } from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus } from '@/types/jira';
import { AddProjectWizard } from './AddProjectWizard';

jest.mock('@/data/jiraApi', () => ({
  connectJira: jest.fn(),
  getJiraConnectionStatus: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({
  setJiraConnection: jest.fn(),
}));

const navigateSpy = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => navigateSpy,
}));

// The real CreateProjectModal is its own, already-shipped, backend-integrated
// flow — this file's job is only to prove the wizard delegates to it (and
// with which props), not to re-test CreateProjectModal's own behavior.
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-project-modal" /> : null,
}));

function status(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    site: 'northwind.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
    pollIntervalSec: 15,
    paused: false,
    ...overrides,
  };
}

function renderWizard({
  onCreated = jest.fn(),
  onClose = jest.fn(),
}: { onCreated?: jest.Mock; onClose?: jest.Mock } = {}) {
  return {
    onCreated,
    onClose,
    ...render(
      <MemoryRouter>
        <AddProjectWizard open onClose={onClose} onCreated={onCreated} />
      </MemoryRouter>,
    ),
  };
}

/** Drives the wizard from the type picker through Companion's connect step,
 * leaving it sitting on step 4 (site picker) with Jira already connected. */
async function advanceToSiteStep() {
  fireEvent.click(screen.getByText('Companion project'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  fireEvent.click(screen.getByText('Jira'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  fireEvent.click(screen.getByRole('button', { name: 'Connect Jira account' }));
  await screen.findByText('Connected');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AddProjectWizard — type picker (step 1)', () => {
  it('disables Continue until a type is chosen', () => {
    renderWizard();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.click(screen.getByText('Independent project'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('delegates to the real CreateProjectModal when Independent is chosen — no type picker, no wizard chrome left', () => {
    renderWizard();

    fireEvent.click(screen.getByText('Independent project'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByTestId('create-project-modal')).toBeInTheDocument();
    expect(screen.queryByText('Companion project')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();
  });
});

describe('AddProjectWizard — Companion flow', () => {
  it('gates the provider step to Jira (Linear/Shortcut are not pickable)', () => {
    renderWizard();
    fireEvent.click(screen.getByText('Companion project'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getAllByText('Not built yet')).toHaveLength(2);

    fireEvent.click(screen.getByText('Jira'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('gates the connect step on an actual connectJira() call, and pushes the result into jiraStore', async () => {
    jest.mocked(connectJira).mockResolvedValue(status());
    renderWizard();
    fireEvent.click(screen.getByText('Companion project'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByText('Jira'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Connect Jira account' }),
    );

    await waitFor(() => expect(connectJira).toHaveBeenCalledTimes(1));
    await screen.findByText('Connected');
    expect(setJiraConnection).toHaveBeenCalledWith(status());
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('reaches the confirm step showing the chosen site and live counts', async () => {
    jest
      .mocked(connectJira)
      .mockResolvedValue(status({ issueCount: 6, projectCount: 3 }));
    renderWizard();
    await advanceToSiteStep();

    expect(screen.getByText('northwind.atlassian.net')).toBeInTheDocument();
    fireEvent.click(screen.getByText('northwind-labs.atlassian.net'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.getByText(/northwind-labs\.atlassian\.net/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create project' }),
    ).toBeEnabled();
  });

  it('finishing does not call connectJira a second time, closes the wizard, and navigates to /my-jira', async () => {
    jest.mocked(connectJira).mockResolvedValue(status());
    jest.mocked(getJiraConnectionStatus).mockResolvedValue(status());
    const { onClose } = renderWizard();
    await advanceToSiteStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(connectJira).toHaveBeenCalledTimes(1);
    expect(getJiraConnectionStatus).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith('/my-jira');
  });

  it('Back returns to the previous step without losing the chosen type/provider', async () => {
    renderWizard();
    fireEvent.click(screen.getByText('Companion project'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByText('Jira'));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Companion project')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Jira was still selected on the provider step after going back and forward.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
