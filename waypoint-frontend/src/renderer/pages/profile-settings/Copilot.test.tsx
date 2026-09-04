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
const mockConnect = jest.fn();
const mockCancel = jest.fn();
const mockOpenExternal = jest.fn();
const mockDetect = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  // Never resolves unless a test overrides it — matches detectLocalClaudeCode's
  // real behavior of never rejecting (see data/api.ts), and keeps ClaudeCodeStatus
  // parked on `checking` for tests that don't care about it.
  mockDetect.mockImplementation(() => new Promise(() => {}));
  (window as unknown as { electron: typeof window.electron }).electron = {
    copilot: {
      auth: {
        status: mockStatus,
        save: mockSave,
        clear: mockClear,
        connect: mockConnect,
        cancel: mockCancel,
        openExternal: mockOpenExternal,
      },
      detect: mockDetect,
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  cleanup();
});

// The manual-paste path is a secondary fallback behind a toggle now (the
// primary path is CopilotConnectModal's automated flow, covered in its own
// test file) — these tests exercise that fallback specifically, so they
// expand it first rather than assuming the input is already visible.
async function expandManualFallback() {
  fireEvent.click(screen.getByText('Having trouble? Paste a token manually'));
  return (await screen.findByLabelText(
    'Subscription token',
  )) as HTMLInputElement;
}

describe('Copilot settings page', () => {
  it('shows the primary connect button and the manual fallback toggle when no token is saved', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    render(<Copilot />);

    expect(
      await screen.findByRole('button', { name: /Connect with Claude/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Having trouble? Paste a token manually'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Subscription token'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Claude subscription connected'),
    ).not.toBeInTheDocument();
  });

  it('expands the manual fallback form on request', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    render(<Copilot />);
    await screen.findByRole('button', { name: /Connect with Claude/ });

    const input = await expandManualFallback();
    expect(input).toBeInTheDocument();
    expect(screen.getByText(/claude setup-token/)).toBeInTheDocument();
  });

  it('shows the connected state, masking everything but the last 4 characters', async () => {
    mockStatus.mockResolvedValueOnce({ connected: true, last4: 'wxyz' });
    render(<Copilot />);

    expect(
      await screen.findByText('Claude subscription connected'),
    ).toBeInTheDocument();
    expect(screen.getByText('•••• wxyz')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect with Claude/ }),
    ).not.toBeInTheDocument();
  });

  it('connects via the manual fallback: saves, clears the input, and shows the connected state', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'ab12' });
    render(<Copilot />);
    await screen.findByRole('button', { name: /Connect with Claude/ });
    const input = await expandManualFallback();

    fireEvent.change(input, {
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
    await screen.findByRole('button', { name: /Connect with Claude/ });
    const input = await expandManualFallback();

    fireEvent.change(input, {
      target: { value: 'sk-ant-oat01-expired' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    expect(
      await screen.findByText(/401 OAuth access token has expired/),
    ).toBeInTheDocument();
    // The user shouldn't have to retype it after a rejection.
    expect(
      (screen.getByLabelText('Subscription token') as HTMLInputElement).value,
    ).toBe('sk-ant-oat01-expired');
    expect(
      screen.queryByText('Claude subscription connected'),
    ).not.toBeInTheDocument();
  });

  it('disables manual Connect while a save is in flight, and for an empty draft', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    let resolveSave: (value: { ok: true; last4: string }) => void = () => {};
    mockSave.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<Copilot />);
    await screen.findByRole('button', { name: /Connect with Claude/ });
    const input = await expandManualFallback();

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    fireEvent.change(input, {
      target: { value: 'sk-ant-oat01-pending' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

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

  it('disconnects: clears the stored token and returns to the connect prompt', async () => {
    mockStatus.mockResolvedValueOnce({ connected: true, last4: 'ab12' });
    mockClear.mockResolvedValueOnce({ ok: true });
    render(<Copilot />);
    await screen.findByText('Claude subscription connected');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });

    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole('button', { name: /Connect with Claude/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Claude subscription connected'),
    ).not.toBeInTheDocument();
  });

  // Previously a rejected status() left `status` null forever, and the
  // whole page — neither the connected card nor the connect button — ever
  // rendered anything again.
  it('falls back to the connect prompt with a notice when status() itself rejects', async () => {
    mockStatus.mockRejectedValueOnce(new Error('IPC unavailable'));
    render(<Copilot />);

    expect(
      await screen.findByRole('button', { name: /Connect with Claude/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't check your connection status/),
    ).toBeInTheDocument();
  });

  it('opens the automated connect modal from the primary button', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
    render(<Copilot />);
    const connectButton = await screen.findByRole('button', {
      name: /Connect with Claude/,
    });

    fireEvent.click(connectButton);

    expect(
      await screen.findByRole('dialog', { name: 'Connect Claude' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue in browser' }),
    ).toBeInTheDocument();
  });

  // W1.2: the Claude Code CLI detection badge on this page reads real
  // main-process output (copilot:detect), never a fabricated status — see
  // data/api.ts's detectLocalClaudeCode and components/domain/ClaudeCodeStatus.
  describe('Claude Code CLI detection', () => {
    it('shows the real version once the CLI is actually detected', async () => {
      mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
      mockDetect.mockResolvedValueOnce({
        ok: true,
        version: '1.2.3',
        path: '/opt/homebrew/bin/claude',
      });
      render(<Copilot />);

      expect(await screen.findByText('Detected')).toBeInTheDocument();
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    });

    it('shows "Not found" with no setup link on this page when the CLI is absent', async () => {
      mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
      mockDetect.mockResolvedValueOnce({
        ok: false,
        reason: 'not-found',
        message: '"claude" was not found on PATH.',
      });
      render(<Copilot />);

      expect(await screen.findByText('Not found')).toBeInTheDocument();
      // This page IS the setup surface — ClaudeCodeStatus is rendered here
      // with showSetupLink={false}, so it must not link back to itself.
      expect(screen.queryByText('Set up Claude Code')).not.toBeInTheDocument();
    });

    it("never shows a version string the probe didn't actually report", async () => {
      mockStatus.mockResolvedValueOnce({ connected: false, last4: null });
      mockDetect.mockResolvedValueOnce({
        ok: false,
        reason: 'error',
        message: 'Timed out waiting for "claude --version" after 5s.',
      });
      render(<Copilot />);

      expect(await screen.findByText('Error')).toBeInTheDocument();
      expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
    });
  });
});
