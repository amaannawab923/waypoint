import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  createTeamWorkspace,
  createWorkspaceInvite,
  setActiveWorkspace,
  HostedApiError,
} from '@/data/hostedWorkspace';
import { TeamWorkspaceDialog } from './TeamWorkspaceDialog';

jest.mock('@/data/hostedWorkspace', () => {
  const actual = jest.requireActual('@/data/hostedWorkspace');
  return {
    ...actual,
    createTeamWorkspace: jest.fn(),
    createWorkspaceInvite: jest.fn(),
    setActiveWorkspace: jest.fn(),
  };
});

const account = {
  status: jest.fn(),
  signIn: jest.fn(),
  cancelSignIn: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { account };
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn(async () => undefined) },
  });
});

const WORKSPACE = {
  id: 'ws-1',
  name: 'Fairweather Labs',
  slug: 'fairweather-labs',
  isPersonal: false,
  myMemberId: 'mem-1',
  myRole: 'admin' as const,
};

describe('TeamWorkspaceDialog', () => {
  it('disables Create until a name is entered', () => {
    render(<TeamWorkspaceDialog open onClose={jest.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Create workspace' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'Fairweather Labs' },
    });
    expect(
      screen.getByRole('button', { name: 'Create workspace' }),
    ).not.toBeDisabled();
  });

  it('creates the workspace directly when already signed in, and shows the invite link', async () => {
    account.status.mockResolvedValue({ connected: true, identity: null });
    (createTeamWorkspace as jest.Mock).mockResolvedValue(WORKSPACE);
    (setActiveWorkspace as jest.Mock).mockResolvedValue(true);
    (createWorkspaceInvite as jest.Mock).mockResolvedValue({
      id: 'inv-1',
      expiresAt: 'x',
      joinUrl: 'https://backend.test/join/tok123',
    });

    render(<TeamWorkspaceDialog open onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'Fairweather Labs' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() =>
      expect(
        screen.getByDisplayValue('https://backend.test/join/tok123'),
      ).toBeInTheDocument(),
    );
    expect(account.signIn).not.toHaveBeenCalled();
    expect(createTeamWorkspace).toHaveBeenCalledWith('Fairweather Labs');
    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(createWorkspaceInvite).toHaveBeenCalledWith('ws-1');

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://backend.test/join/tok123',
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
  });

  it('signs in first when not connected, then continues to create the workspace', async () => {
    account.status.mockResolvedValue({ connected: false, identity: null });
    // A mock that auto-resolves would settle within the same microtask flush
    // as every other call in this chain, so React never gets a paint where
    // the 'signing-in' step is the current state — this deferred promise
    // holds it open until the assertion below has actually observed it.
    let resolveSignIn: (v: unknown) => void = () => {};
    account.signIn.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    (createTeamWorkspace as jest.Mock).mockResolvedValue(WORKSPACE);
    (setActiveWorkspace as jest.Mock).mockResolvedValue(true);
    (createWorkspaceInvite as jest.Mock).mockResolvedValue({
      id: 'inv-1',
      expiresAt: 'x',
      joinUrl: 'https://x/join/tok',
    });

    render(<TeamWorkspaceDialog open onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'Fairweather Labs' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await screen.findByText(/Finish signing in/);
    expect(account.signIn).toHaveBeenCalledWith({
      purpose: 'create-workspace',
    });

    await act(async () => resolveSignIn({ ok: true, value: {} }));
    await waitFor(() =>
      expect(createTeamWorkspace).toHaveBeenCalledWith('Fairweather Labs'),
    );
  });

  it('shows an error and returns to the form when sign-in fails', async () => {
    account.status.mockResolvedValue({ connected: false, identity: null });
    account.signIn.mockResolvedValue({
      ok: false,
      reason: 'cancelled',
      message: 'Sign-in was cancelled.',
    });

    render(<TeamWorkspaceDialog open onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in was cancelled.',
    );
    expect(createTeamWorkspace).not.toHaveBeenCalled();
  });

  it('lets the user cancel while signing in, and returning to the form', async () => {
    account.status.mockResolvedValue({ connected: false, identity: null });
    let resolveSignIn: (v: unknown) => void = () => {};
    account.signIn.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    account.cancelSignIn.mockResolvedValue({ ok: true });

    render(<TeamWorkspaceDialog open onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await screen.findByText(/Finish signing in/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(account.cancelSignIn).toHaveBeenCalled());
    await screen.findByPlaceholderText('Workspace name');

    // The real cancelSignIn IPC call is what causes main's still-pending
    // signIn() to resolve as cancelled — settle it the same way here so the
    // mock doesn't leave a dangling unresolved promise behind the test.
    await act(async () =>
      resolveSignIn({
        ok: false,
        reason: 'cancelled',
        message: 'Sign-in was cancelled.',
      }),
    );
  });

  it('shows the backend error message when workspace creation fails', async () => {
    account.status.mockResolvedValue({ connected: true, identity: null });
    (createTeamWorkspace as jest.Mock).mockRejectedValue(
      new HostedApiError('Name already taken', 409),
    );

    render(<TeamWorkspaceDialog open onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Name already taken',
    );
  });
});
