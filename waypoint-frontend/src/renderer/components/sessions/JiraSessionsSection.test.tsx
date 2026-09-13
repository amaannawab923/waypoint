import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getJiraTicketRef } from '@/data/engineApi';
import { listTicketAgentRuns } from '@/data/api';
import { JiraSessionsSection } from './JiraSessionsSection';

// W5b: the My Jira drawer's Sessions section resolves the issue's ledger
// handle through main and renders the W5a section on it.
jest.mock('@/lib/featureFlags', () => ({ SESSIONS_ENABLED: true }));
jest.mock('@/data/engineApi', () => ({
  getJiraTicketRef: jest.fn(),
  onRunChanged: jest.fn(() => () => {}),
  getBriefPreview: jest.fn(),
  dispatchRun: jest.fn(),
  listRecentFolders: jest.fn(async () => []),
  chooseFolder: jest.fn(async () => ({ canceled: true })),
}));
jest.mock('@/data/api', () => ({
  listTicketAgentRuns: jest.fn(async () => []),
  getWorkspace: jest.fn(async () => ({ defaultAgentProvider: 'claude' })),
}));

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

beforeEach(() => jest.clearAllMocks());

describe('JiraSessionsSection', () => {
  it('mints the handle from the key and summary, then lists the runs and the verbs on it', async () => {
    (getJiraTicketRef as jest.Mock).mockResolvedValue({
      ticketId: 'tref-eng4',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([
      {
        id: 'run-eng40001',
        status: 'needs-review',
        entry: 'dispatched',
        providerId: 'claude',
        intent: 'investigate',
        modeId: 'plan',
        branch: 'agent/ENG-4',
        blockedReason: null,
        summary: 'The retry path.',
        prUrl: null,
        updatedAt: '2026-09-13T10:00:00Z',
      },
    ]);
    render(
      <MemoryRouter>
        <JiraSessionsSection issueKey="ENG-4" title="Checkout 500s" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Investigate')).not.toBeInTheDocument();
    await flush();
    expect(getJiraTicketRef).toHaveBeenCalledWith({
      key: 'ENG-4',
      title: 'Checkout 500s',
    });
    expect(listTicketAgentRuns).toHaveBeenCalledWith('tref-eng4');
    await flush();
    expect(
      screen.getByRole('button', { name: 'Investigate' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix' })).toBeInTheDocument();
    expect(screen.getByText('agent/ENG-4')).toBeInTheDocument();
    expect(screen.getByText(/Sessions \(1\)/)).toBeInTheDocument();
  });

  it('renders nothing when the handle cannot be minted', async () => {
    (getJiraTicketRef as jest.Mock).mockRejectedValue(
      new Error('Jira is not connected.'),
    );
    const { container } = render(
      <MemoryRouter>
        <JiraSessionsSection issueKey="ENG-4" title="Checkout 500s" />
      </MemoryRouter>,
    );
    await flush();
    expect(container).toBeEmptyDOMElement();
    expect(listTicketAgentRuns).not.toHaveBeenCalled();
  });
});
