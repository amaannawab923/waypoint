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
  listCopilotConversations,
  createCopilotConversation,
  getCopilotConversation,
  renameCopilotConversation,
  deleteCopilotConversation,
  postCopilotUserMessage,
  postCopilotAssistantMessage,
} from '@/mock/api';
import { CopilotPanel } from './CopilotPanel';

jest.mock('@/mock/api', () => ({
  listCopilotConversations: jest.fn(),
  createCopilotConversation: jest.fn(),
  getCopilotConversation: jest.fn(),
  renameCopilotConversation: jest.fn(),
  deleteCopilotConversation: jest.fn(),
  postCopilotUserMessage: jest.fn(),
  postCopilotAssistantMessage: jest.fn(),
}));

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

// A small in-memory fake backend (issue #11's migration) standing in for
// the real Postgres-backed service — mirrors its actual behavior (id
// generation, updatedAt-descending listing, auto-titling the conversation
// from its first message, never overwriting claudeSessionId with null)
// closely enough that these tests exercise the same UI flows the real
// backend would produce, without a real HTTP round trip.
interface FakeMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}
interface FakeConversation {
  id: string;
  memberId: string;
  title: string;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: FakeMessage[];
}

const TITLE_MAX_LENGTH = 60;
function truncateTitle(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'New session';
  if (singleLine.length <= TITLE_MAX_LENGTH) return singleLine;
  return `${singleLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

let store: FakeConversation[];
let idCounter: number;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function summaryOf(conv: FakeConversation) {
  const { messages: _messages, ...summary } = conv;
  return summary;
}

beforeEach(() => {
  store = [];
  idCounter = 0;

  jest
    .mocked(listCopilotConversations)
    .mockImplementation(async () =>
      [...store]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summaryOf),
    );

  jest.mocked(createCopilotConversation).mockImplementation(async () => {
    const now = new Date().toISOString();
    const conv: FakeConversation = {
      id: nextId('conv'),
      memberId: 'mem-1',
      title: 'New session',
      claudeSessionId: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    store.push(conv);
    return summaryOf(conv);
  });

  jest.mocked(getCopilotConversation).mockImplementation(async (id: string) => {
    const conv = store.find((c) => c.id === id);
    if (!conv) throw new Error(`conversation not found: ${id}`);
    return {
      ...conv,
      messages: conv.messages.map((m, index) => ({
        ...m,
        conversationId: conv.id,
        seq: index + 1,
      })),
    };
  });

  jest
    .mocked(renameCopilotConversation)
    .mockImplementation(async (id: string, title: string) => {
      const conv = store.find((c) => c.id === id);
      if (!conv) throw new Error(`conversation not found: ${id}`);
      conv.title = title;
      conv.updatedAt = new Date().toISOString();
      return summaryOf(conv);
    });

  jest
    .mocked(deleteCopilotConversation)
    .mockImplementation(async (id: string) => {
      store = store.filter((c) => c.id !== id);
    });

  jest
    .mocked(postCopilotUserMessage)
    .mockImplementation(async (conversationId: string, content: string) => {
      const conv = store.find((c) => c.id === conversationId);
      if (!conv) throw new Error(`conversation not found: ${conversationId}`);
      const message: FakeMessage = {
        id: nextId('msg'),
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };
      conv.messages.push(message);
      conv.updatedAt = message.createdAt;
      if (conv.messages.length === 1) conv.title = truncateTitle(content);
      return {
        id: message.id,
        conversationId,
        role: 'user',
        content,
        seq: conv.messages.length,
        createdAt: message.createdAt,
      };
    });

  jest
    .mocked(postCopilotAssistantMessage)
    .mockImplementation(
      async (
        conversationId: string,
        content: string,
        claudeSessionId: string | null,
      ) => {
        const conv = store.find((c) => c.id === conversationId);
        if (!conv) throw new Error(`conversation not found: ${conversationId}`);
        const message: FakeMessage = {
          id: nextId('msg'),
          role: 'assistant',
          content,
          createdAt: new Date().toISOString(),
        };
        conv.messages.push(message);
        conv.updatedAt = message.createdAt;
        if (claudeSessionId !== null) conv.claudeSessionId = claudeSessionId;
        return {
          id: message.id,
          conversationId,
          role: 'assistant',
          content,
          seq: conv.messages.length,
          createdAt: message.createdAt,
        };
      },
    );
});

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
    await waitFor(() =>
      expect(screen.getAllByText('New session')).toHaveLength(2),
    );
    expect(screen.queryByText(/No sessions yet/i)).not.toBeInTheDocument();
  });

  describe('session list load failure', () => {
    // Regression coverage: a failed list fetch used to render identically to
    // a genuinely empty list ("No sessions yet") — indistinguishable from
    // real data loss to a user who actually has history. See
    // useCopilotConversations.ts's `error` and CopilotPanel.tsx's `listError`.
    it('shows an error with a retry instead of "No sessions yet" when the list fetch fails', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockRejectedValueOnce(new Error('network down'));
      render(<CopilotPanel onClose={jest.fn()} />);

      expect(
        await screen.findByText(/Failed to load your Copilot sessions/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/No sessions yet/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Try again'));

      expect(await screen.findByText(/No sessions yet/i)).toBeInTheDocument();
      expect(
        screen.queryByText(/Failed to load your Copilot sessions/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('opening a session whose history fails to fetch', () => {
    // Regression coverage: a failed openSession() used to clear the loading
    // flag with no error shown, leaving the chat view rendering "Ask Copilot
    // anything" — identical to a real empty conversation, silently hiding
    // that real history failed to load.
    it('shows an error with a retry instead of the empty-conversation prompt', async () => {
      // A session with real history, populated the normal way (create, send,
      // wait for reply) — its messages land in this hook instance's cache as
      // a side effect of having been open, which would defeat the point of
      // this test (openSession() short-circuits on an already-cached id, see
      // its own "no-op if already cached" comment). Unmount and remount, the
      // same way the "Loading messages…" coverage above does, to get a fresh
      // hook instance whose cache is genuinely cold for this session.
      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();
      await typeAndSend('has real history');
      // First message in the session — handleSend also awaits a reload()
      // here (see its own comment), whose state updates land outside the
      // act() scope typeAndSend's fireEvent established.
      await act(async () => {});
      const handlers = await waitForRun('has real history');
      await act(async () => {
        handlers.onDone({ fullText: 'a reply', sessionId: 'sess-1' });
      });
      unmount();
      render(<CopilotPanel onClose={jest.fn()} />);
      const row = await screen.findByText('has real history');

      jest
        .mocked(getCopilotConversation)
        .mockRejectedValueOnce(new Error('conversation fetch failed'));
      fireEvent.click(row);

      expect(
        await screen.findByText(/Failed to load the conversation history/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Ask Copilot anything/i),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Try again'));

      // The retry succeeds (getCopilotConversation only rejected once) and
      // the real history — not an empty conversation — is what comes back.
      await waitFor(() =>
        expect(
          screen.queryByText(/Failed to load the conversation history/i),
        ).not.toBeInTheDocument(),
      );
      expect(
        await screen.findByText('has real history', { selector: 'p' }),
      ).toBeInTheDocument();
      expect(
        await screen.findByText('a reply', { selector: 'p' }),
      ).toBeInTheDocument();
    });
  });

  describe('sending a message', () => {
    it('appends the user message immediately, then streams and persists the reply', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('What is my sprint status?');
      // This is the session's first message, so handleSend also awaits a
      // reload() to pick up the server-derived title (see its own comment)
      // — that reload's state updates land outside the act() scope
      // typeAndSend's fireEvent established, so flush it explicitly before
      // asserting rather than relying on findByText's own retry timing.
      await act(async () => {});

      // Appears fast — a local optimistic write, not waiting on the whole
      // round trip to settle before showing anything.
      expect(
        await screen.findByText('What is my sprint status?', {
          selector: 'p',
        }),
      ).toBeInTheDocument();

      const handlers = await waitForRun('What is my sprint status?');

      act(() => handlers.onChunk('Your '));
      act(() => handlers.onChunk('sprint is on track.'));
      expect(
        screen.getByText('Your sprint is on track.', { selector: 'p' }),
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
      await waitFor(() =>
        expect(
          screen.getAllByText('Your sprint is on track.', { selector: 'p' }),
        ).toHaveLength(1),
      );
      // And it's really persisted, not just held in component state.
      expect(postCopilotAssistantMessage).toHaveBeenCalledWith(
        expect.any(String),
        'Your sprint is on track.',
        'sess-1',
      );
    });

    it('auto-titles the session from the first message sent (server-derived, refetched after send)', async () => {
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

    it('persists sent and received messages across a full panel remount (backend-persisted)', async () => {
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
      // opens back on the session list — reads from the same fake backend
      // store, not component state, proving persistence survived the
      // remount.
      render(<CopilotPanel onClose={jest.fn()} />);
      expect(await screen.findByText('remember this')).toBeInTheDocument();

      fireEvent.click(screen.getByText('remember this'));
      // The list endpoint never included messages — a fresh hook instance
      // has to lazily fetch them, so these are real async appearances now,
      // not synchronous ones.
      expect(
        await screen.findByText('remember this', { selector: 'p' }),
      ).toBeInTheDocument();
      expect(
        await screen.findByText('remembered reply', { selector: 'p' }),
      ).toBeInTheDocument();
    });

    it('shows a "Loading messages…" placeholder while a session\'s history is being fetched', async () => {
      const { unmount } = render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();
      await typeAndSend('will be fetched later');
      const handlers = await waitForRun('will be fetched later');
      await act(async () => {
        handlers.onDone({ fullText: 'a reply', sessionId: 'sess-1' });
      });
      // A fresh mount, not just navigating back within the same one — this
      // hook instance's messagesById cache starts empty, so opening the
      // session for the first time here genuinely has to fetch, rather than
      // short-circuiting on the cache the live session above already
      // populated (see useCopilotConversations.ts's openSession).
      unmount();
      render(<CopilotPanel onClose={jest.fn()} />);

      // Never resolves during this test — long enough to observe the
      // in-between loading state deterministically instead of racing it.
      jest
        .mocked(getCopilotConversation)
        .mockImplementationOnce(() => new Promise(() => {}));
      const row = await screen.findByText('will be fetched later');
      fireEvent.click(row);

      expect(await screen.findByText(/Loading messages/i)).toBeInTheDocument();
    });

    it('rolls back the optimistic user bubble when persisting the user message fails', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      jest
        .mocked(postCopilotUserMessage)
        .mockRejectedValueOnce(new Error('network error'));

      await act(async () => {
        await typeAndSend('this will fail to save');
      });

      await waitFor(() =>
        expect(
          screen.queryByText('this will fail to save', { selector: 'p' }),
        ).not.toBeInTheDocument(),
      );
      // The failed run never even started — a message that couldn't be
      // saved shouldn't be sent to Claude Code either.
      expect(copilotIpc.runPrompt).not.toHaveBeenCalled();
      // The composer's own "don't clear the draft on a failed send"
      // behavior still holds — it's the message bubble, not the input,
      // that gets rolled back.
      await waitFor(() =>
        expect(getTextarea().value).toBe('this will fail to save'),
      );
    });

    it('offers a save-only retry (not a re-run) when persisting a successful reply fails', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      jest
        .mocked(postCopilotAssistantMessage)
        .mockRejectedValueOnce(new Error('save failed'));

      await typeAndSend('hello');
      const handlers = await waitForRun('hello');
      await act(async () => {
        handlers.onDone({ fullText: 'a real reply', sessionId: 'sess-1' });
      });

      expect(await screen.findByText(/couldn't save it/i)).toBeInTheDocument();
      // The reply text itself isn't lost even though saving it failed.
      expect(
        screen.queryByText('a real reply', { selector: 'p' }),
      ).not.toBeInTheDocument();

      act(() => {
        fireEvent.click(screen.getByText('Try again'));
      });

      await waitFor(() =>
        expect(
          screen.getByText('a real reply', { selector: 'p' }),
        ).toBeInTheDocument(),
      );
      // Retrying the save must not spend a second real Claude Code turn.
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(1);
      expect(postCopilotAssistantMessage).toHaveBeenLastCalledWith(
        expect.any(String),
        'a real reply',
        'sess-1',
      );
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
      expect(screen.getByText('hello', { selector: 'p' })).toBeInTheDocument();
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
      expect(screen.getAllByText('hello', { selector: 'p' })).toHaveLength(1);
    });

    // An auth_failed error specifically gets a real recovery action, not
    // just inline text — this is the gap live testing found: the chat had
    // no visible path from "not logged in" to actually fixing it short of
    // already knowing to dig through Settings.
    it('shows a "Connect your Claude subscription" action for an auth_failed error, distinct from other error kinds', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

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
        screen.getByText('Second run reply', { selector: 'p' }),
      ).toBeInTheDocument();

      // The first run's process is still alive somewhere and emits a late
      // chunk — it must not touch the bubble the second run now owns.
      act(() => firstHandlers.onChunk('stale text from the dead run'));

      expect(
        screen.queryByText(/stale text from the dead run/),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('Second run reply', { selector: 'p' }),
      ).toBeInTheDocument();
    });

    // Regression test: the staleness guard above was originally a single
    // counter shared across every session (ported as-is from the
    // pre-multi-session version of this file, where only one session could
    // ever exist). Multi-session means a user can plausibly start a run in
    // one session, switch away, and start a second run in a different
    // session while the first is still in flight — with a shared counter,
    // starting the second run marked the first one stale, silently
    // discarding its real reply (and the subscription usage spent
    // generating it) the moment it finished, with no error shown anywhere.
    it('completes a run in one session even after a second run starts in a different session', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);

      await createAndOpenSession();
      await typeAndSend('first session message');
      // First message in the session — see the identical note above on
      // handleSend's own first-message reload().
      await act(async () => {});
      const handlersA = await waitForRun('first session message');

      fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
      await createAndOpenSession();
      await typeAndSend('second session message');
      await act(async () => {});
      const handlersB = await waitForRun('second session message');
      expect(copilotIpc.runPrompt).toHaveBeenCalledTimes(2);

      // Session A's run finishes for real, well after B's has already
      // started — this must not be treated as stale.
      await act(async () => {
        await handlersA.onDone({
          fullText: 'reply for session A',
          sessionId: 'claude-session-a',
        });
      });
      await act(async () => {
        await handlersB.onDone({
          fullText: 'reply for session B',
          sessionId: 'claude-session-b',
        });
      });

      // Reopening a session goes through handleOpenSession, which is async
      // even on a cache hit (openSession() still returns a resolved
      // promise one microtask later) — its finally-block state update lands
      // outside the act() scope the row's fireEvent.click establishes, same
      // as the first-message reload() case above. Flush before asserting.
      fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
      fireEvent.click(await screen.findByText('first session message'));
      await act(async () => {});
      expect(
        await screen.findByText('reply for session A', { selector: 'p' }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
      fireEvent.click(await screen.findByText('second session message'));
      await act(async () => {});
      expect(
        await screen.findByText('reply for session B', { selector: 'p' }),
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
      // No lingering typing indicator once the run has definitively failed.
      expect(document.querySelector('.copilot-typing')).not.toBeInTheDocument();
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

    it('shows a typing indicator before the first token arrives, replaced by the real text once streaming starts', async () => {
      render(<CopilotPanel onClose={jest.fn()} />);
      await screen.findByText(/No sessions yet/i);
      await createAndOpenSession();

      await typeAndSend('what next');
      const handlers = await waitForRun('what next');

      // No tokens yet — the indicator shows, not a bare "…" bubble.
      expect(document.querySelector('.copilot-typing')).toBeInTheDocument();

      act(() => handlers.onChunk('Here is '));

      // The first chunk replaces the indicator with the real streamed text.
      expect(document.querySelector('.copilot-typing')).not.toBeInTheDocument();
      expect(
        screen.getByText('Here is', { selector: 'p', exact: false }),
      ).toBeInTheDocument();
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
