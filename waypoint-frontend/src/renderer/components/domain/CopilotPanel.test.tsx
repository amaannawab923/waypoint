import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { CopilotPanel } from './CopilotPanel';

type RunPromptHandlers = {
  onChunk: (text: string) => void;
  onDone: (result: { fullText: string; sessionId: string | null }) => void;
  onError: (err: { kind: string; message: string }) => void;
};

// window.electron.copilot.runPrompt (issue #7) is a synchronous,
// callback-based API — not a promise — so it needs a different test double
// than a resolved/rejected promise. This captures whatever handlers
// CopilotPanel passed in on the most recent call, so a test can invoke them
// directly to simulate the main process streaming back chunk/done/error
// events. Ported from the pre-multi-session CopilotPanel.test.tsx, which
// used the same double.
function mockCopilotIpc() {
  let handlers: RunPromptHandlers | null = null;
  const unsubscribe = jest.fn();
  const runPrompt = jest.fn(
    (
      _args: { prompt: string; resumeSessionId?: string },
      h: RunPromptHandlers,
    ) => {
      handlers = h;
      return unsubscribe;
    },
  );
  return {
    runPrompt,
    unsubscribe,
    getHandlers: () => {
      if (!handlers) throw new Error('runPrompt was not called yet');
      return handlers;
    },
  };
}

function getTextarea() {
  return screen.getByPlaceholderText('Ask Copilot…') as HTMLTextAreaElement;
}

function getSendButton() {
  return screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
}

async function typeAndSend(content: string) {
  fireEvent.change(getTextarea(), { target: { value: content } });
  fireEvent.click(getSendButton());
}

// Two elements share the accessible name "New session" while the list view
// is showing: the panel header's "+" icon button (aria-label) and the
// list's own dashed CTA row (its own text). The header one is always first
// in DOM order (the header renders before the list body), so index 0
// reliably targets it.
function getHeaderNewSessionButton() {
  return screen.getAllByRole('button', { name: 'New session' })[0];
}

async function createAndOpenSession() {
  fireEvent.click(getHeaderNewSessionButton());
  await screen.findByText(/Ask Copilot anything/i);
}

let copilotIpc: ReturnType<typeof mockCopilotIpc>;

async function waitForRun(prompt: string) {
  await waitFor(() =>
    expect(copilotIpc.runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt }),
      expect.anything(),
    ),
  );
  return copilotIpc.getHandlers();
}

beforeEach(() => {
  localStorage.clear();
  copilotIpc = mockCopilotIpc();
  // A plain assignment, not Object.defineProperty: the pre-multi-session
  // suite found that a second Object.defineProperty(window, 'electron', ...)
  // call silently failed to take effect in this jsdom environment across
  // tests — window.electron.copilot.runPrompt kept pointing at the *first*
  // test's mock. Plain assignment doesn't have that problem.
  (window as unknown as { electron: typeof window.electron }).electron = {
    copilot: { runPrompt: copilotIpc.runPrompt },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  cleanup();
});

describe('CopilotPanel', () => {
  it('opens to the session list, showing the empty state when no sessions exist yet', async () => {
    render(<CopilotPanel onClose={jest.fn()} />);
    expect(await screen.findByText(/No sessions yet/i)).toBeInTheDocument();
    expect(screen.getByText('Copilot')).toBeInTheDocument();
  });

  it('creates a session from the header "+" button and switches straight to its (empty) chat', async () => {
    render(<CopilotPanel onClose={jest.fn()} />);
    await screen.findByText(/No sessions yet/i);

    fireEvent.click(getHeaderNewSessionButton());

    expect(
      await screen.findByText(/Ask Copilot anything/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'New session' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Back to sessions' }),
    ).toBeInTheDocument();
  });

  it('creates a session from the list\'s dashed "New session" row and switches to its chat too', async () => {
    render(<CopilotPanel onClose={jest.fn()} />);
    await screen.findByText(/No sessions yet/i);

    // The dashed CTA row, not the header's "+" — disambiguated by matching
    // on its own text content rather than accessible name, since both
    // share the accessible name "New session".
    fireEvent.click(screen.getByText('New session'));

    expect(
      await screen.findByText(/Ask Copilot anything/i),
    ).toBeInTheDocument();
  });

  it('goes back to the session list via the back arrow, and the created session is now listed', async () => {
    render(<CopilotPanel onClose={jest.fn()} />);
    await screen.findByText(/No sessions yet/i);
    await createAndOpenSession();

    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));

    expect(await screen.findByText('Copilot')).toBeInTheDocument();
    // Two matches for the literal text "New session": the dashed CTA row
    // and the just-created session's own (still-default) title — the
    // second one is what proves the session survived the trip back to the
    // list.
    expect(screen.getAllByText('New session')).toHaveLength(2);
    expect(screen.queryByText(/No sessions yet/i)).not.toBeInTheDocument();
  });

  describe('sending a message', () => {
    it('appends the user message immediately (no network round trip), then streams and persists the reply', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('What is my sprint status?');

      // Appears immediately — appendMessage is a synchronous, local write,
      // not something waiting on a POST to settle.
      expect(
        screen.getByText('What is my sprint status?', { selector: 'div' }),
      ).toBeInTheDocument();

      const handlers = await waitForRun('What is my sprint status?');

      act(() => handlers.onChunk('Your '));
      act(() => handlers.onChunk('sprint is on track.'));
      expect(
        screen.getByText('Your sprint is on track.', { selector: 'div' }),
      ).toBeInTheDocument();

      await act(async () => {
        handlers.onDone({
          fullText: 'Your sprint is on track.',
          sessionId: 'sess-1',
        });
      });

      await waitFor(() => expect(getTextarea().value).toBe(''));
      // Exactly one bubble for the reply — the streamed copy must be
      // replaced by the persisted one, not stacked next to it.
      expect(
        screen.getAllByText('Your sprint is on track.', { selector: 'div' }),
      ).toHaveLength(1);
    });

    it('auto-titles the session from the first message sent', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('Can we ship the search revamp?');

      expect(
        await screen.findByRole('heading', {
          name: 'Can we ship the search revamp?',
        }),
      ).toBeInTheDocument();
    });

    it('resumes the same Claude Code session on a second message', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('first message');
      const firstHandlers = await waitForRun('first message');
      await act(async () => {
        firstHandlers.onDone({
          fullText: 'first reply',
          sessionId: 'sess-existing',
        });
      });

      await typeAndSend('follow up');

      await waitFor(() =>
        expect(copilotIpc.runPrompt).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: 'follow up',
            resumeSessionId: 'sess-existing',
          }),
          expect.anything(),
        ),
      );
    });

    it('persists sent and received messages across a full panel remount (localStorage-backed)', async () => {
      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('remember this');
      const handlers = await waitForRun('remember this');
      await act(async () => {
        handlers.onDone({ fullText: 'remembered reply', sessionId: 'sess-1' });
      });

      unmount();

      // A fresh mount (as if the panel were closed and reopened) always
      // opens back on the session list — reads the same localStorage-backed
      // store, not component state.
      render(<CopilotPanel onClose={jest.fn()} />);
      expect(await screen.findByText('remember this')).toBeInTheDocument();

      fireEvent.click(screen.getByText('remember this'));
      expect(
        await screen.findByText('remember this', { selector: 'div' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText('remembered reply', { selector: 'div' }),
      ).toBeInTheDocument();
    });

    it('shows a clear inline error when the Claude Code run itself fails, and keeps the sent message visible', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('hello');
      const handlers = await waitForRun('hello');

      act(() => {
        handlers.onError({
          kind: 'binary_not_found',
          message: "Claude Code isn't installed.",
        });
      });

      expect(
        await screen.findByText("Claude Code isn't installed."),
      ).toBeInTheDocument();
      expect(
        screen.getByText('hello', { selector: 'div' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(getTextarea().disabled).toBe(false));

      // "Try again" retries the run with the same prompt, not a new send —
      // the user's message must not be duplicated in the session's messages.
      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);
      expect(copilotIpc.runPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: 'hello' }),
        expect.anything(),
      );
      expect(screen.getAllByText('hello', { selector: 'div' })).toHaveLength(1);
    });

    it('shows a retry instead of persisting an empty reply when the run finishes with no real text', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('hello');
      const handlers = await waitForRun('hello');

      await act(async () => {
        handlers.onDone({ fullText: '   ', sessionId: 'sess-1' });
      });

      expect(
        await screen.findByText(/didn't return a reply/i),
      ).toBeInTheDocument();
      await waitFor(() => expect(getTextarea().disabled).toBe(false));

      copilotIpc.runPrompt.mockImplementationOnce(() => jest.fn());
      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);
    });

    it('ignores late chunk events from a superseded run after "Try again" starts a new one', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('hello');
      const firstHandlers = await waitForRun('hello');

      act(() => {
        firstHandlers.onError({
          kind: 'generic',
          message: 'transient failure',
        });
      });
      expect(await screen.findByText('transient failure')).toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      const secondHandlers = await waitForRun('hello');
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);

      act(() => secondHandlers.onChunk('Second run reply'));
      expect(
        screen.getByText('Second run reply', { selector: 'div' }),
      ).toBeInTheDocument();

      // The first run's process is still alive somewhere and emits a late
      // chunk — it must not touch the bubble the second run now owns.
      act(() => firstHandlers.onChunk('stale text from the dead run'));

      expect(
        screen.queryByText(/stale text from the dead run/),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('Second run reply', { selector: 'div' }),
      ).toBeInTheDocument();
    });

    it('shows a clear error instead of hanging forever when runPrompt itself throws synchronously', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      copilotIpc.runPrompt.mockImplementationOnce(() => {
        throw new TypeError('Illegal invocation');
      });

      await act(async () => {
        await typeAndSend('hello');
      });

      expect(
        await screen.findByText(/Couldn't reach Copilot's runtime/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Illegal invocation/)).toBeInTheDocument();
      expect(
        screen.queryByText('…', { selector: 'div' }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(getTextarea().disabled).toBe(false));

      copilotIpc.runPrompt.mockImplementationOnce(() => jest.fn());
      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);
    });

    it('disables the composer for the duration of an in-flight streaming run, and re-enables it once done', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('in flight check');
      const handlers = await waitForRun('in flight check');

      expect(getTextarea().disabled).toBe(true);

      await act(async () => {
        handlers.onDone({ fullText: 'reply', sessionId: 'sess-1' });
      });

      await waitFor(() => expect(getTextarea().disabled).toBe(false));
    });

    it('unsubscribes from the IPC stream on unmount without cancelling the run', async () => {
      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('hi');
      await waitForRun('hi');

      expect(copilotIpc.unsubscribe).not.toHaveBeenCalled();
      unmount();
      expect(copilotIpc.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('does not submit on Shift+Enter, and does not send an empty/whitespace draft', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      fireEvent.change(getTextarea(), { target: { value: '   ' } });
      expect(getSendButton().disabled).toBe(true);

      fireEvent.change(getTextarea(), { target: { value: 'real content' } });
      fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: true });

      expect(copilotIpc.runPrompt).not.toHaveBeenCalled();
    });

    it('submits on Enter without Shift', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      fireEvent.change(getTextarea(), { target: { value: 'enter key send' } });
      await act(async () => {
        fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: false });
      });

      const handlers = await waitForRun('enter key send');
      expect(handlers).toBeDefined();
    });
  });

  describe('Escape key handling', () => {
    it('closes the panel when Escape is pressed with focus inside it', async () => {
      const onClose = jest.fn();
      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/No sessions yet/i);

      getHeaderNewSessionButton().focus();
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close the panel when Escape is pressed with focus outside it', async () => {
      const onClose = jest.fn();
      const outsideInput = document.createElement('input');
      document.body.appendChild(outsideInput);

      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/No sessions yet/i);

      outsideInput.focus();
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).not.toHaveBeenCalled();
      document.body.removeChild(outsideInput);
    });

    it('ignores non-Escape keys', async () => {
      const onClose = jest.fn();
      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/No sessions yet/i);

      getHeaderNewSessionButton().focus();
      fireEvent.keyDown(document, { key: 'Enter' });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('close button and focus restoration', () => {
    it('calls onClose when the close button is clicked', async () => {
      const onClose = jest.fn();
      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/No sessions yet/i);

      fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('restores focus to the previously focused element on unmount', async () => {
      const toggleButton = document.createElement('button');
      document.body.appendChild(toggleButton);
      toggleButton.focus();
      expect(document.activeElement).toBe(toggleButton);

      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);

      unmount();

      expect(document.activeElement).toBe(toggleButton);
      document.body.removeChild(toggleButton);
    });
  });
});
