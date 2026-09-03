import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';

jest.mock('@/layouts/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar" />,
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
});
