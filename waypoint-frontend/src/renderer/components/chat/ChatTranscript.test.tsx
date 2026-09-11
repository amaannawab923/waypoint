import { render } from '@testing-library/react';
import { ChatTranscript } from './ChatTranscript';
import { getChatUiRuntime } from './chatUiRuntime';
import { fakeView } from '../../../../.erb/mocks/chatUiRuntimeMock';

// chatUiRuntime is mapped to .erb/mocks/chatUiRuntimeMock.ts by jest
// (package.json moduleNameMapper), so these tests exercise the React
// adapter's contract with chat-ui — what it asks the runtime for, when —
// without loading the vendored Solid build.
const runtime = getChatUiRuntime() as unknown as {
  createChatView: jest.Mock;
};

const context = { dispose: jest.fn() } as never;
const stateA = { id: 'a' } as never;
const stateB = { id: 'b' } as never;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ChatTranscript', () => {
  it('creates one chat view into its container on mount and disposes it on unmount', () => {
    const { unmount, getByTestId } = render(
      <ChatTranscript context={context} state={stateA} composer="none" />,
    );

    expect(runtime.createChatView).toHaveBeenCalledTimes(1);
    const options = runtime.createChatView.mock.calls[0][0];
    expect(options.parent).toBe(getByTestId('chat-transcript'));
    expect(options.context).toBe(context);
    expect(options.state).toBe(stateA);
    expect(options.composer).toBe('none');
    expect(options.commands).toEqual({});
    expect(fakeView.dispose).not.toHaveBeenCalled();

    unmount();

    expect(fakeView.dispose).toHaveBeenCalledTimes(1);
  });

  it('hands the mounted view to onReady', () => {
    const onReady = jest.fn();

    render(
      <ChatTranscript context={context} state={stateA} onReady={onReady} />,
    );

    expect(onReady).toHaveBeenCalledWith(fakeView);
  });

  it('never remounts: a new state, padTop or commands is pushed through the view handle', () => {
    const commandsA = { onStop: jest.fn() } as never;
    const commandsB = { onStop: jest.fn() } as never;
    const { rerender } = render(
      <ChatTranscript
        context={context}
        state={stateA}
        padTop={0}
        commands={commandsA}
      />,
    );
    // The initial setModel call React's effect makes on mount is the same
    // state the view was created with; only the *change* matters here.
    const setModelCallsAtMount = fakeView.setModel.mock.calls.length;

    rerender(
      <ChatTranscript
        context={context}
        state={stateB}
        padTop={48}
        commands={commandsB}
      />,
    );

    expect(runtime.createChatView).toHaveBeenCalledTimes(1);
    expect(fakeView.setModel.mock.calls.length).toBe(setModelCallsAtMount + 1);
    expect(fakeView.setModel).toHaveBeenLastCalledWith(stateB);
    expect(fakeView.setContentPadding).toHaveBeenLastCalledWith({ top: 48 });
    expect(fakeView.setCommands).toHaveBeenLastCalledWith(commandsB);
  });

  it('reads the latest callbacks at call time, so an inline arrow passed on a later render is the one that runs', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(
      <ChatTranscript context={context} state={stateA} onReachStart={first} />,
    );
    rerender(
      <ChatTranscript context={context} state={stateA} onReachStart={second} />,
    );

    const options = runtime.createChatView.mock.calls[0][0];
    options.onReachStart();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
