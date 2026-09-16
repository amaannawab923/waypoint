import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listMyWorkspaces, setActiveWorkspace } from '@/data/hostedWorkspace';
import { HostedWorkspaceSwitcher } from './HostedWorkspaceSwitcher';

jest.mock('@/data/hostedWorkspace', () => {
  const actual = jest.requireActual('@/data/hostedWorkspace');
  return {
    ...actual,
    listMyWorkspaces: jest.fn(),
    setActiveWorkspace: jest.fn(),
  };
});

const account = { status: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { account };
});

const WS_A = {
  id: 'ws-a',
  name: 'Fairweather Labs',
  slug: 'a',
  isPersonal: false,
  myMemberId: 'm1',
  myRole: 'admin' as const,
};
const WS_B = {
  id: 'ws-b',
  name: 'Second Team',
  slug: 'b',
  isPersonal: false,
  myMemberId: 'm2',
  myRole: 'member' as const,
};

describe('HostedWorkspaceSwitcher', () => {
  it('shows a not-signed-in message when not connected', async () => {
    account.status.mockResolvedValue({ connected: false, identity: null });
    render(<HostedWorkspaceSwitcher />);
    expect(
      await screen.findByText('Not signed in to a hosted account yet.'),
    ).toBeInTheDocument();
    expect(listMyWorkspaces).not.toHaveBeenCalled();
  });

  it('lists workspaces and marks the active one', async () => {
    account.status.mockResolvedValue({
      connected: true,
      identity: { activeWorkspaceId: 'ws-a' },
    });
    (listMyWorkspaces as jest.Mock).mockResolvedValue([WS_A, WS_B]);

    render(<HostedWorkspaceSwitcher />);

    expect(await screen.findByText('Fairweather Labs')).toBeInTheDocument();
    expect(screen.getByText('Second Team')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch' })).toBeInTheDocument();
  });

  it('switches the active workspace', async () => {
    account.status.mockResolvedValue({
      connected: true,
      identity: { activeWorkspaceId: 'ws-a' },
    });
    (listMyWorkspaces as jest.Mock).mockResolvedValue([WS_A, WS_B]);
    (setActiveWorkspace as jest.Mock).mockResolvedValue(true);

    render(<HostedWorkspaceSwitcher />);
    await screen.findByText('Second Team');

    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await waitFor(() =>
      expect(setActiveWorkspace).toHaveBeenCalledWith('ws-b'),
    );
    await waitFor(() => expect(screen.getAllByText('Active')).toHaveLength(1));
  });

  it('shows an empty message when signed in but no workspaces', async () => {
    account.status.mockResolvedValue({
      connected: true,
      identity: { activeWorkspaceId: null },
    });
    (listMyWorkspaces as jest.Mock).mockResolvedValue([]);

    render(<HostedWorkspaceSwitcher />);
    expect(
      await screen.findByText("You don't belong to any team workspaces yet."),
    ).toBeInTheDocument();
  });

  it('opens the create-workspace dialog', async () => {
    account.status.mockResolvedValue({ connected: false, identity: null });
    render(<HostedWorkspaceSwitcher />);
    await screen.findByText('Not signed in to a hosted account yet.');

    fireEvent.click(
      screen.getByRole('button', { name: 'Create team workspace' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Create a team workspace' }),
    ).toBeInTheDocument();
  });
});
