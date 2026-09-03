import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  renderHook,
  screen,
  render,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useGlobalKeyboardShortcuts } from './useGlobalKeyboardShortcuts';
import {
  registerActiveSelectableView,
  __resetActiveSelectableViewForTests,
} from './useActiveSelectableView';

// W5.4 — the app-shell-level keyboard layer's own coverage: the Escape
// cascade's priority order (tiers this hook actually owns: the shortcuts
// modal it renders, plus gating its clear/blur fallback around
// already-self-closing surfaces it does NOT own — the ticket drawer and a
// focus-inside Copilot panel), `g`-then-key navigation (a real mapped
// target, an unmapped second key, and the ~900ms pending window expiring),
// the typing-field guard on every new binding, and ⌘J/⌘A dispatch. Topbar's
// existing ⌘K and TicketList's/ReviewPage's own local j/k/x/e/r are
// deliberately out of scope here — this hook doesn't implement them.

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderShortcuts(
  opts: {
    copilotEnabled?: boolean;
    copilotOpen?: boolean;
    onToggleCopilot?: () => void;
  } = {},
  initialPath = '/',
) {
  const onToggleCopilot = opts.onToggleCopilot ?? jest.fn();
  const utils = renderHook(
    () =>
      useGlobalKeyboardShortcuts({
        copilotEnabled: opts.copilotEnabled ?? true,
        copilotOpen: opts.copilotOpen ?? false,
        onToggleCopilot,
      }),
    {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route
              path="/projects/:projectId/*"
              element={
                <>
                  {children}
                  <LocationProbe />
                </>
              }
            />
            <Route
              path="*"
              element={
                <>
                  {children}
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      ),
    },
  );
  return { ...utils, onToggleCopilot };
}

function currentPath(): string {
  return screen.getByTestId('location').textContent ?? '';
}

beforeEach(() => {
  __resetActiveSelectableViewForTests();
});

afterEach(() => {
  document
    .querySelectorAll('[data-ticket-drawer], [data-copilot-panel]')
    .forEach((el) => el.remove());
});

describe('useGlobalKeyboardShortcuts — typing-field guard', () => {
  it.each([
    ['⌘J', { key: 'j', metaKey: true }],
    ['⌘A', { key: 'a', metaKey: true }],
    ['g', { key: 'g' }],
    ['?', { key: '?' }],
  ])('ignores %s while focus is in a text field', (_label, keyInit) => {
    const onToggleCopilot = jest.fn();
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts({ onToggleCopilot });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, keyInit);

    expect(onToggleCopilot).not.toHaveBeenCalled();
    expect(view.selectAll).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  // Escape is the one binding that's NOT ignored while typing — it blurs
  // the field instead (see the fallback-tier test below for the blur
  // assertion).
  it('still runs the Escape cascade while typing', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(view.clear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);

    document.body.removeChild(input);
  });
});

describe('useGlobalKeyboardShortcuts — ⌘J toggles Copilot', () => {
  it('calls onToggleCopilot when enabled', () => {
    const onToggleCopilot = jest.fn();
    renderShortcuts({ onToggleCopilot, copilotEnabled: true });

    fireEvent.keyDown(document, { key: 'j', metaKey: true });

    expect(onToggleCopilot).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the Copilot feature is disabled', () => {
    const onToggleCopilot = jest.fn();
    renderShortcuts({ onToggleCopilot, copilotEnabled: false });

    fireEvent.keyDown(document, { key: 'j', metaKey: true });

    expect(onToggleCopilot).not.toHaveBeenCalled();
  });
});

describe('useGlobalKeyboardShortcuts — ⌘A dispatches to the active view', () => {
  it('calls selectAll on the registered view and prevents the default', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts();

    const notCancelled = fireEvent.keyDown(document, {
      key: 'a',
      metaKey: true,
    });

    expect(view.selectAll).toHaveBeenCalledTimes(1);
    // fireEvent's return value mirrors dispatchEvent(): false once
    // preventDefault() has been called on a cancelable event.
    expect(notCancelled).toBe(false);
  });

  it('does nothing (and does not prevent default) with no active view registered', () => {
    renderShortcuts();

    const notCancelled = fireEvent.keyDown(document, {
      key: 'a',
      metaKey: true,
    });

    expect(notCancelled).toBe(true);
  });
});

describe('useGlobalKeyboardShortcuts — g-then-key navigation', () => {
  it('navigates to a real mapped target', () => {
    renderShortcuts({}, '/review');
    expect(currentPath()).toBe('/review');

    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'h' });

    expect(currentPath()).toBe('/');
  });

  it.each([
    ['r', '/review'],
    ['m', '/your-work'],
    ['a', '/views'],
  ])('g then "%s" navigates to %s', (key, expected) => {
    renderShortcuts();
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key });
    expect(currentPath()).toBe(expected);
  });

  it('an unmapped second key silently cancels the pending g (no navigation)', () => {
    renderShortcuts({}, '/your-work');
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'z' });

    expect(currentPath()).toBe('/your-work');

    // And it doesn't leave `g` still "pending" for a later key either —
    // consuming (and clearing) the pending flag happens unconditionally,
    // whether or not the second key mapped to anything.
    fireEvent.keyDown(document, { key: 'h' });
    expect(currentPath()).toBe('/your-work');
  });

  it('"l" ("this machine") is intentionally unbound — no current-app equivalent', () => {
    renderShortcuts({}, '/your-work');
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'l' });

    expect(currentPath()).toBe('/your-work');
  });

  describe('project-scoped targets (t/d/s)', () => {
    it('"t" opens the open project\'s ticket list when a project is open', () => {
      renderShortcuts({}, '/projects/proj-1/docs');
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 't' });
      expect(currentPath()).toBe('/projects/proj-1/tickets');
    });

    it('"t" falls back to the workspace-wide All tickets view with no project open', () => {
      renderShortcuts({}, '/your-work');
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 't' });
      expect(currentPath()).toBe('/views');
    });

    it('"d" opens the open project\'s Docs tab when a project is open', () => {
      renderShortcuts({}, '/projects/proj-1/tickets');
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 'd' });
      expect(currentPath()).toBe('/projects/proj-1/docs');
    });

    it('"d" no-ops with no project open', () => {
      renderShortcuts({}, '/your-work');
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 'd' });
      expect(currentPath()).toBe('/your-work');
    });

    it('"s" opens the open project\'s Sprints tab when a project is open', () => {
      renderShortcuts({}, '/projects/proj-1/tickets');
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 's' });
      expect(currentPath()).toBe('/projects/proj-1/sprints');
    });

    it('"s" no-ops with no project open', () => {
      renderShortcuts({}, '/your-work');
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 's' });
      expect(currentPath()).toBe('/your-work');
    });
  });

  describe('the ~900ms pending window', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a second key within the window navigates', () => {
      renderShortcuts({}, '/review');
      fireEvent.keyDown(document, { key: 'g' });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      fireEvent.keyDown(document, { key: 'h' });
      expect(currentPath()).toBe('/');
    });

    it('a second key after the window expires does not navigate', () => {
      renderShortcuts({}, '/review');
      fireEvent.keyDown(document, { key: 'g' });
      act(() => {
        jest.advanceTimersByTime(901);
      });
      fireEvent.keyDown(document, { key: 'h' });
      expect(currentPath()).toBe('/review');
    });
  });
});

describe('useGlobalKeyboardShortcuts — "?" toggles the shortcuts modal', () => {
  it('flips shortcutsOpen on each press', () => {
    const { result } = renderShortcuts();
    expect(result.current.shortcutsOpen).toBe(false);

    fireEvent.keyDown(document, { key: '?' });
    expect(result.current.shortcutsOpen).toBe(true);

    fireEvent.keyDown(document, { key: '?' });
    expect(result.current.shortcutsOpen).toBe(false);
  });

  it('openShortcuts/closeShortcuts drive the same state', () => {
    const { result } = renderShortcuts();

    act(() => result.current.openShortcuts());
    expect(result.current.shortcutsOpen).toBe(true);

    act(() => result.current.closeShortcuts());
    expect(result.current.shortcutsOpen).toBe(false);
  });
});

describe('useGlobalKeyboardShortcuts — Escape cascade priority', () => {
  it('tier 1: does nothing else while the shortcuts modal is open (Modal.tsx owns closing it)', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    const { result } = renderShortcuts();

    act(() => result.current.openShortcuts());
    fireEvent.keyDown(document, { key: 'Escape' });

    // This hook doesn't close the modal itself (Modal.tsx's own Escape
    // listener does that) — it only needs to skip its OWN fallback here.
    expect(view.clear).not.toHaveBeenCalled();
  });

  it('tier 2: does nothing while a ticket drawer is present (TicketDrawer.tsx owns closing it)', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts();

    const marker = document.createElement('div');
    marker.setAttribute('data-ticket-drawer', '');
    document.body.appendChild(marker);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(view.clear).not.toHaveBeenCalled();
    document.body.removeChild(marker);
  });

  it('tier 3: does nothing while Copilot is open AND focus is inside it (CopilotPanel.tsx owns closing it)', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts({ copilotOpen: true });

    const panel = document.createElement('div');
    panel.setAttribute('data-copilot-panel', '');
    const field = document.createElement('textarea');
    panel.appendChild(field);
    document.body.appendChild(panel);
    field.focus();

    fireEvent.keyDown(field, { key: 'Escape' });

    expect(view.clear).not.toHaveBeenCalled();
    document.body.removeChild(panel);
  });

  it('tier 3 does NOT gate the fallback when Copilot is open but focus is elsewhere', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts({ copilotOpen: true });

    const panel = document.createElement('div');
    panel.setAttribute('data-copilot-panel', '');
    document.body.appendChild(panel);
    // Focus is on <body> (nothing inside the panel), unlike the previous test.

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(view.clear).toHaveBeenCalledTimes(1);
    document.body.removeChild(panel);
  });

  it('fallback: clears the active view and blurs a focused input when nothing higher-priority applies', () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    registerActiveSelectableView(view);
    renderShortcuts();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(view.clear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);
    document.body.removeChild(input);
  });

  it('fallback is a no-op (not a throw) with no active view registered', () => {
    renderShortcuts();
    expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow();
  });

  it('cancels a pending g on Escape, so a later key does not navigate', () => {
    renderShortcuts({}, '/review');
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'h' });

    expect(currentPath()).toBe('/review');
  });
});

// Sanity check that this hook's listener is torn down with the component
// that mounts it — same discipline TicketList's/ReviewPage's own local
// listeners are held to.
describe('useGlobalKeyboardShortcuts — cleanup', () => {
  it('stops listening once unmounted', () => {
    const onToggleCopilot = jest.fn();
    const { unmount } = renderShortcuts({ onToggleCopilot });

    unmount();

    expect(() =>
      fireEvent.keyDown(document, { key: 'j', metaKey: true }),
    ).not.toThrow();
    expect(onToggleCopilot).not.toHaveBeenCalled();
  });
});

// render() (not just renderHook()) once, to catch anything that only shows
// up in a full mount — kept minimal since AppShell.test.tsx covers the real
// integration (KeyboardShortcutsModal actually opening/closing).
describe('useGlobalKeyboardShortcuts — smoke', () => {
  it('mounts cleanly inside a full render tree', () => {
    function Harness() {
      useGlobalKeyboardShortcuts({
        copilotEnabled: true,
        copilotOpen: false,
        onToggleCopilot: jest.fn(),
      });
      return <div data-testid="harness" />;
    }
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('harness')).toBeInTheDocument();
  });
});
