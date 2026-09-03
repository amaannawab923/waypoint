import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Probe } from '@/types/probe';
import { ClaudeCodeStatus, type ClaudeCodeProbe } from './ClaudeCodeStatus';

function renderStatus(probe: ClaudeCodeProbe, showSetupLink?: boolean) {
  return render(
    <MemoryRouter>
      <ClaudeCodeStatus probe={probe} showSetupLink={showSetupLink} />
    </MemoryRouter>,
  );
}

describe('ClaudeCodeStatus', () => {
  it('labels the badge with the domain it is probing', () => {
    const probe: ClaudeCodeProbe = { state: 'checking' };
    renderStatus(probe);

    expect(screen.getByText('Claude Code CLI')).toBeInTheDocument();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('shows the real version, and only the real version, when present', () => {
    const probe: ClaudeCodeProbe = {
      state: 'present',
      value: { version: '1.4.0', path: '/opt/homebrew/bin/claude' },
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };
    renderStatus(probe);

    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.getByText('v1.4.0')).toBeInTheDocument();
  });

  it('links to the in-app setup flow when absent, by default', () => {
    const probe: ClaudeCodeProbe = {
      state: 'absent',
      reason: '"claude" was not found on PATH.',
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };
    renderStatus(probe);

    expect(screen.getByText('Not found')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Set up Claude Code' });
    expect(link).toHaveAttribute('href', '/profile/copilot');
  });

  it('suppresses the setup link when the call site is already the setup page', () => {
    const probe: ClaudeCodeProbe = {
      state: 'absent',
      reason: '"claude" was not found on PATH.',
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };
    renderStatus(probe, false);

    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Set up Claude Code' }),
    ).not.toBeInTheDocument();
  });

  it('never shows a version string for a probe that never carried one', () => {
    const absent: Probe<{ version: string; path: string }> = {
      state: 'absent',
      reason: 'not found',
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };
    renderStatus(absent);

    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });
});
