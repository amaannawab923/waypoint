import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { getCopilotConversation, sendCopilotMessage } from '@/mock/api';
import type { CopilotConversation, CopilotMessage } from '@/types/entities';
import { CopilotPanel } from './CopilotPanel';

jest.mock('@/mock/api', () => ({
  getCopilotConversation: jest.fn(),
  sendCopilotMessage: jest.fn(),
}));

const mockGetConversation = getCopilotConversation as jest.MockedFunction<
  typeof getCopilotConversation
>;
const mockSendMessage = sendCopilotMessage as jest.MockedFunction<
  typeof sendCopilotMessage
>;

function message(overrides: Partial<CopilotMessage>): CopilotMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    content: 'hi',
    seq: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

function conversation(messages: CopilotMessage[] = []): CopilotConversation {
  return {
    id: 'c1',
    memberId: 'u1',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    messages,
  };
}

/** A promise plus its resolve/reject, for controlling settlement timing by hand. */
function deferred<T>() {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
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

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call
  // history, not queued mockResolvedValueOnce/mockRejectedValueOnce
  // implementations. A value left unconsumed by one test (e.g. a reload
  // response nothing in that test awaited) would otherwise leak into the
  // next test's fetch queue.
  jest.resetAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('CopilotPanel', () => {
  it('shows a loading state, then the conversation once it resolves', async () => {
    mockGetConversation.mockResolvedValue(
      conversation([message({ id: 'm1', content: 'Hello there' })]),
    );

    render(<CopilotPanel onClose={jest.fn()} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('Hello there')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('shows the empty state when the conversation has no messages', async () => {
    mockGetConversation.mockResolvedValue(conversation([]));

    render(<CopilotPanel onClose={jest.fn()} />);

    expect(
      await screen.findByText(/Ask Copilot anything/i),
    ).toBeInTheDocument();
  });

  it('shows a retry affordance when the initial load fails, and recovers on retry', async () => {
    mockGetConversation.mockRejectedValueOnce(new Error('network down'));
    render(<CopilotPanel onClose={jest.fn()} />);

    expect(
      await screen.findByText("Couldn't load Copilot."),
    ).toBeInTheDocument();

    mockGetConversation.mockResolvedValueOnce(
      conversation([message({ id: 'm1', content: 'Recovered' })]),
    );
    fireEvent.click(screen.getByText('Try again'));

    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load Copilot."),
    ).not.toBeInTheDocument();
  });

  describe('sending a message', () => {
    it('shows a transient bubble immediately, then the persisted messages after reload', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      const send = deferred<CopilotMessage>();
      mockSendMessage.mockReturnValueOnce(send.promise);
      mockGetConversation.mockResolvedValueOnce(
        conversation([
          message({
            id: 'm1',
            role: 'user',
            content: 'What is my sprint status?',
          }),
        ]),
      );

      await typeAndSend('What is my sprint status?');

      // Transient bubble appears before the POST even settles. Scoped to a
      // `div` because React mirrors the textarea's current value into its
      // own child text node here, which would otherwise also match.
      expect(
        await screen.findByText('What is my sprint status?', {
          selector: 'div',
        }),
      ).toBeInTheDocument();

      await act(async () => {
        send.resolve(
          message({ id: 'm2', role: 'assistant', content: 'reply' }),
        );
      });

      await waitFor(() => expect(getTextarea().value).toBe(''));
      expect(
        screen.getByText('What is my sprint status?', { selector: 'div' }),
      ).toBeInTheDocument();
    });

    // Regression test for the reload-no-op bug: reload() used to resolve
    // immediately without waiting for the refetch, so a failed refresh after
    // a successful send looked identical to the message silently vanishing.
    it('keeps the message visible and shows an inline retry when the post-send reload fails', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockSendMessage.mockResolvedValueOnce(
        message({ id: 'm2', role: 'assistant', content: 'reply' }),
      );
      mockGetConversation.mockRejectedValueOnce(new Error('reload failed'));

      await act(async () => {
        await typeAndSend('this must not vanish');
      });

      expect(
        await screen.findByText('this must not vanish', { selector: 'div' }),
      ).toBeInTheDocument();
      expect(await screen.findByText("Couldn't refresh.")).toBeInTheDocument();
      // Must not be mistaken for the "nothing loaded at all" failure state.
      expect(
        screen.queryByText("Couldn't load Copilot."),
      ).not.toBeInTheDocument();

      mockGetConversation.mockResolvedValueOnce(
        conversation([
          message({ id: 'm1', role: 'user', content: 'this must not vanish' }),
        ]),
      );
      fireEvent.click(screen.getByText('Try again'));

      await waitFor(() =>
        expect(screen.queryByText("Couldn't refresh.")).not.toBeInTheDocument(),
      );
      // The transient bubble must be replaced by the persisted message, not
      // stacked alongside it — exactly one bubble, not two.
      await waitFor(() =>
        expect(
          screen.getAllByText('this must not vanish', { selector: 'div' }),
        ).toHaveLength(1),
      );
    });

    // Regression test: a failed POST used to silently discard the typed
    // draft. The draft must survive so the user can retry the send.
    it('keeps the typed draft and drops the transient bubble when the POST itself fails', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockSendMessage.mockRejectedValueOnce(new Error('post failed'));

      await act(async () => {
        await typeAndSend('please do not disappear');
      });

      expect(getTextarea().value).toBe('please do not disappear');
      expect(
        screen.queryByText('please do not disappear', { selector: 'div' }),
      ).not.toBeInTheDocument();
      expect(mockGetConversation).toHaveBeenCalledTimes(1); // only the initial load, no reload attempted
    });

    it('produces no unhandled promise rejection when the POST fails', async () => {
      const onUnhandledRejection = jest.fn();
      process.on('unhandledRejection', onUnhandledRejection);

      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockSendMessage.mockRejectedValueOnce(new Error('post failed'));
      await act(async () => {
        await typeAndSend('trigger a failure');
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      process.off('unhandledRejection', onUnhandledRejection);
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    });

    it('disables the textarea and send button for the full duration of an in-flight send', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      const send = deferred<CopilotMessage>();
      mockSendMessage.mockReturnValueOnce(send.promise);

      await typeAndSend('in flight check');

      expect(getTextarea().disabled).toBe(true);
      expect(getSendButton().disabled).toBe(true);

      mockGetConversation.mockResolvedValueOnce(
        conversation([message({ content: 'in flight check' })]),
      );
      await act(async () => {
        send.resolve(
          message({ id: 'm2', role: 'assistant', content: 'reply' }),
        );
      });

      await waitFor(() => expect(getTextarea().disabled).toBe(false));
    });

    it('does not submit on Shift+Enter, and does not send an empty/whitespace draft', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      fireEvent.change(getTextarea(), { target: { value: '   ' } });
      expect(getSendButton().disabled).toBe(true);

      fireEvent.change(getTextarea(), { target: { value: 'real content' } });
      fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: true });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('submits on Enter without Shift', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockSendMessage.mockResolvedValueOnce(
        message({ id: 'm2', role: 'assistant', content: 'reply' }),
      );
      mockGetConversation.mockResolvedValueOnce(
        conversation([message({ content: 'enter key send' })]),
      );

      fireEvent.change(getTextarea(), { target: { value: 'enter key send' } });
      await act(async () => {
        fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: false });
      });

      expect(mockSendMessage).toHaveBeenCalledWith('enter key send');
    });
  });

  describe('Escape key handling', () => {
    it('closes the panel when Escape is pressed with focus inside it', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      const onClose = jest.fn();
      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/Ask Copilot anything/i);

      getTextarea().focus();
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // Regression test: the Escape listener used to fire regardless of focus,
    // since keydown bubbles to `document` no matter where focus actually is.
    it('does not close the panel when Escape is pressed with focus outside it', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      const onClose = jest.fn();

      const outsideInput = document.createElement('input');
      document.body.appendChild(outsideInput);

      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/Ask Copilot anything/i);

      outsideInput.focus();
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).not.toHaveBeenCalled();

      document.body.removeChild(outsideInput);
    });

    it('ignores non-Escape keys', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      const onClose = jest.fn();
      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/Ask Copilot anything/i);

      getTextarea().focus();
      fireEvent.keyDown(document, { key: 'Enter' });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('close button and focus restoration', () => {
    it('calls onClose when the close button is clicked', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      const onClose = jest.fn();
      render(<CopilotPanel onClose={onClose} />);
      await screen.findByText(/Ask Copilot anything/i);

      fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('restores focus to the previously focused element on unmount', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));

      const toggleButton = document.createElement('button');
      document.body.appendChild(toggleButton);
      toggleButton.focus();
      expect(document.activeElement).toBe(toggleButton);

      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      unmount();

      expect(document.activeElement).toBe(toggleButton);
      document.body.removeChild(toggleButton);
    });
  });
});
