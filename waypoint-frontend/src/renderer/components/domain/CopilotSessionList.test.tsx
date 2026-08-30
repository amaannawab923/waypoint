import '@testing-library/jest-dom';
import type { ComponentProps } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { CopilotSession } from '@/lib/copilotSessions';
import { CopilotSessionList } from './CopilotSessionList';

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function session(overrides: Partial<CopilotSession> = {}): CopilotSession {
  return {
    id: 's1',
    title: 'Sprint 14 planning',
    pinned: false,
    order: 0,
    claudeSessionId: null,
    createdAt: isoAgo(0),
    updatedAt: isoAgo(0),
    messages: [],
    ...overrides,
  };
}

function renderList(
  overrides: Partial<ComponentProps<typeof CopilotSessionList>> = {},
) {
  const onOpen = jest.fn();
  const onCreate = jest.fn();
  const onRename = jest.fn();
  const onTogglePin = jest.fn();
  const onDelete = jest.fn();
  const onReorder = jest.fn();

  // Merged as a plain object (not JSX prop spreading, which
  // react/jsx-props-no-spreading forbids) so a test can still override just
  // `sessions` without repeating every callback.
  const props: ComponentProps<typeof CopilotSessionList> = {
    sessions: [],
    onOpen,
    onCreate,
    onRename,
    onTogglePin,
    onDelete,
    onReorder,
    ...overrides,
  };

  render(
    <CopilotSessionList
      sessions={props.sessions}
      onOpen={props.onOpen}
      onCreate={props.onCreate}
      onRename={props.onRename}
      onTogglePin={props.onTogglePin}
      onDelete={props.onDelete}
      onReorder={props.onReorder}
    />,
  );

  return { onOpen, onCreate, onRename, onTogglePin, onDelete, onReorder };
}

afterEach(() => {
  cleanup();
});

describe('CopilotSessionList', () => {
  it('shows the empty state and the New session CTA when there are no sessions', () => {
    renderList({ sessions: [] });
    expect(screen.getByText(/No sessions yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New session' }),
    ).toBeInTheDocument();
  });

  it('calls onCreate from both the New session CTA', () => {
    const { onCreate } = renderList({ sessions: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('groups a pinned session under "Pinned" ahead of any recency bucket', () => {
    const pinned = session({ id: 'p', title: 'Pinned one', pinned: true });
    const today = session({ id: 't', title: 'Today one' });
    renderList({ sessions: [today, pinned] });

    const labels = screen.getAllByText(
      /Pinned|Today|Yesterday|Last 7 days|Older/,
    );
    expect(labels[0]).toHaveTextContent('Pinned');
  });

  it('buckets sessions into Today / Yesterday / Last 7 days / Older by updatedAt', () => {
    renderList({
      sessions: [
        session({ id: 'today', title: 'Today session', updatedAt: isoAgo(0) }),
        session({
          id: 'yesterday',
          title: 'Yesterday session',
          updatedAt: isoAgo(26 * 3600000),
        }),
        session({
          id: 'week',
          title: 'Week session',
          updatedAt: isoAgo(3 * 86400000),
        }),
        session({
          id: 'older',
          title: 'Older session',
          updatedAt: isoAgo(20 * 86400000),
        }),
      ],
    });

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
  });

  it('shows a message preview, or "No messages yet" for an empty session', () => {
    renderList({
      sessions: [
        session({
          id: 'a',
          title: 'Has messages',
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'hello there',
              createdAt: isoAgo(0),
            },
          ],
        }),
        session({ id: 'b', title: 'No messages' }),
      ],
    });

    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('opens a session when its row is clicked', () => {
    const { onOpen } = renderList({
      sessions: [session({ id: 's1', title: 'Click me' })],
    });
    fireEvent.click(screen.getByText('Click me'));
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('opens a session on Enter when the row has keyboard focus', () => {
    const { onOpen } = renderList({
      sessions: [session({ id: 's1', title: 'Keyboard row' })],
    });
    fireEvent.keyDown(screen.getByText('Keyboard row'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it("toggles pin from the row's pin button without opening the session", () => {
    const { onTogglePin, onOpen } = renderList({
      sessions: [session({ id: 's1', title: 'Pin me' })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onTogglePin).toHaveBeenCalledWith('s1');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows "Unpin" for an already-pinned session', () => {
    renderList({ sessions: [session({ id: 's1', pinned: true })] });
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeInTheDocument();
  });

  describe('the "⋯" options menu', () => {
    it('opens from the "More options" button and does not open the session', () => {
      const { onOpen } = renderList({
        sessions: [session({ id: 's1', title: 'Menu target' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(
        screen.getByRole('menuitem', { name: /Rename/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('menuitem', { name: /Pin to top/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('menuitem', { name: /Delete/i }),
      ).toBeInTheDocument();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('also opens via right-click anywhere on the row (a real contextmenu handler, not the browser default)', () => {
      renderList({
        sessions: [session({ id: 's1', title: 'Right click me' })],
      });
      fireEvent.contextMenu(screen.getByText('Right click me'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('shows "Unpin" in the menu for an already-pinned session', () => {
      renderList({ sessions: [session({ id: 's1', pinned: true })] });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      expect(
        screen.getByRole('menuitem', { name: /Unpin/i }),
      ).toBeInTheDocument();
    });

    it('closes when clicking outside the menu', () => {
      renderList({ sessions: [session({ id: 's1' })] });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes on Escape', () => {
      renderList({ sessions: [session({ id: 's1' })] });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('"Pin to top" in the menu calls onTogglePin and closes the menu', () => {
      const { onTogglePin } = renderList({ sessions: [session({ id: 's1' })] });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Pin to top/i }));
      expect(onTogglePin).toHaveBeenCalledWith('s1');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('rename', () => {
    it("turns the title into an inline input via the menu's Rename item", () => {
      renderList({
        sessions: [session({ id: 's1', title: 'Original title' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/i }));

      const input = screen.getByDisplayValue('Original title');
      expect(input).toBeInTheDocument();
    });

    it('commits the rename on Enter', () => {
      const { onRename } = renderList({
        sessions: [session({ id: 's1', title: 'Original title' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/i }));

      const input = screen.getByDisplayValue('Original title');
      fireEvent.change(input, { target: { value: 'Renamed title' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onRename).toHaveBeenCalledWith('s1', 'Renamed title');
      expect(
        screen.queryByDisplayValue('Renamed title'),
      ).not.toBeInTheDocument();
    });

    it('commits the rename on blur', () => {
      const { onRename } = renderList({
        sessions: [session({ id: 's1', title: 'Original title' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/i }));

      const input = screen.getByDisplayValue('Original title');
      fireEvent.change(input, { target: { value: 'Blurred title' } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith('s1', 'Blurred title');
    });

    it('cancels on Escape without calling onRename', () => {
      const { onRename } = renderList({
        sessions: [session({ id: 's1', title: 'Original title' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/i }));

      const input = screen.getByDisplayValue('Original title');
      fireEvent.change(input, { target: { value: 'Should not stick' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.getByText('Original title')).toBeInTheDocument();
    });

    it('clicking inside the rename input does not open the session', () => {
      const { onOpen } = renderList({
        sessions: [session({ id: 's1', title: 'Original title' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/i }));

      fireEvent.click(screen.getByDisplayValue('Original title'));
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it("shows an inline confirm row (not window.confirm) via the menu's Delete item", () => {
      const confirmSpy = jest.spyOn(window, 'confirm');
      renderList({
        sessions: [session({ id: 's1', title: 'Doomed session' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));

      expect(
        screen.getByText(/Delete .*Doomed session.*\?/),
      ).toBeInTheDocument();
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('Cancel dismisses the confirm row without calling onDelete', () => {
      const { onDelete } = renderList({
        sessions: [session({ id: 's1', title: 'Doomed session' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onDelete).not.toHaveBeenCalled();
      expect(screen.getByText('Doomed session')).toBeInTheDocument();
    });

    it("the confirm row's Delete button calls onDelete", () => {
      const { onDelete } = renderList({
        sessions: [session({ id: 's1', title: 'Doomed session' })],
      });
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));

      const confirmRow = screen
        .getByText(/Delete .*Doomed session.*\?/)
        .closest('div');
      fireEvent.click(
        within(confirmRow as HTMLElement).getByRole('button', {
          name: 'Delete',
        }),
      );

      expect(onDelete).toHaveBeenCalledWith('s1');
    });
  });

  describe('drag-to-reorder', () => {
    it('reorders within the same group on drop', () => {
      const { onReorder } = renderList({
        sessions: [
          session({ id: 'a', title: 'Row A', order: 0 }),
          session({ id: 'b', title: 'Row B', order: 1 }),
        ],
      });

      fireEvent.dragStart(screen.getByText('Row A'));
      fireEvent.dragOver(screen.getByText('Row B'));
      fireEvent.drop(screen.getByText('Row B'));

      expect(onReorder).toHaveBeenCalledWith('a', 'b', 'today');
    });

    it('does not call onReorder for a drag across different groups (pinned vs. unpinned)', () => {
      const { onReorder } = renderList({
        sessions: [
          session({ id: 'pinned-one', title: 'Pinned row', pinned: true }),
          session({ id: 'unpinned-one', title: 'Unpinned row' }),
        ],
      });

      fireEvent.dragStart(screen.getByText('Pinned row'));
      fireEvent.dragOver(screen.getByText('Unpinned row'));
      fireEvent.drop(screen.getByText('Unpinned row'));

      expect(onReorder).not.toHaveBeenCalled();
    });
  });
});
