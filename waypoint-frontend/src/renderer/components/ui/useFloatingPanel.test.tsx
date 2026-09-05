import '@testing-library/jest-dom';
import { useRef, useState, type RefObject } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useFloatingPanel } from './useFloatingPanel';

// The hook exists because the floating-panel pattern had already been
// hand-copied once and the copy dropped a real fix. These tests pin the parts
// that were missing rather than the parts that happened to survive.

function Panel({
  triggerRef,
  onClose,
  empty,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  empty: boolean;
}) {
  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: 270,
    label: 'Move ENG-421 to',
  });

  return (
    <div
      ref={panelProps.ref}
      tabIndex={panelProps.tabIndex}
      role={panelProps.role}
      aria-label={panelProps['aria-label']}
      data-shortcut-guard={panelProps['data-shortcut-guard']}
      style={panelProps.style}
      onClick={panelProps.onClick}
    >
      {!empty && (
        <>
          <button type="button">In Progress</button>
          <button type="button">Done</button>
        </>
      )}
      {empty && <span>No transitions available from here.</span>}
    </div>
  );
}

/** The shape both real callers have: the parent owns the trigger and the open
 * state, and the panel is mounted only while open. */
function Harness({ empty = false }: { empty?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen((o) => !o)}>
        Open
      </button>
      <button type="button">Elsewhere</button>
      {open && (
        <Panel
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          empty={empty}
        />
      )}
    </div>
  );
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
}

describe('useFloatingPanel', () => {
  // Live-confirmed before this existed: opening the transition popover left
  // focus on the chip, and one Tab jumped straight past the open panel to the
  // next row's title. A keyboard-only user could not move a ticket at all.
  it('moves focus into the panel when it opens', () => {
    render(<Harness />);
    // A keyboard user tabs to the chip, then activates it. jsdom's synthetic
    // click doesn't focus on its own, so put focus where a real one would.
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    openPanel();

    expect(screen.getByRole('button', { name: 'In Progress' })).toHaveFocus();
  });

  it('focuses the panel itself when it holds nothing focusable', () => {
    render(<Harness empty />);

    openPanel();

    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('returns focus to the trigger when the panel closes', () => {
    render(<Harness />);
    openPanel();
    const option = screen.getByRole('button', { name: 'In Progress' });
    expect(option).toHaveFocus();

    fireEvent.keyDown(option, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  // The literal regression this extraction exists to prevent. An ancestor
  // drawer registers its own bubble-phase Escape listener on `document` that
  // closes the whole drawer; the hand-copied popover's plain bubble listener
  // meant one Escape press closed the picker AND the drawer behind it.
  // Asserting the panel closes is not enough — the spy standing in for that
  // drawer listener must never be reached at all.
  it('does not let Escape reach a document-level bubble listener', () => {
    const drawerEscapeListener = jest.fn();
    document.addEventListener('keydown', drawerEscapeListener);

    try {
      render(<Harness />);
      openPanel();
      const option = screen.getByRole('button', { name: 'In Progress' });

      // A control, so the spy is known to be wired up at all: an unrelated
      // key travels all the way to the document as normal.
      fireEvent.keyDown(option, { key: 'ArrowDown' });
      expect(drawerEscapeListener).toHaveBeenCalledTimes(1);
      drawerEscapeListener.mockClear();

      fireEvent.keyDown(option, { key: 'Escape' });

      expect(drawerEscapeListener).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      document.removeEventListener('keydown', drawerEscapeListener);
    }
  });

  // role="dialog", not "menu": the options are plain buttons reached by Tab,
  // not arrow-key roving-focus menu items.
  it('names the panel as a dialog and announces it on the trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(trigger).not.toHaveAttribute('aria-expanded');

    openPanel();

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'aria-label',
      'Move ENG-421 to',
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(trigger).not.toHaveAttribute('aria-expanded');
    expect(trigger).not.toHaveAttribute('aria-haspopup');
  });

  it('closes on a click outside, without dragging focus back to the trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    openPanel();
    expect(screen.getByRole('button', { name: 'In Progress' })).toHaveFocus();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Dismissing by clicking some other control is the user choosing where
    // focus goes; the hook must not yank it back on the way out.
    expect(screen.getByRole('button', { name: 'Open' })).not.toHaveFocus();
  });

  it('ignores a mousedown on the trigger, which owns its own toggle', () => {
    render(<Harness />);
    openPanel();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
