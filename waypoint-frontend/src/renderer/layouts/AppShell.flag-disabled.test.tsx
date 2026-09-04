import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';

// A separate file (rather than jest.resetModules() inside a single test)
// because jest.resetModules() would load a second copy of the `react` module,
// and a dynamically re-required AppShell using that second copy while this
// file's own JSX still uses the first breaks hooks with "Invalid hook call".
// A statically mocked flag value, applied for this whole file, sidesteps
// that entirely.
jest.mock('@/lib/featureFlags', () => ({
  COPILOT_ENABLED: false,
}));

jest.mock('@/layouts/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

jest.mock('@/layouts/Topbar', () => ({
  Topbar: ({ onToggleCopilot }: { onToggleCopilot: () => void }) => (
    <div data-testid="topbar">
      <button type="button" onClick={onToggleCopilot}>
        Toggle Copilot
      </button>
    </div>
  ),
}));

jest.mock('@/components/domain/CopilotPanel', () => ({
  CopilotPanel: () => <div data-testid="copilot-panel" />,
}));

describe('AppShell with COPILOT_ENABLED=false', () => {
  it('never mounts the Copilot panel, even if the toggle is invoked', () => {
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Copilot' }));

    expect(screen.queryByTestId('copilot-panel')).not.toBeInTheDocument();
  });
});
