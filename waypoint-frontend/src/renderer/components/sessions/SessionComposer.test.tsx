import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SessionComposer } from './SessionComposer';

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
});
