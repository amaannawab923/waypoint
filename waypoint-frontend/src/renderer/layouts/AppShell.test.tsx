import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useCopilotOpenState } from '@/lib/copilotOpenStore';
import { AppShell } from './AppShell';

// A stand-in for a ticket drawer reading the same store TicketDrawer.tsx/
// JiraTicketDrawer.tsx do (MY_JIRA_IMPROVEMENTS.md §5) — rendered as a
// sibling of <AppShell/> rather than nested inside it, the same way a real
// drawer can be mounted several route levels away from AppShell's own
// state.
function StoreProbe() {
  const open = useCopilotOpenState();
  return <span data-testid="store-copilot-open">{String(open)}</span>;
}

jest.mock('@/layouts/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
jest.mock('@/layouts/SidebarRail', () => ({
  RAIL_WIDTH_PX: 56,
  SidebarRail: () => <div data-testid="sidebar-rail" />,
}));
jest.mock('@/lib/useLocalSummary', () => ({
  useLocalSummary: () => ({
    repoCount: 0,
    claudeReady: false,
    sentence: 'Local · 0 repos · Claude not detected',
  }),
}));

const onToggleCopilotSpy = jest.fn();
jest.mock('@/layouts/Topbar', () => ({
  Topbar: ({
    copilotEnabled,
    copilotOpen,
    onToggleCopilot,
    onOpenShortcuts,
  }: {
    copilotEnabled: boolean;
    copilotOpen: boolean;
    onToggleCopilot: () => void;
    onOpenShortcuts: () => void;
  }) => {
    onToggleCopilotSpy(onToggleCopilot);
    return (
      <div data-testid="topbar">
        {copilotEnabled && (
          <button
            type="button"
            aria-pressed={copilotOpen}
            onClick={onToggleCopilot}
          >
            Toggle Copilot
          </button>
        )}
        <button type="button" onClick={onOpenShortcuts}>
          Open shortcuts
        </button>
      </div>
    );
  },
}));

const onCloseSpy = jest.fn();
jest.mock('@/components/domain/CopilotPanel', () => ({
  CopilotPanel: ({ onClose }: { onClose: () => void }) => {
    onCloseSpy(onClose);
    return (
      <div data-testid="copilot-panel">
        <button type="button" onClick={onClose}>
          Close from panel
        </button>
      </div>
    );
  },
}));

jest.mock('@/lib/featureFlags', () => ({
  COPILOT_ENABLED: true,
}));

function renderAppShell() {
  return render(
    <MemoryRouter>
      <AppShell />
      <StoreProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AppShell', () => {
  it('renders the sidebar and topbar, with the Copilot panel closed by default', () => {
    renderAppShell();

    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('topbar')).toBeInTheDocument();
    expect(screen.queryByTestId('copilot-panel')).not.toBeInTheDocument();
  });

  it('mounts the Copilot panel when the topbar toggle is clicked, and unmounts it on a second click', () => {
    renderAppShell();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
    expect(screen.getByTestId('copilot-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
    expect(screen.queryByTestId('copilot-panel')).not.toBeInTheDocument();
  });

  it("closes the panel via CopilotPanel's own onClose callback", () => {
    renderAppShell();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
    expect(screen.getByTestId('copilot-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close from panel'));
    expect(screen.queryByTestId('copilot-panel')).not.toBeInTheDocument();
  });

  // Regression test: toggleCopilot/closeCopilot used to be fresh arrow
  // functions on every AppShell render, which tore down and re-added
  // CopilotPanel's document-level Escape listener on every render for no
  // reason. useCallback([]) fixes that — verify identity is stable both
  // across an unrelated re-render and across an open/close cycle.
  describe('callback identity stability', () => {
    it('passes the same onToggleCopilot identity to Topbar across re-renders', () => {
      const { rerender } = renderAppShell();
      const first = onToggleCopilotSpy.mock.calls[0][0];

      rerender(
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>,
      );
      const second =
        onToggleCopilotSpy.mock.calls[
          onToggleCopilotSpy.mock.calls.length - 1
        ][0];

      expect(second).toBe(first);
    });

    it('passes the same onClose identity to CopilotPanel across the open state changing', () => {
      renderAppShell();

      fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
      const openedOnClose = onCloseSpy.mock.calls[0][0];

      fireEvent.click(screen.getByText('Close from panel'));
      fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
      const reopenedOnClose =
        onCloseSpy.mock.calls[onCloseSpy.mock.calls.length - 1][0];

      expect(reopenedOnClose).toBe(openedOnClose);
    });
  });

  // W5.4: the real (unmocked) KeyboardShortcutsModal + useGlobalKeyboardShortcuts
  // are mounted here — this is the integration point that proves `?`, the
  // topbar's discoverability button (Topbar.tsx's new "Keyboard shortcuts"
  // icon — mocked above as "Open shortcuts"), and Escape all drive the same
  // modal instance.
  describe('keyboard shortcuts modal (W5.4)', () => {
    it('is closed by default and opens on "?"', () => {
      renderAppShell();

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.keyDown(document, { key: '?' });

      expect(
        screen.getByRole('dialog', { name: 'Keyboard shortcuts' }),
      ).toBeInTheDocument();
    });

    it("opens via the topbar's discoverability button", () => {
      renderAppShell();

      fireEvent.click(screen.getByRole('button', { name: 'Open shortcuts' }));

      expect(
        screen.getByRole('dialog', { name: 'Keyboard shortcuts' }),
      ).toBeInTheDocument();
    });

    it("closes on Escape (Modal.tsx's own listener)", () => {
      renderAppShell();
      fireEvent.keyDown(document, { key: '?' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // MY_JIRA_IMPROVEMENTS.md §5: lib/copilotOpenStore.ts is how a ticket
  // drawer mounted several route levels away (sometimes under
  // ProjectLayout's own nested <Outlet> context, which would shadow
  // react-router's useOutletContext) learns whether Copilot is open, so it
  // can dock beside it instead of under it.
  describe('lib/copilotOpenStore.ts synchronization', () => {
    it('starts false, matching the panel closed by default', () => {
      renderAppShell();

      expect(screen.getByTestId('store-copilot-open')).toHaveTextContent(
        'false',
      );
    });

    it('flips true when the panel opens, and back on close', () => {
      renderAppShell();

      fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
      expect(screen.getByTestId('store-copilot-open')).toHaveTextContent(
        'true',
      );

      fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));
      expect(screen.getByTestId('store-copilot-open')).toHaveTextContent(
        'false',
      );
    });
  });
});
