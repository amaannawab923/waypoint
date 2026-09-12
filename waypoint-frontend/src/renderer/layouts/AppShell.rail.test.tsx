import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppShell, isFocusWorkspace, readSidebarPinned } from './AppShell';

// W3's rail (docs/design/w3-sessions-rail.md §1.2–1.3): inside /sessions the
// sidebar folds to the icon rail; the expand affordance peeks the full
// sidebar on hover and pins it on click; ⌘B toggles the pin, which is
// remembered per device; leaving /sessions restores the full sidebar.
jest.mock('@/lib/featureFlags', () => ({
  COPILOT_ENABLED: false,
  MY_JIRA_ENABLED: false,
  SESSIONS_ENABLED: true,
}));
jest.mock('@/layouts/Sidebar', () => ({
  Sidebar: ({ onCollapse }: { onCollapse?: () => void }) => (
    <div data-testid="sidebar">
      {onCollapse && (
        <button type="button" onClick={onCollapse}>
          Collapse sidebar
        </button>
      )}
    </div>
  ),
}));
jest.mock('@/layouts/SidebarRail', () => ({
  SidebarRail: ({
    onPeek,
    onPeekEnd,
    onPin,
    localSummary,
  }: {
    onPeek: () => void;
    onPeekEnd: () => void;
    onPin: () => void;
    localSummary: string;
  }) => (
    <div data-testid="sidebar-rail" title={localSummary}>
      <button
        type="button"
        onMouseEnter={onPeek}
        onMouseLeave={onPeekEnd}
        onClick={onPin}
      >
        Expand sidebar
      </button>
    </div>
  ),
}));
jest.mock('@/lib/useLocalSummary', () => ({
  useLocalSummary: () => ({
    repoCount: 2,
    claudeReady: true,
    sentence: 'Local · 2 repos · Claude ready',
  }),
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
          <Route path="/sessions/:runId" element={<div>one session</div>} />
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

describe('isFocusWorkspace', () => {
  it('is the /sessions route family and nothing else', () => {
    expect(isFocusWorkspace('/sessions')).toBe(true);
    expect(isFocusWorkspace('/sessions/run-abc')).toBe(true);
    expect(isFocusWorkspace('/sessionsx')).toBe(false);
    expect(isFocusWorkspace('/')).toBe(false);
    expect(isFocusWorkspace('/review')).toBe(false);
  });
});

describe('AppShell inside My sessions', () => {
  it('shows the rail instead of the sidebar, and restores the sidebar on leaving', () => {
    renderAt('/sessions');
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar-rail')).toHaveAttribute(
      'title',
      'Local · 2 repos · Claude ready',
    );

    fireEvent.click(screen.getByText('go home'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();
    // Outside the workspace there is no rail to collapse to.
    expect(screen.queryByText('Collapse sidebar')).not.toBeInTheDocument();
  });

  it('everywhere else the sidebar is as it always was', () => {
    renderAt('/');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();
  });

  it('hovering the expand affordance peeks the full sidebar after a beat; leaving lets it linger, then it goes', () => {
    renderAt('/sessions');
    const affordance = screen.getByText('Expand sidebar');
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    // The real rail waits PEEK_DELAY_MS before onPeek (SidebarRail.test);
    // the mock forwards at once, so this is the shell's reaction to it.
    fireEvent.mouseEnter(affordance);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    // Still the rail's workspace: the rail did not go away.
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();

    fireEvent.mouseLeave(affordance);
    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
  });

  it('clicking the affordance pins the sidebar open, remembered per device; collapse and ⌘B toggle it back', () => {
    renderAt('/sessions');
    fireEvent.click(screen.getByText('Expand sidebar'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();
    expect(readSidebarPinned()).toBe(true);

    fireEvent.click(screen.getByText('Collapse sidebar'));
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(readSidebarPinned()).toBe(false);

    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(readSidebarPinned()).toBe(true);
    fireEvent.keyDown(window, { key: 'B', ctrlKey: true });
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
  });

  it('a pinned sidebar stays pinned on the next visit; ⌘B outside the workspace does nothing', () => {
    localStorage.setItem('waypoint:sidebarPinned', 'true');
    const sessions = renderAt('/sessions/run-abc');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByText('Collapse sidebar')).toBeInTheDocument();
    sessions.unmount();

    renderAt('/');
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(readSidebarPinned()).toBe(true);
  });
});
