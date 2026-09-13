// Jest stand-in for src/renderer/components/chat/chatUiRuntime.ts (see its
// header): the real module imports the vendored 3.8 MB Solid build and its
// stylesheet, which jsdom can neither afford nor render. Tests get a
// runtime whose factories are jest.fn()s returning inert handles, and can
// reach the mocks through `getChatUiRuntime()` to assert on calls.
export const fakeView = {
  composerSlot: null as HTMLElement | null,
  setModel: jest.fn(),
  setContentPadding: jest.fn(),
  setCommands: jest.fn(),
  scrollToBottom: jest.fn(),
  dispose: jest.fn(),
};

const runtime = {
  connectSession: jest.fn(() => () => {}),
  createChatContext: jest.fn(() => ({ dispose: jest.fn() })),
  createChatState: jest.fn(() => ({
    transcript: {
      history: { seed: jest.fn(), append: jest.fn(), prepend: jest.fn() },
      activeTurn: { set: jest.fn() },
    },
    session: {
      setPermissions: jest.fn(),
      setPlan: jest.fn(),
      setPendingPrompt: jest.fn(),
      setTerminalOutput: jest.fn(),
    },
    dispose: jest.fn(),
  })),
  createChatView: jest.fn(
    (opts: { onViewMounted?: (v: typeof fakeView) => void }) => {
      opts.onViewMounted?.(fakeView);
      return fakeView;
    },
  ),
  createDefaultHighlighter: jest.fn(() => ({})),
  tailMode: jest.fn(() => ({ kind: 'tail' })),
  pinTopMode: jest.fn(() => ({ kind: 'pin-top' })),
};

export function getChatUiRuntime() {
  return runtime;
}
