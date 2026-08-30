import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import Copilot from './Copilot';

const mockStatus = jest.fn();
const mockSave = jest.fn();
const mockClear = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  (window as unknown as { electron: typeof window.electron }).electron = {
    copilot: {
      auth: {
        status: mockStatus,
        save: mockSave,
        clear: mockClear,
      },
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  cleanup();
});

function getTokenInput() {
  return screen.getByLabelText('Subscription token') as HTMLInputElement;
}

describe('Copilot settings page', () => {
  it('shows the connect form when no token is saved', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    render(<Copilot />);

    expect(
      await screen.findByLabelText('Subscription token'),
    ).toBeInTheDocument();
    expect(screen.getByText(/claude setup-token/)).toBeInTheDocument();
    expect(
      screen.queryByText('Claude subscription connected'),
    ).not.toBeInTheDocument();
  });

  it('shows the connected state, masking everything but the last 4 characters', async () => {
    mockStatus.mockResolvedValueOnce({ connected: true, last4: 'wxyz' });
    render(<Copilot />);

    expect(
      await screen.findByText('Claude subscription connected'),
    ).toBeInTheDocument();
    expect(screen.getByText('•••• wxyz')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Subscription token'),
    ).not.toBeInTheDocument();
  });

  it('connects successfully: saves, clears the input, and shows the connected state', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'ab12' });
    render(<Copilot />);
    await screen.findByLabelText('Subscription token');

    fireEvent.change(getTokenInput(), {
      target: { value: 'sk-ant-oat01-realtoken' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    expect(mockSave).toHaveBeenCalledWith('sk-ant-oat01-realtoken');
    expect(
      await screen.findByText('Claude subscription connected'),
    ).toBeInTheDocument();
    expect(screen.getByText('•••• ab12')).toBeInTheDocument();
    expect(
      await screen.findByText(/Connected — Copilot will use this from now on/),
    ).toBeInTheDocument();
  });

  it('shows the real rejection reason inline and does not clear the draft on failure', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    mockSave.mockResolvedValueOnce({
      ok: false,
      message:
        'Failed to authenticate. API Error: 401 OAuth access token has expired.',
    });
    render(<Copilot />);
    await screen.findByLabelText('Subscription token');

    fireEvent.change(getTokenInput(), {
      target: { value: 'sk-ant-oat01-expired' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    expect(
      await screen.findByText(/401 OAuth access token has expired/),
    ).toBeInTheDocument();
    // The user shouldn't have to retype it after a rejection.
    expect(getTokenInput().value).toBe('sk-ant-oat01-expired');
    expect(
      screen.queryByText('Claude subscription connected'),
    ).not.toBeInTheDocument();
  });

  it('disables Connect while a save is in flight, and disables it for an empty draft', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    let resolveSave: (value: { ok: true; last4: string }) => void = () => {};
    mockSave.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<Copilot />);
    await screen.findByLabelText('Subscription token');

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    fireEvent.change(getTokenInput(), {
      target: { value: 'sk-ant-oat01-pending' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Connect|Validating/ }));

    expect(
      await screen.findByRole('button', { name: 'Validating…' }),
    ).toBeDisabled();

    await act(async () => {
      resolveSave({ ok: true, last4: 'nnnn' });
    });
    expect(
      await screen.findByText('Claude subscription connected'),
    ).toBeInTheDocument();
  });

  it('disconnects: clears the stored token and returns to the connect form', async () => {
    mockStatus.mockResolvedValueOnce({ connected: true, last4: 'ab12' });
    mockClear.mockResolvedValueOnce({ ok: true });
    render(<Copilot />);
    await screen.findByText('Claude subscription connected');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });

    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByLabelText('Subscription token'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Claude subscription connected'),
    ).not.toBeInTheDocument();
  });
});
