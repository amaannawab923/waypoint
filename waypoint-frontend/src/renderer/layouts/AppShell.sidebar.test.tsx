import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppShell, readSidebarPinned } from './AppShell';

// ROAD-159 (docs/design/shell-ux-v3.md): the sidebar is always the same
// 56px rail; pinning it open is the only thing that ever widens it, and
// that pin is one global switch, never a per-route decision. This replaces
// AppShell.rail.test.tsx, which exercised the route-gated predecessor
// (isFocusWorkspace(), only /sessions ever showed the rail) — that
// mechanism no longer exists, so its tests are rewritten against the rule
// that replaced it rather than kept passing against a deleted concept.
jest.mock('@/lib/featureFlags', () => ({
  COPILOT_ENABLED: false,
  MY_JIRA_ENABLED: false,
  SESSIONS_ENABLED: true,
}));
jest.mock('@/layouts/Sidebar', () => ({
  RAIL_WIDTH_PX: 56,
  SIDEBAR_WIDTH_PX: 256,
  Sidebar: ({
    pinned,
    onPeek,
    onPeekEnd,
    onTogglePin,
  }: {
    pinned: boolean;
    onPeek?: () => void;
    onPeekEnd?: () => void;
    onTogglePin: () => void;
  }) => (
    <div data-testid={pinned ? 'sidebar-panel' : 'sidebar-rail'}>
      <button
        type="button"
        onMouseEnter={onPeek}
        onMouseLeave={onPeekEnd}
        onClick={onTogglePin}
      >
        {pinned ? 'Collapse sidebar' : 'Expand sidebar'}
      </button>
    </div>
  ),
}));
jest.mock('@/layouts/Topbar', () => ({
  Topbar: () => <div data-testid="topbar" />,
}));
jest.mock('@/components/domain/CopilotPanel', () => ({
  CopilotPanel: () => null,
}));
jest.mock('@/components/domain/KeyboardShortcutsModal', () => ({
  KeyboardShortcutsModal: () => null,
}));

function GoTo({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            path="/"
            element={
              <div>
                home <GoTo to="/sessions" label="go sessions" />
              </div>
            }
          />
          <Route
            path="/sessions"
            element={
              <div>
                sessions <GoTo to="/" label="go home" />
              </div>
            }
          />
          <Route
            path="/review"
            element={
              <div>
                review <GoTo to="/" label="go home from review" />
              </div>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('readSidebarPinned', () => {
  it('defaults to pinned (the panel) with no stored preference, matching every route before this rewrite', () => {
    expect(readSidebarPinned()).toBe(true);
  });

  it('honors an explicit stored preference either way', () => {
    localStorage.setItem('waypoint:sidebarPinned', 'false');
    expect(readSidebarPinned()).toBe(false);
    localStorage.setItem('waypoint:sidebarPinned', 'true');
    expect(readSidebarPinned()).toBe(true);
  });
});

describe('AppShell sidebar — one global pin, not a route decision', () => {
  it('renders the panel by default on any route, with no rail in sight', () => {
    renderAt('/');
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('go sessions'));
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();
  });

  it('clicking the collapse control unpins the sidebar and persists it', () => {
    renderAt('/');
    fireEvent.click(screen.getByText('Collapse sidebar'));
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(readSidebarPinned()).toBe(false);
  });

  it('⌘B toggles the pin from any route, not a route family', () => {
    renderAt('/review');
    // Registered on the shared app-shell keyboard layer
    // (useGlobalKeyboardShortcuts.ts), which listens on `document` — not a
    // bare `window` listener of AppShell's own.
    fireEvent.keyDown(document, { key: 'b', metaKey: true });
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(readSidebarPinned()).toBe(false);

    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();
    expect(readSidebarPinned()).toBe(true);
  });

  // The founder's acceptance test, stated literally in the ticket: collapse
  // the sidebar on one page, navigate to another, and it must still be
  // collapsed. The pin state and the route are completely independent.
  it('a collapsed sidebar stays collapsed across navigation to an unrelated route', () => {
    renderAt('/');
    fireEvent.click(screen.getByText('Collapse sidebar'));
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByText('go sessions'));
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('go home'));
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
  });

  it('a pinned sidebar likewise stays pinned across navigation', () => {
    renderAt('/sessions');
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByText('go home'));
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();
  });

  it('a stored preference survives an unmount/remount (per-device persistence)', () => {
    const first = renderAt('/');
    fireEvent.click(screen.getByText('Collapse sidebar'));
    expect(readSidebarPinned()).toBe(false);
    first.unmount();

    renderAt('/review');
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
  });

  it('hovering the expand affordance peeks the full sidebar after a beat; leaving lets it linger, then it goes', () => {
    localStorage.setItem('waypoint:sidebarPinned', 'false');
    renderAt('/');
    const affordance = screen.getByText('Expand sidebar');
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();

    // The real Sidebar's own expand affordance waits PEEK_DELAY_MS before
    // calling onPeek; the mock forwards at once, so this is the shell's own
    // reaction to that call, not a re-test of the delay itself.
    fireEvent.mouseEnter(affordance);
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();
    // Still unpinned: the main column is still the rail underneath the peek.
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();

    fireEvent.mouseLeave(affordance);
    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(screen.getByTestId('sidebar-panel')).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
  });
});
