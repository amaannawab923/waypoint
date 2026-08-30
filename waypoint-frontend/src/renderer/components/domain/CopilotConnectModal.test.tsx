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
const mockCancel = jest.fn();
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
  // Succeeds by default so every test not specifically about the failure
  // path doesn't have to opt in to a resolved value just to avoid calling
  // .then() on undefined.
  mockOpenExternal.mockResolvedValue({ ok: true });
  capturedHandlers = null;
  (window as unknown as { electron: typeof window.electron }).electron = {
    copilot: {
      auth: {
        connect: mockConnect,
        cancel: mockCancel,
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
    // A full stop is triggered the moment a candidate token is found, not
    // left open through the async save — a stray late chunk from the same
    // process must not re-trigger extraction mid-save. Full stop means
    // both: stop listening, AND explicitly cancel the PTY (unlike a plain
    // unmount — see the cancel-vs-unmount tests below).
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);

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

  // The real failure mode this floor exists to catch: a box-drawing border
  // character (or any other non-token character) landing directly against
  // a token fragment mid-match previously still satisfied a too-low
  // minimum length and got submitted as a truncated, garbage credential.
  it('does not commit a token match shorter than the real minimum, and completes once more data arrives', async () => {
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'ijkl' });
    const tokenPrefix = 'sk-ant-oat01-shortfrag';
    const tokenSuffix = 'X'.repeat(40);
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData(`${tokenPrefix}\r\n`);
      await flushWrites();
    });
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByText('Waiting for sign-in…')).toBeInTheDocument();

    await act(async () => {
      handlers.onData(`${tokenSuffix}\r\n`);
      await flushWrites();
    });
    expect(mockSave).toHaveBeenCalledWith(`${tokenPrefix}${tokenSuffix}`);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  // xterm's resolved buffer can genuinely lose already-printed content — a
  // full clear, an alt-screen switch, or scrollback overflow all reproduce
  // live against the real @xterm/headless build. The raw, ANSI-stripped
  // accumulated-chunks fallback exists specifically so a token already
  // printed before a clear isn't lost with it.
  it('recovers a token from raw output when a screen clear wipes it from the resolved buffer', async () => {
    mockSave.mockResolvedValueOnce({ ok: true, last4: 'mnop' });
    const token = `sk-ant-oat01-${'Y'.repeat(45)}`;
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData(`${token}\r\n`);
      // Erase in display + erase saved lines — after this, xterm's own
      // resolved buffer.active no longer contains the token at all.
      handlers.onData('\x1b[2J\x1b[3J');
      handlers.onData('Some unrelated status line\r\n');
      await flushWrites();
    });

    expect(mockSave).toHaveBeenCalledWith(token);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
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

  // A previously-invisible failure mode: shell.openExternal can fail (no
  // default browser registered, a broken xdg-open, ...), and the UI used to
  // just claim a browser opened and wait forever with no way out other than
  // Cancel. Now the URL itself is always shown as a manual fallback the
  // instant it's found, and a failed automatic attempt offers a retry.
  it('shows a manual fallback with the URL and a retry button when the browser fails to open automatically', async () => {
    mockOpenExternal.mockResolvedValueOnce({ ok: false });
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData('https://claude.com/cai/oauth/authorize?code=abc123\r\n');
      await flushWrites();
    });

    expect(
      await screen.findByText("Couldn't open your browser automatically."),
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://claude.com/cai/oauth/authorize?code=abc123'),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Try opening again' }),
      );
    });

    // The retry succeeds via the persistent default mock resolution set in
    // beforeEach — the failure banner clears once it does.
    expect(mockOpenExternal).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Couldn't open your browser automatically."),
    ).not.toBeInTheDocument();
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
      handlers.onData(
        `sk-ant-oat01-somecapturedtokenvalue1234567890${'a'.repeat(10)}\r\n`,
      );
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

  // A rejected save previously left the UI stuck on "Waiting for sign-in…"
  // forever (the process was already torn down, but state never moved past
  // 'connecting') — a locked keychain or a full disk on the main-process
  // side would reject rather than resolve { ok: false }.
  it('surfaces a rejected save as a real error instead of leaving the UI stuck', async () => {
    mockSave.mockRejectedValueOnce(new Error('disk full'));
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();

    await act(async () => {
      handlers.onData(`sk-ant-oat01-${'z'.repeat(45)}\r\n`);
      await flushWrites();
    });

    expect(await screen.findByText("Couldn't connect")).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
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
      handlers.onData(`sk-ant-oat01-alreadyfoundtoken${'q'.repeat(25)}\r\n`);
      await flushWrites();
    });
    expect(await screen.findByText('Connected')).toBeInTheDocument();

    await act(async () => {
      handlers.onExit({ code: 0 });
    });
    // Still showing success, not overwritten by the exit handler's error path.
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('cancelling while connecting stops listening and explicitly cancels the process', () => {
    const { onClose } = renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // The whole reason connect()'s unsubscribe and the explicit cancel are
  // two separate things: a plain unmount (route navigation away, say)
  // shouldn't guarantee-fail a sign-in that might still complete moments
  // later with the renderer no longer watching for it.
  it('unmounting while connecting stops listening but does not cancel the process', () => {
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );

    cleanup();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('starting a fresh attempt over a failed one tears down the previous attempt first', async () => {
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const firstUnsubscribeCalls = mockUnsubscribe.mock.calls.length;
    const handlers = getHandlers();

    await act(async () => {
      handlers.onExit({ code: 1 });
    });
    expect(await screen.findByText("Couldn't connect")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // The retry's own startConnect() calls teardown() first — on a fresh
    // attempt (nothing to tear down yet) this is a no-op, but here it
    // proves the *previous* attempt's listener was cleaned up rather than
    // silently left registered alongside the new one.
    expect(mockUnsubscribe.mock.calls.length).toBeGreaterThan(
      firstUnsubscribeCalls,
    );
    expect(mockConnect).toHaveBeenCalledTimes(2);
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

  // A rejected manual save must reset the "Validating…" busy state rather
  // than leaving the Save button permanently disabled.
  it('recovers the manual-paste form after a rejected save instead of leaving it stuck', async () => {
    mockSave.mockRejectedValueOnce(new Error('network unreachable'));
    renderModal();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in browser' }),
    );
    const handlers = getHandlers();
    await act(async () => {
      handlers.onExit({ code: 1 });
    });
    fireEvent.click(screen.getByText('Having trouble? Paste a token manually'));

    const input = await screen.findByLabelText('Subscription token');
    fireEvent.change(input, { target: { value: 'sk-ant-oat01-retryme' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    });

    expect(await screen.findByText('network unreachable')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save token' }),
    ).not.toBeDisabled();
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
