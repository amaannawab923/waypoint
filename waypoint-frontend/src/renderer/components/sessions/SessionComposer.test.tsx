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
        disabledReason={null}
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
        disabledReason={null}
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

  it('is disabled with the reason as its placeholder', () => {
    render(
      <SessionComposer
        onSend={jest.fn()}
        disabledReason="This session has ended (done)."
        attachedToBand={false}
      />,
    );
    const box = screen.getByLabelText('Message this session');
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute(
      'placeholder',
      'This session has ended (done).',
    );
    expect(screen.getByLabelText('Send')).toBeDisabled();
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
          disabledReason={null}
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
          disabledReason={null}
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
