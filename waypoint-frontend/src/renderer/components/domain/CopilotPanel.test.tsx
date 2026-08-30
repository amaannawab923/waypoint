import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  getCopilotConversation,
  postCopilotUserMessage,
  postCopilotAssistantMessage,
} from '@/mock/api';
import type { CopilotConversation, CopilotMessage } from '@/types/entities';
import { CopilotPanel } from './CopilotPanel';

jest.mock('@/mock/api', () => ({
  getCopilotConversation: jest.fn(),
  postCopilotUserMessage: jest.fn(),
  postCopilotAssistantMessage: jest.fn(),
}));

const mockGetConversation = getCopilotConversation as jest.MockedFunction<
  typeof getCopilotConversation
>;
const mockPostUserMessage = postCopilotUserMessage as jest.MockedFunction<
  typeof postCopilotUserMessage
>;
const mockPostAssistantMessage =
  postCopilotAssistantMessage as jest.MockedFunction<
    typeof postCopilotAssistantMessage
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

function conversation(
  messages: CopilotMessage[] = [],
  overrides: Partial<CopilotConversation> = {},
): CopilotConversation {
  return {
    id: 'c1',
    memberId: 'u1',
    claudeSessionId: null,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    messages,
    ...overrides,
  };
}

type RunPromptHandlers = {
  onChunk: (text: string) => void;
  onDone: (result: {
    fullText: string;
    sessionId: string | null;
  }) => Promise<void> | void;
  onError: (err: { kind: string; message: string }) => void;
};

// window.electron.copilot.runPrompt (issue #7) is a synchronous,
// callback-based API — not a promise — so it needs a different test double
// than the deferred() helper used for the promise-based mock/api calls
// below. This captures whatever handlers CopilotPanel passed in on the most
// recent call, so a test can invoke them directly to simulate the main
// process streaming back chunk/done/error events.
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

let copilotIpc: ReturnType<typeof mockCopilotIpc>;

// Resolving a mocked postCopilotUserMessage promise doesn't synchronously
// unwind all the way to runPrompt being called — handleSend's continuation,
// runAndPersist's own state updates, and the runPrompt call itself span
// several microtask hops that a single act() cycle doesn't reliably flush
// in this environment. waitFor (which polls) is the robust way to wait for
// it, rather than a single act()-then-assert.
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
  // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call
  // history, not queued mockResolvedValueOnce/mockRejectedValueOnce
  // implementations. A value left unconsumed by one test (e.g. a reload
  // response nothing in that test awaited) would otherwise leak into the
  // next test's fetch queue.
  jest.resetAllMocks();
  copilotIpc = mockCopilotIpc();
  // A plain assignment, not Object.defineProperty: empirically, a second
  // Object.defineProperty(window, 'electron', ...) call in a later test
  // silently failed to take effect in this jsdom environment (confirmed via
  // a minimal repro) — window.electron.copilot.runPrompt kept pointing at
  // the *first* test's mock instead of the current test's fresh one. Plain
  // assignment doesn't have that problem.
  (window as unknown as { electron: typeof window.electron }).electron = {
    copilot: { runPrompt: copilotIpc.runPrompt },
  } as unknown as typeof window.electron;
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
    it('shows a transient user bubble immediately, then streams the reply and shows persisted messages after reload', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      const postUser = deferred<CopilotMessage>();
      mockPostUserMessage.mockReturnValueOnce(postUser.promise);

      await typeAndSend('What is my sprint status?');

      // Transient bubble appears before the user-message POST even settles.
      // Scoped to a `div` because React mirrors the textarea's current
      // value into its own child text node here, which would otherwise
      // also match.
      expect(
        await screen.findByText('What is my sprint status?', {
          selector: 'div',
        }),
      ).toBeInTheDocument();

      postUser.resolve(
        message({
          id: 'm1',
          role: 'user',
          content: 'What is my sprint status?',
        }),
      );
      const handlers = await waitForRun('What is my sprint status?');

      // Progressive chunks render as they arrive, before the run finishes.
      act(() => handlers.onChunk('Your '));
      act(() => handlers.onChunk('sprint is on track.'));
      expect(
        await screen.findByText('Your sprint is on track.', {
          selector: 'div',
        }),
      ).toBeInTheDocument();

      mockPostAssistantMessage.mockResolvedValueOnce(
        message({
          id: 'm2',
          role: 'assistant',
          content: 'Your sprint is on track.',
        }),
      );
      mockGetConversation.mockResolvedValueOnce(
        conversation([
          message({
            id: 'm1',
            role: 'user',
            content: 'What is my sprint status?',
          }),
          message({
            id: 'm2',
            role: 'assistant',
            content: 'Your sprint is on track.',
          }),
        ]),
      );

      await act(async () => {
        await handlers.onDone({
          fullText: 'Your sprint is on track.',
          sessionId: 'sess-1',
        });
      });

      expect(mockPostAssistantMessage).toHaveBeenCalledWith(
        'Your sprint is on track.',
        'sess-1',
      );
      await waitFor(() => expect(getTextarea().value).toBe(''));
      // Exactly one bubble for the reply — the streamed/awaiting-persist
      // copy must be replaced by the persisted one, not stacked next to it.
      expect(
        screen.getAllByText('Your sprint is on track.', { selector: 'div' }),
      ).toHaveLength(1);
    });

    it('resumes the same Claude Code session on a second message', async () => {
      mockGetConversation.mockResolvedValueOnce(
        conversation([], { claudeSessionId: 'sess-existing' }),
      );
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'follow up' }),
      );
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

    // Regression test for the reload-no-op bug this feature was built on top
    // of: reload() used to resolve immediately without waiting for the
    // refetch, so a failed refresh after a successful send looked identical
    // to the message silently vanishing.
    it('keeps the reply visible and shows an inline retry when the post-send reload fails', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'this must not vanish' }),
      );
      await typeAndSend('this must not vanish');
      const handlers = await waitForRun('this must not vanish');

      mockPostAssistantMessage.mockResolvedValueOnce(
        message({ id: 'm2', role: 'assistant', content: 'reply' }),
      );
      mockGetConversation.mockRejectedValueOnce(new Error('reload failed'));

      await act(async () => {
        await handlers.onDone({ fullText: 'reply', sessionId: 'sess-1' });
      });

      expect(
        await screen.findByText('reply', { selector: 'div' }),
      ).toBeInTheDocument();
      expect(await screen.findByText("Couldn't refresh.")).toBeInTheDocument();
      // Must not be mistaken for the "nothing loaded at all" failure state.
      expect(
        screen.queryByText("Couldn't load Copilot."),
      ).not.toBeInTheDocument();

      mockGetConversation.mockResolvedValueOnce(
        conversation([
          message({ id: 'm1', role: 'user', content: 'this must not vanish' }),
          message({ id: 'm2', role: 'assistant', content: 'reply' }),
        ]),
      );
      fireEvent.click(screen.getByText('Try again'));

      await waitFor(() =>
        expect(screen.queryByText("Couldn't refresh.")).not.toBeInTheDocument(),
      );
      // Exactly one bubble, not stacked with the local unpersisted copy.
      await waitFor(() =>
        expect(screen.getAllByText('reply', { selector: 'div' })).toHaveLength(
          1,
        ),
      );
    });

    // Regression test: a failed POST used to silently discard the typed
    // draft. The draft must survive so the user can retry the send.
    it('keeps the typed draft and drops the transient bubble when the user-message POST itself fails', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockRejectedValueOnce(new Error('post failed'));

      await act(async () => {
        await typeAndSend('please do not disappear');
      });

      expect(getTextarea().value).toBe('please do not disappear');
      expect(
        screen.queryByText('please do not disappear', { selector: 'div' }),
      ).not.toBeInTheDocument();
      expect(mockGetConversation).toHaveBeenCalledTimes(1); // only the initial load, no reload attempted
      expect(copilotIpc.runPrompt).not.toHaveBeenCalled(); // nothing to run — the message never sent
    });

    it('produces no unhandled promise rejection when the user-message POST fails', async () => {
      const onUnhandledRejection = jest.fn();
      process.on('unhandledRejection', onUnhandledRejection);

      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockRejectedValueOnce(new Error('post failed'));
      await act(async () => {
        await typeAndSend('trigger a failure');
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      process.off('unhandledRejection', onUnhandledRejection);
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    });

    it('disables the composer for the full duration of an in-flight send, including the streaming run', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      const postUser = deferred<CopilotMessage>();
      mockPostUserMessage.mockReturnValueOnce(postUser.promise);

      await typeAndSend('in flight check');

      expect(getTextarea().disabled).toBe(true);
      expect(getSendButton().disabled).toBe(true);

      postUser.resolve(message({ id: 'm1', content: 'in flight check' }));
      const handlers = await waitForRun('in flight check');

      // The user-message POST has settled, but the run hasn't — still
      // disabled, since Composer's `sending` spans the whole handleSend
      // call, not just the initial POST.
      expect(getTextarea().disabled).toBe(true);

      mockPostAssistantMessage.mockResolvedValueOnce(
        message({ id: 'm2', role: 'assistant', content: 'reply' }),
      );
      mockGetConversation.mockResolvedValueOnce(
        conversation([message({ content: 'in flight check' })]),
      );
      await act(async () => {
        await handlers.onDone({ fullText: 'reply', sessionId: 'sess-1' });
      });

      await waitFor(() => expect(getTextarea().disabled).toBe(false));
    });

    it('keeps the composer disabled while a generated reply is awaiting persistence', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hi' }),
      );
      await typeAndSend('hi');
      const handlers = await waitForRun('hi');

      const postAssistant = deferred<CopilotMessage>();
      mockPostAssistantMessage.mockReturnValueOnce(postAssistant.promise);
      mockGetConversation.mockResolvedValueOnce(
        conversation([
          message({ id: 'm1', content: 'hi' }),
          message({ id: 'm2', role: 'assistant', content: 'reply' }),
        ]),
      );

      act(() => {
        handlers.onDone({ fullText: 'reply', sessionId: 'sess-1' });
      });

      // handleSend has now returned (its promise resolved once onDone's own
      // async work was kicked off) even though the persist call is still
      // pending — Composer's own `sending` flag alone can't cover this, so
      // CopilotPanel disables the composer directly via `awaitingPersist`.
      await waitFor(() => expect(getTextarea().disabled).toBe(true));

      await act(async () => {
        postAssistant.resolve(
          message({ id: 'm2', role: 'assistant', content: 'reply' }),
        );
      });
    });

    // Regression coverage for the persist-retry path: a reply that streamed
    // successfully but failed to save must stay visible, with a retry that
    // re-attempts *only* the save — not a second, wasteful LLM run.
    it('shows a retry when saving the reply fails, and retrying does not re-run the LLM', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hi' }),
      );
      await typeAndSend('hi');
      const handlers = await waitForRun('hi');

      mockPostAssistantMessage.mockRejectedValueOnce(new Error('save failed'));
      await act(async () => {
        await handlers.onDone({ fullText: 'reply text', sessionId: 'sess-1' });
      });

      expect(
        await screen.findByText('reply text', { selector: 'div' }),
      ).toBeInTheDocument();
      expect(
        await screen.findByText("Couldn't save this reply."),
      ).toBeInTheDocument();
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(1);

      mockPostAssistantMessage.mockResolvedValueOnce(
        message({ id: 'm2', role: 'assistant', content: 'reply text' }),
      );
      mockGetConversation.mockResolvedValueOnce(
        conversation([
          message({ id: 'm2', role: 'assistant', content: 'reply text' }),
        ]),
      );
      await act(async () => {
        fireEvent.click(screen.getByText('Retry'));
      });

      expect(mockPostAssistantMessage).toHaveBeenLastCalledWith(
        'reply text',
        'sess-1',
      );
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(1); // still just the one run
      await waitFor(() =>
        expect(
          screen.queryByText("Couldn't save this reply."),
        ).not.toBeInTheDocument(),
      );
    });

    // The user's own message was already persisted before the run started —
    // a run failure must not read as "your message failed to send".
    it('shows a clear inline error when the Claude Code run itself fails, and keeps the sent message visible', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hello' }),
      );
      mockGetConversation.mockResolvedValueOnce(
        conversation([message({ id: 'm1', content: 'hello' })]),
      );
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
      expect(mockPostAssistantMessage).not.toHaveBeenCalled();
      // No reply was ever generated, so nothing should be stuck "awaiting
      // persist" — the composer should be usable again.
      await waitFor(() => expect(getTextarea().disabled).toBe(false));

      // "Try again" retries the run with the same prompt, not a new send —
      // the user's message must not be posted (and duplicated) a second time.
      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      expect(mockPostUserMessage).toHaveBeenCalledTimes(1);
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);
      expect(copilotIpc.runPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: 'hello' }),
        expect.anything(),
      );
    });

    // An auth_failed error specifically gets a real recovery action, not
    // just inline text — this is the gap live testing found: the chat had
    // no visible path from "not logged in" to actually fixing it short of
    // already knowing to dig through Settings.
    it('shows a "Connect your Claude subscription" action for an auth_failed error, distinct from other error kinds', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hii' }),
      );
      mockGetConversation.mockResolvedValueOnce(
        conversation([message({ id: 'm1', content: 'hii' })]),
      );
      await typeAndSend('hii');
      const handlers = await waitForRun('hii');

      act(() => {
        handlers.onError({
          kind: 'auth_failed',
          message: 'Not logged in to Claude Code — run `claude login`...',
        });
      });

      expect(
        await screen.findByText('Not connected to Claude'),
      ).toBeInTheDocument();
      const connectButton = screen.getByRole('button', {
        name: /Connect your Claude subscription/,
      });
      expect(connectButton).toBeInTheDocument();
      // The generic "Try again" link is specific to non-auth failures —
      // showing both would be redundant with the connect action, and "Try
      // again" alone would silently repeat the same failure forever without
      // ever pointing at the actual fix.
      expect(screen.queryByText('Try again')).not.toBeInTheDocument();

      fireEvent.click(connectButton);
      expect(
        await screen.findByRole('dialog', { name: 'Connect Claude' }),
      ).toBeInTheDocument();
    });

    // Regression test: the backend rejects blank content outright, so a run
    // that completes with no real text (a possible outcome once auth_error
    // is reported early but the CLI is still mid-retry, or any other run
    // that produces an effectively empty result) used to go on to set
    // awaitingPersist anyway, fail the save with a 400, and leave the
    // composer permanently disabled — awaitingPersist never clears without
    // a successful persist, and "Retry" could only ever resend the same
    // empty text.
    it('shows a retry instead of permanently locking the composer when the run finishes with an empty reply', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hello' }),
      );
      await typeAndSend('hello');
      const handlers = await waitForRun('hello');

      await act(async () => {
        await handlers.onDone({ fullText: '   ', sessionId: 'sess-1' });
      });

      expect(
        await screen.findByText(/didn't return a reply/i),
      ).toBeInTheDocument();
      expect(mockPostAssistantMessage).not.toHaveBeenCalled();
      await waitFor(() => expect(getTextarea().disabled).toBe(false));

      copilotIpc.runPrompt.mockImplementationOnce(() => jest.fn());
      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      expect(mockPostUserMessage).toHaveBeenCalledTimes(1); // not re-sent
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);
    });

    // Regression test: a run this side has already reported as failed (or
    // superseded via "Try again") can still be alive in the main process —
    // e.g. an auth_error is surfaced immediately while the CLI keeps
    // retrying internally. Without a per-run generation guard, that stale
    // run's later chunk/done events land in the same streamingText state a
    // newer run is now writing to, interleaving two replies into one bubble.
    it('ignores late chunk events from a superseded run after "Try again" starts a new one', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hello' }),
      );
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
        await screen.findByText('Second run reply', { selector: 'div' }),
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

    // Regression test: a real bug found via live testing against the actual
    // Electron app — window.electron.copilot.runPrompt threw synchronously
    // (Illegal invocation, from a receiver-binding bug in preload.ts), and
    // runAndPersist had no guard around that call. streamingText was set to
    // '' right before the throw and nothing ever cleared it afterward — the
    // panel showed an infinite "..." bubble with the composer eventually
    // re-enabled but no way to ever know something had gone wrong.
    it('shows a clear error instead of hanging forever when runPrompt itself throws synchronously', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hello' }),
      );
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
      // No reply was ever generated — nothing should be stuck showing a
      // perpetual streaming bubble, and the composer must be usable again.
      expect(
        screen.queryByText('…', { selector: 'div' }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(getTextarea().disabled).toBe(false));

      // "Try again" must retry the run (not silently do nothing, and not
      // re-send the already-persisted user message).
      copilotIpc.runPrompt.mockImplementationOnce(() => jest.fn());
      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });
      expect(mockPostUserMessage).toHaveBeenCalledTimes(1);
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);
    });

    it('unsubscribes from the IPC stream on unmount without cancelling the run', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'hi' }),
      );
      await typeAndSend('hi');
      await waitForRun('hi');

      expect(copilotIpc.unsubscribe).not.toHaveBeenCalled();
      unmount();
      expect(copilotIpc.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('does not submit on Shift+Enter, and does not send an empty/whitespace draft', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      fireEvent.change(getTextarea(), { target: { value: '   ' } });
      expect(getSendButton().disabled).toBe(true);

      fireEvent.change(getTextarea(), { target: { value: 'real content' } });
      fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: true });

      expect(mockPostUserMessage).not.toHaveBeenCalled();
    });

    it('submits on Enter without Shift', async () => {
      mockGetConversation.mockResolvedValueOnce(conversation([]));
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/Ask Copilot anything/i);

      mockPostUserMessage.mockResolvedValueOnce(
        message({ id: 'm1', content: 'enter key send' }),
      );

      fireEvent.change(getTextarea(), { target: { value: 'enter key send' } });
      await act(async () => {
        fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: false });
      });

      expect(mockPostUserMessage).toHaveBeenCalledWith('enter key send');
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
