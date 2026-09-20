import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  clearSessionDraft,
  DRAFT_PREFIX,
  DRAFT_WRITE_MS,
  readSessionDraft,
  SessionComposer,
} from './SessionComposer';

describe('SessionComposer', () => {
  it('sends the trimmed text on ⌘Enter and clears; plain Enter stays a newline', async () => {
    const onSend = jest.fn(async () => {});
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: '  Run the tests  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });
    expect(onSend).toHaveBeenCalledWith('Run the tests');
    expect(box).toHaveValue('');
  });

  it('keeps the text when sending fails, and never sends blank text', async () => {
    const onSend = jest.fn(async () => {
      throw new Error('no session');
    });
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box).toHaveValue('hello');
  });

  it('never disables the box: with Send held back (engine down) the text is still typed and kept, and only the button is off', () => {
    render(
      <SessionComposer
        draftKey="run-blocked"
        onSend={jest.fn()}
        sendBlockedReason="The agent engine is not running — your message is kept here until it is."
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    expect(box).not.toBeDisabled();
    expect(box).not.toHaveAttribute('readonly');
    expect(box).toHaveAttribute(
      'placeholder',
      'The agent engine is not running — your message is kept here until it is.',
    );
    fireEvent.change(box, { target: { value: 'while you were out' } });
    expect(box).toHaveValue('while you were out');
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });

  it('is never rendered disabled under any prop combination (never-lock)', () => {
    [null, 'engine down'].forEach((sendBlockedReason) => {
      [false, true].forEach((attachedToBand) => {
        const { unmount } = render(
          <SessionComposer
            onSend={jest.fn()}
            sendBlockedReason={sendBlockedReason}
            attachedToBand={attachedToBand}
            placeholder="anything"
          />,
        );
        expect(
          screen.getByLabelText('Message this session'),
        ).not.toBeDisabled();
        unmount();
      });
    });
  });

  it('empties the box the moment a send starts, and puts the text back — ahead of anything typed since — when it did not land', async () => {
    let settle: (ok: boolean) => void = () => {};
    const onSend = jest.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = (ok) => (ok ? resolve() : reject(new Error('not sent')));
        }),
    );
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'first' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });
    expect(box).toHaveValue('');
    expect(box).not.toBeDisabled();
    fireEvent.change(box, { target: { value: 'second' } });
    await act(async () => {
      settle(false);
    });
    expect(box).toHaveValue('first\nsecond');
  });

  describe('draft per run (W4, ROAD-68)', () => {
    beforeEach(() => {
      window.localStorage.clear();
      jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    it('restores the run’s draft on mount, writes it after a pause, and drops it on send', async () => {
      window.localStorage.setItem(`${DRAFT_PREFIX}run-a`, 'half a thought');
      const onSend = jest.fn(async () => {});
      render(
        <SessionComposer
          draftKey="run-a"
          onSend={onSend}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const box = screen.getByLabelText('Message this session');
      expect(box).toHaveValue('half a thought');

      fireEvent.change(box, { target: { value: 'half a thought, finished' } });
      expect(readSessionDraft('run-a')).toBe('half a thought');
      act(() => {
        jest.advanceTimersByTime(DRAFT_WRITE_MS);
      });
      expect(readSessionDraft('run-a')).toBe('half a thought, finished');

      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      });
      expect(onSend).toHaveBeenCalledWith('half a thought, finished');
      expect(readSessionDraft('run-a')).toBe('');
    });

    it('flushes the draft when unmounted mid-pause, and one run’s draft is not another’s', () => {
      const { unmount } = render(
        <SessionComposer
          draftKey="run-b"
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      fireEvent.change(screen.getByLabelText('Message this session'), {
        target: { value: 'switching away' },
      });
      unmount();
      expect(readSessionDraft('run-b')).toBe('switching away');
      expect(readSessionDraft('run-a')).toBe('');
      clearSessionDraft('run-b');
      expect(readSessionDraft('run-b')).toBe('');
    });
  });
});
