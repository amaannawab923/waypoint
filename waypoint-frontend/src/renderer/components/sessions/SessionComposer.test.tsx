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
  it('sends the trimmed text on Enter and clears; Shift+Enter and a composing Enter stay newlines', async () => {
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
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledWith('Run the tests');
    expect(box).toHaveValue('');
  });

  it('still sends on ⌘Enter and Ctrl+Enter', async () => {
    const onSend = jest.fn<Promise<void>, [string]>(async () => {});
    render(
      <SessionComposer
        onSend={onSend}
        sendBlockedReason={null}
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'one' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    });
    fireEvent.change(box, { target: { value: 'two' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    });
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
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

    // Found in review, round 4: the composer is mounted per run, so a
    // person who switched runs while a send was in flight had already
    // unmounted it by the time the send failed — the catch's setText was
    // dropped by React, the draft effect never ran, and the message was
    // simply gone, toast or no toast.
    it('a send that fails after the person has switched away still puts the text back in the run’s draft', async () => {
      let settle: (ok: boolean) => void = () => {};
      const onSend = jest.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = (ok) => (ok ? resolve() : reject(new Error('not sent')));
          }),
      );
      const { unmount } = render(
        <SessionComposer
          draftKey="run-c"
          onSend={onSend}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const box = screen.getByLabelText('Message this session');
      fireEvent.change(box, { target: { value: 'the message' } });
      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      });
      expect(readSessionDraft('run-c')).toBe('');
      unmount();
      await act(async () => {
        settle(false);
      });
      expect(readSessionDraft('run-c')).toBe('the message');
      clearSessionDraft('run-c');
    });

    // Round 5 of review: the fix above wrote the recovered text to storage
    // — but a person who switched away and BACK had a fresh composer for
    // the same run by then, typing, and its next debounced draft write
    // overwrote storage with its own text: the recovered message was gone
    // again. A recovery now goes to the mounted composer when there is
    // one, so it lands in the box, ahead of what was typed since.
    it('a send that fails after the person switched away and back lands in the new composer, ahead of what they typed since', async () => {
      let settle: (ok: boolean) => void = () => {};
      const onSend = jest.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = (ok) => (ok ? resolve() : reject(new Error('not sent')));
          }),
      );
      const first = render(
        <SessionComposer
          draftKey="run-d"
          onSend={onSend}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const box = screen.getByLabelText('Message this session');
      fireEvent.change(box, { target: { value: 'the message' } });
      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      });
      first.unmount();

      // Back to the same run: a fresh composer, typing.
      render(
        <SessionComposer
          draftKey="run-d"
          onSend={jest.fn(async () => {})}
          sendBlockedReason={null}
          attachedToBand={false}
        />,
      );
      const again = screen.getByLabelText('Message this session');
      fireEvent.change(again, { target: { value: 'hi' } });
      await act(async () => {
        settle(false);
      });
      expect(again).toHaveValue('the message\nhi');
      // And the next debounced write keeps it.
      act(() => {
        jest.advanceTimersByTime(DRAFT_WRITE_MS);
      });
      expect(readSessionDraft('run-d')).toBe('the message\nhi');
      clearSessionDraft('run-d');
    });
  });
});
