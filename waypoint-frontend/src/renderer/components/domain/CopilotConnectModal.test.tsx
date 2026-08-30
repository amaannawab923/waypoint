import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { CopilotConnectModal } from './CopilotConnectModal';

type ConnectHandlers = {
  onData: (chunk: string) => void;
  onExit: (result: { code: number | null; spawnError?: string }) => void;
};

const mockSave = jest.fn();
const mockOpenExternal = jest.fn();
const mockUnsubscribe = jest.fn();
let capturedHandlers: ConnectHandlers | null = null;
const mockConnect = jest.fn((_requestId: string, handlers: ConnectHandlers) => {
  capturedHandlers = handlers;
  return mockUnsubscribe;
});

function getHandlers(): ConnectHandlers {
  if (!capturedHandlers) throw new Error('connect() was not called yet');
  return capturedHandlers;
}

// xterm's own WriteBuffer defers processing to a real setTimeout hop
// whenever a write arrives while a previous one is still mid-processing
// (true for both @xterm/xterm and @xterm/headless, which share this core) —
// term.write()'s completion callback is genuinely async, not just a
// microtask. The component itself also debounces committing a match for
// SETTLE_DEBOUNCE_MS (150ms) after the last write, so real chunk-arrival
// timing doesn't cause it to commit on a still-growing prefix. Wait past
// both before asserting on anything derived from the resolved buffer, and
// do this before every test's act() block closes so nothing leaks into the
// next test's timers.
async function flushWrites() {
  await new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks — clearAllMocks only wipes call
  // history, not queued mockResolvedValueOnce implementations, which would
  // otherwise leak into a later test's save() call.
  jest.resetAllMocks();
  mockConnect.mockImplementation(
    (_requestId: string, handlers: ConnectHandlers) => {
      capturedHandlers = handlers;
      return mockUnsubscribe;
    },
  );
  capturedHandlers = null;
  (window as unknown as { electron: typeof window.electron }).electron = {
    copilot: {
      auth: {
        connect: mockConnect,
        openExternal: mockOpenExternal,
        save: mockSave,
      },
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  cleanup();
});

function renderModal(onConnected = jest.fn(), onClose = jest.fn()) {
  render(
    <CopilotConnectModal open onClose={onClose} onConnected={onConnected} />,
  );
  return { onConnected, onClose };
}

describe('CopilotConnectModal', () => {
  it('starts the connect flow and shows the waiting state', () => {
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Waiting for sign-in…')).toBeInTheDocument();
  });

  // The core thing this whole component exists to get right: real, ANSI/
  // cursor-positioned CLI output — not clean plain text — resolved via
  // @xterm/headless rather than hand-parsed. Chunk boundaries are split
  // mid-token deliberately, mirroring how the real PTY stream actually
  // arrives (a live capture showed a token split by a `\r\x1b[1B` line-wrap
  // sequence with no real space, which a naive text-window parser got
  // wrong on the first real attempt).
  it('extracts a token that arrives split across multiple ANSI-coded chunks, and saves it', async () => {
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'wxyz' });
    const { onConnected, onClose } = renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData('Your OAuth token (valid for 1 year):\r\n');
      handlers.onData('sk-ant-oat01-FWcLvORkzyrK6StQIzUKV5aeF7bk30Kcquwg6cZ');
      // A real captured line-wrap: CR + cursor-down, then the continuation
      // — no literal space belongs in the reconstructed token.
      handlers.onData(
        '\r\x1b[1BCL2vL3JznPya63xBZ9KNbJejYMxN6LtYJa2VguAvLe8g-O7XW-QAA\r\n',
      );
      await flushWrites();
    });

    expect(mockSave).toHaveBeenCalledWith(
      'sk-ant-oat01-FWcLvORkzyrK6StQIzUKV5aeF7bk30Kcquwg6cZCL2vL3JznPya63xBZ9KNbJejYMxN6LtYJa2VguAvLe8g-O7XW-QAA',
    );
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    // The unsubscribe is called the moment a candidate token is found, not
    // left open through the async save — a stray late chunk from the same
    // process must not re-trigger extraction mid-save.
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

    // onConnected/onClose fire after a short delay so "Connected" is
    // actually visible for a beat rather than flashing — assert eventually
    // rather than synchronously.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1500);
      });
    });
    expect(onConnected).toHaveBeenCalledWith('wxyz');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the real OAuth URL exactly once via shell.openExternal, even if it also arrives split across chunks', async () => {
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData('Use the url below to sign in:\r\n');
      handlers.onData(
        'https://claude.com/cai/oauth/authorize?code=true&client_id=abc',
      );
      handlers.onData('\r\x1b[1B-def&state=xyz\r\n');
      await flushWrites();
    });

    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=abc-def&state=xyz',
    );

    // A second data event repeating the same URL (the CLI can redraw its
    // own screen) must not open a second browser tab.
    await act(async () => {
      handlers.onData(
        'https://claude.com/cai/oauth/authorize?code=true&client_id=abc-def&state=xyz\r\n',
      );
      await flushWrites();
    });
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
  });

  it('shows the real rejection reason when the extracted token is invalid, and offers the manual fallback', async () => {
    mockSave.mockResolvedValueOnce({
      ok: false,
      message:
        'Failed to authenticate. API Error: 401 OAuth access token has expired.',
    });
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData('sk-ant-oat01-somecapturedtokenvalue1234567890\r\n');
      await flushWrites();
    });

    expect(await screen.findByText("Couldn't connect")).toBeInTheDocument();
    expect(
      screen.getByText(/401 OAuth access token has expired/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Having trouble? Paste a token manually'));
    expect(
      await screen.findByLabelText('Subscription token'),
    ).toBeInTheDocument();
  });

  it('shows a clear error when the process exits with no token and was not cancelled', async () => {
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onExit({ code: 1 });
    });

    expect(await screen.findByText("Couldn't connect")).toBeInTheDocument();
    expect(screen.getByText(/Sign-in exited unexpectedly/)).toBeInTheDocument();
  });

  it('shows a specific message when the CLI itself could not be spawned', async () => {
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onExit({
        code: null,
        spawnError: "Claude Code isn't installed (or not on PATH).",
      });
    });

    expect(
      await screen.findByText("Claude Code isn't installed (or not on PATH)."),
    ).toBeInTheDocument();
  });

  it('ignores a process exit that arrives after a token was already found and saved', async () => {
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'ab12' });
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData('sk-ant-oat01-alreadyfoundtoken1234567890\r\n');
      await flushWrites();
    });
    expect(await screen.findByText('Connected')).toBeInTheDocument();

    await act(async () => {
      handlers.onExit({ code: 0 });
    });
    // Still showing success, not overwritten by the exit handler's error path.
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('cancelling while connecting unsubscribes and closes without saving anything', () => {
    const { onClose } = renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('supports the manual-paste fallback independently of the automated flow', async () => {
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'nn12' });
    const { onConnected, onClose } = renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();
    await act(async () => {
      handlers.onExit({ code: 1 });
    });
    fireEvent.click(screen.getByText('Having trouble? Paste a token manually'));

    const input = await screen.findByLabelText('Subscription token');
    fireEvent.change(input, {
      target: { value: 'sk-ant-oat01-manuallypasted' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    });

    expect(mockSave).toHaveBeenCalledWith('sk-ant-oat01-manuallypasted');
    expect(onConnected).toHaveBeenCalledWith('nn12');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets to the initial prompt state each time it is reopened', () => {
    const { onClose } = renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    expect(screen.getByText('Waiting for sign-in…')).toBeInTheDocument();

    cleanup();
    render(
      <CopilotConnectModal
        open={false}
        onClose={onClose}
        onConnected={jest.fn()}
      />,
    );
    render(
      <CopilotConnectModal open onClose={onClose} onConnected={jest.fn()} />,
    );

    expect(
      screen.getByRole('button', { name: 'Continue in browser' }),
    ).toBeInTheDocument();
  });
});
