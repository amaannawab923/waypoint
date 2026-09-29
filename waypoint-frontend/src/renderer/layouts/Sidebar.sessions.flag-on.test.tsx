import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  getWorkspace,
  listDraftTickets,
  listNotifications,
  listProjects,
  listReviewQueue,
} from '@/data/api';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import { useWaitingSessionsCount } from '@/lib/sessionsStore';
import { Sidebar } from './Sidebar';

// W3 (docs/design/w3-sessions-rail.md §1.1, carried over by ROAD-159): "My
// sessions" sits directly under My work with an alert badge of runs waiting
// on the user. Behind SESSIONS_ENABLED at the component boundary, so a
// flag-off build never mounts the store hook (Sidebar.review-badge.test.tsx
// and the other flag-off Sidebar tests cover that the entry is absent
// there).
jest.mock('@/lib/featureFlags', () => ({
  MY_JIRA_ENABLED: false,
  SESSIONS_ENABLED: true,
}));
jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(),
  listProjects: jest.fn(),
  listReviewQueue: jest.fn(),
  listNotifications: jest.fn(),
  listDraftTickets: jest.fn(),
  detectLocalClaudeCode: jest.fn(),
}));
jest.mock('@/lib/useLocalSummary', () => ({
  useLocalSummary: () => ({
    repoCount: 0,
    claudeReady: false,
    sentence: 'Local · 0 repos · Claude not detected',
  }),
}));
jest.mock('@/lib/jiraStore', () => ({ useLoadedJiraConnection: jest.fn() }));
jest.mock('@/lib/sessionsStore', () => ({
  useWaitingSessionsCount: jest.fn(),
}));
jest.mock('@/components/domain/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));
jest.mock('@/components/domain/AddProjectWizard', () => ({
  AddProjectWizard: () => null,
}));

function mount(pinned: boolean, onTogglePin: () => void = jest.fn()) {
  jest
    .mocked(getWorkspace)
    .mockResolvedValue({ id: 'ws-1', name: 'Waypoint Labs' } as never);
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(listReviewQueue).mockResolvedValue({
    proposals: [],
    counts: { proposed: 0, blocked: 0, recent: 0 },
    nextCursor: null,
  } as never);
  jest.mocked(listNotifications).mockResolvedValue([]);
  jest.mocked(listDraftTickets).mockResolvedValue([]);
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter>
      <Sidebar pinned={pinned} onTogglePin={onTogglePin} />
    </MemoryRouter>,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('Sidebar with My sessions on, pinned (panel)', () => {
  it('lists My sessions right under My work, linking to /sessions, with the waiting count as an alert badge', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(3);
    mount(true);
    await act(async () => {});
    const link = screen.getByRole('link', { name: /My sessions/ });
    expect(link).toHaveAttribute('href', '/sessions');
    expect(link).toHaveTextContent('3');
    const links = screen.getAllByRole('link').map((l) => l.textContent);
    const myWork = links.findIndex((t) => t?.startsWith('My work'));
    expect(links[myWork + 1]).toMatch(/^My sessions/);
  });

  it('shows no badge when nothing is waiting', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    mount(true);
    await act(async () => {});
    expect(screen.getByRole('link', { name: /My sessions/ })).toHaveTextContent(
      /^My sessions$/,
    );
  });

  // ROAD-159: the panel always carries a way back to the rail now — it's
  // not conditional on being inside some route-gated "focus workspace"
  // anymore, it's just what the pin control does.
  it('clicking the header collapse control calls onTogglePin', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    const onTogglePin = jest.fn();
    mount(true, onTogglePin);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar with My sessions on, unpinned (rail)', () => {
  it('renders My sessions as a rail icon with a floating badge and an aria-label carrying the waiting count', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(2);
    mount(false);
    await act(async () => {});
    const link = screen.getByLabelText('My sessions · 2 waiting on you');
    expect(link).toHaveAttribute('href', '/sessions');
    expect(link).toHaveTextContent('2');
  });

  // The rail carries the WHOLE nav, not a subset. Collapsing changes the
  // sidebar's width and nothing else — if an item is reachable pinned, it
  // is reachable unpinned. An earlier pass hid five destinations in the
  // rail, which quietly made them unreachable without expanding first and
  // broke the one rule this shell exists to keep.
  it('renders every destination in the rail, including the low-frequency ones', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    mount(false);
    await act(async () => {});
    for (const label of [
      'Home',
      'My work',
      'Notifications',
      'Drafts',
      'Scratchpad',
      'Review',
      'Archive',
      'Analytics',
      'Workspace settings',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  // The project tree folds to a hover flyout in the rail, and that flyout
  // reaches /views through a menuitem button rather than an <a href> — so
  // "reachable" has to mean link OR flyout item, not links alone. What must
  // not happen is a destination that exists pinned and has no route to it
  // unpinned; that is the regression this whole rule exists to prevent.
  it('leaves no pinned destination unreachable from the rail', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);

    const pinned = mount(true);
    await act(async () => {});
    const pinnedTop = [...pinned.container.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h): h is string => !!h && !h.startsWith('/projects/proj-'));
    pinned.unmount();

    const rail = mount(false);
    await act(async () => {});
    // Open the Projects flyout so its items count as reachable.
    fireEvent.mouseEnter(screen.getByLabelText('Projects').parentElement!);
    await act(async () => {});
    const railLinks = [...rail.container.querySelectorAll('a[href]')].map((a) =>
      a.getAttribute('href'),
    );
    const flyoutLabels = [...rail.container.querySelectorAll('[role="menuitem"]')].map(
      (b) => b.textContent ?? '',
    );

    for (const href of pinnedTop) {
      const asLink = railLinks.includes(href);
      // /views is the flyout's "All projects & tickets" footer.
      const viaFlyout =
        href === '/views' && flyoutLabels.some((l) => /All projects/.test(l));
      expect(asLink || viaFlyout).toBe(true);
    }
  });

  it('clicking the expand affordance calls onTogglePin', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    const onTogglePin = jest.fn();
    mount(false, onTogglePin);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText('Expand sidebar'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  // Review's group is made by the separators around it, not by a caption.
  // shell-ux-v3.md §3 deletes this label explicitly; it shipped anyway in
  // the same branch that wrote the doc.
  it('renders no "Agent output" caption above the single Review row', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    mount(true);
    await act(async () => {});
    expect(screen.queryByText(/agent output/i)).not.toBeInTheDocument();
  });

  it('exposes the pin control\'s state through aria-expanded in both widths', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);

    const panel = mount(true);
    await act(async () => {});
    const collapse = screen.getByLabelText('Collapse sidebar');
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse).toHaveAttribute('aria-controls');
    panel.unmount();

    mount(false);
    await act(async () => {});
    const expand = screen.getByLabelText('Expand sidebar');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveAttribute('aria-controls');
  });

  // AppShell mounts a SECOND Sidebar for the peek overlay while the rail's
  // own is still mounted. Both used to hardcode the same nav id — invalid
  // HTML, and it made every aria-controls resolve to whichever came first in
  // document order (the rail underneath), so the peek's own pin control
  // formally named a region it wasn't in. Shipped inside the very commit
  // that introduced aria-controls.
  it('lets a second mount carry its own nav id so aria-controls stays unambiguous', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    jest.mocked(getWorkspace).mockResolvedValue({
      id: 'ws-1',
      name: 'Waypoint Labs',
    } as never);
    jest.mocked(listProjects).mockResolvedValue([]);
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [],
      counts: { proposed: 0, blocked: 0, recent: 0 },
      nextCursor: null,
    } as never);
    jest.mocked(listNotifications).mockResolvedValue([]);
    jest.mocked(listDraftTickets).mockResolvedValue([]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);

    render(
      <MemoryRouter>
        <Sidebar pinned={false} onTogglePin={jest.fn()} />
        <div data-sidebar-peek>
          <Sidebar pinned navId="waypoint-sidebar-nav-peek" onTogglePin={jest.fn()} />
        </div>
      </MemoryRouter>,
    );
    await act(async () => {});

    const ids = [...document.querySelectorAll('[id^="waypoint-sidebar-nav"]')].map(
      (el) => el.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // Each pin control names the region it actually sits inside.
    for (const btn of document.querySelectorAll('[aria-controls]')) {
      const target = document.getElementById(btn.getAttribute('aria-controls')!);
      expect(target).not.toBeNull();
      expect(!!target!.closest('[data-sidebar-peek]')).toBe(
        !!btn.closest('[data-sidebar-peek]'),
      );
    }
  });

  // An earlier pass opened the peek on focus and called it keyboard parity.
  // It wasn't: the peek renders as a DOM sibling after this whole column, so
  // Tab from the affordance goes to the rail's own next icon and the panel
  // just flashes. The honest keyboard answer is the tooltip each rail icon
  // already carries — Tooltip opens on focus — plus ⌘B to commit.
  it('does not open the peek on focus, and names every rail icon for the keyboard', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    const onPeek = jest.fn();
    jest.mocked(getWorkspace).mockResolvedValue({
      id: 'ws-1',
      name: 'Waypoint Labs',
    } as never);
    jest.mocked(listProjects).mockResolvedValue([]);
    jest.mocked(listReviewQueue).mockResolvedValue({
      proposals: [],
      counts: { proposed: 0, blocked: 0, recent: 0 },
      nextCursor: null,
    } as never);
    jest.mocked(listNotifications).mockResolvedValue([]);
    jest.mocked(listDraftTickets).mockResolvedValue([]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);

    render(
      <MemoryRouter>
        <Sidebar pinned={false} onTogglePin={jest.fn()} onPeek={onPeek} />
      </MemoryRouter>,
    );
    await act(async () => {});

    fireEvent.focus(screen.getByLabelText('Expand sidebar'));
    expect(onPeek).not.toHaveBeenCalled();

    // What a keyboard user gets instead: every rail destination carries its
    // own accessible name, which Tooltip also surfaces visually on focus.
    for (const label of ['Home', 'My work', 'My sessions', 'Review', 'All tickets']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('routes the flyout footer to /projects, not to the destination its own neighbour owns', async () => {
    jest.mocked(useWaitingSessionsCount).mockReturnValue(0);
    mount(false);
    await act(async () => {});
    // "All tickets" has its own rail icon; the footer must not duplicate it.
    expect(screen.getByLabelText('All tickets')).toHaveAttribute('href', '/views');
    expect(screen.queryByText(/All projects & tickets/i)).not.toBeInTheDocument();
  });
});
