import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AcpPermissionRequest } from '@emdash/chat-ui';
import { PermissionBand } from './PermissionBand';

const request = (
  requestId: string,
  over: Partial<AcpPermissionRequest> = {},
): AcpPermissionRequest =>
  ({
    requestId,
    toolCall: {
      id: 't1',
      seq: 1,
      toolCallId: 'tc1',
      kind: 'execute-tool-call',
      title: 'Run tests',
      command: 'pnpm test session-list',
      status: 'pending',
    },
    options: [
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    ],
    ...over,
  }) as AcpPermissionRequest;

describe('PermissionBand', () => {
  it('renders nothing with no request', () => {
    const { container } = render(
      <PermissionBand requests={[]} onAnswer={jest.fn()} answering={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the command, makes the agent’s allow_once option the main action, and lists every option in the menu', () => {
    const onAnswer = jest.fn();
    render(
      <PermissionBand
        requests={[request('p1'), request('p2')]}
        onAnswer={onAnswer}
        answering={null}
      />,
    );
    expect(
      screen.getByRole('region', { name: 'Permission request' }),
    ).toHaveTextContent('pnpm test session-list');
    expect(screen.getByText('1 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onAnswer).toHaveBeenCalledWith('p1', 'allow');

    fireEvent.click(screen.getByLabelText('More options'));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Rejectreject_once',
      'Allow onceallow_once',
      'Always allowallow_always',
    ]);
    fireEvent.click(items[2]);
    expect(onAnswer).toHaveBeenLastCalledWith('p1', 'always');
  });

  it('falls back to the first option when the agent offered no allow_once, and disables while answering', () => {
    render(
      <PermissionBand
        requests={[
          request('p1', {
            options: [{ optionId: 'only', name: 'Proceed', kind: 'custom' }],
          }),
        ]}
        onAnswer={jest.fn()}
        answering="p1"
      />,
    );
    expect(screen.getByRole('button', { name: 'Answering…' })).toBeDisabled();
    expect(screen.queryByLabelText('More options')).not.toBeInTheDocument();
  });
});
