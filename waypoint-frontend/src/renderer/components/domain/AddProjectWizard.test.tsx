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

const CREDENTIALS = {
  site: 'waypoint123.atlassian.net',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
};

function status(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    site: 'waypoint123.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
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

function fillConnectForm(overrides: Partial<typeof CREDENTIALS> = {}) {
  const values = { ...CREDENTIALS, ...overrides };
  fireEvent.change(screen.getByLabelText('Jira site'), {
    target: { value: values.site },
  });
  fireEvent.change(screen.getByLabelText('Atlassian account email'), {
    target: { value: values.email },
  });
  fireEvent.change(screen.getByLabelText('API token'), {
    target: { value: values.apiToken },
  });
}

/** Drives the wizard from the type picker to the connect step. */
function advanceToConnectStep() {
  fireEvent.click(screen.getByText('Companion project'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByText('Jira'));
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
});

describe('AddProjectWizard — the connect step', () => {
  it('asks for a site, an email and a token, and cannot be submitted until it has all three', () => {
    renderWizard();
    advanceToConnectStep();

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    fillConnectForm({ apiToken: '' });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    fillConnectForm();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  // The token is a live bearer credential for the whole Jira account; it has
  // no business being readable over someone's shoulder.
  it('masks the API token field', () => {
    renderWizard();
    advanceToConnectStep();

    expect(screen.getByLabelText('API token')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('passes exactly what was typed to connectJira, and shows the identity Jira answered with', async () => {
    jest.mocked(connectJira).mockResolvedValue(status());
    renderWizard();
    advanceToConnectStep();
    fillConnectForm();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(connectJira).toHaveBeenCalledWith(CREDENTIALS));
    await screen.findByText('Connected');
    expect(screen.getByText('Max Chen')).toBeInTheDocument();
    expect(setJiraConnection).toHaveBeenCalledWith(status());
  });

  it('blocks Continue until a connection has actually been made', async () => {
    jest.mocked(connectJira).mockResolvedValue(status());
    renderWizard();
    advanceToConnectStep();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fillConnectForm();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('Connected');

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  // Main distinguishes "Jira rejected these credentials" from "we never
  // reached Jira" from "that address isn't a Jira site" — that specificity is
  // only worth having if it reaches the person who has to act on it, so the
  // message is shown inline on the form rather than flashed as a toast.
  it.each([
    ['Jira rejected that email and API token.'],
    ["That site doesn't exist — check the address."],
    ['That address answered, but not like a Jira Cloud site.'],
  ])(
    'shows %j inline on the form, and stays on the connect step',
    async (message) => {
      jest.mocked(connectJira).mockRejectedValue(new Error(message));
      renderWizard();
      advanceToConnectStep();
      fillConnectForm();

      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    },
  );

  it('clears a previous failure as soon as a field is edited', async () => {
    jest
      .mocked(connectJira)
      .mockRejectedValue(new Error('Jira rejected that.'));
    renderWizard();
    advanceToConnectStep();
    fillConnectForm();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('alert');

    fireEvent.change(screen.getByLabelText('API token'), {
      target: { value: 'a-corrected-token' },
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // OAuth is a real and better answer for an organizational install, but it
  // is not built. A second button that started a flow which doesn't exist is
  // exactly what this app's honesty rules exist to prevent.
  it('offers no OAuth alternative, stubbed or otherwise', () => {
    renderWizard();
    advanceToConnectStep();

    expect(
      screen.queryByRole('button', { name: /atlassian|oauth|sign in/i }),
    ).not.toBeInTheDocument();
  });
});

describe('AddProjectWizard — confirm and finish', () => {
  async function advanceToConfirmStep() {
    jest.mocked(connectJira).mockResolvedValue(status());
    advanceToConnectStep();
    fillConnectForm();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('Connected');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  }

  // There is no site-picker step any more: a personal API token
  // authenticates one person against one site, and that site was typed on the
  // connect form. Asking again afterwards would imply something had
  // enumerated the account's sites, which nothing did.
  it('goes straight from connect to review, with no site picker in between', async () => {
    renderWizard();
    await advanceToConfirmStep();

    expect(screen.queryByText(/Atlassian site/i)).not.toBeInTheDocument();
    expect(screen.getByText('Review & create')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create project' }),
    ).toBeEnabled();
  });

  it('shows the real counts the connection came back with', async () => {
    renderWizard();
    await advanceToConfirmStep();

    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText(/issues, 3 projects/)).toBeInTheDocument();
    expect(screen.getByText(/waypoint123\.atlassian\.net/)).toBeInTheDocument();
  });

  it('finishing re-reads the status, closes the wizard and navigates to /my-jira', async () => {
    jest.mocked(getJiraConnectionStatus).mockResolvedValue(status());
    const { onClose } = renderWizard();
    await advanceToConfirmStep();

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Never a second connect attempt — the credential is already stored.
    expect(connectJira).toHaveBeenCalledTimes(1);
    expect(getJiraConnectionStatus).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith('/my-jira');
  });

  it('Back returns to the previous step without losing the chosen type/provider', () => {
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
