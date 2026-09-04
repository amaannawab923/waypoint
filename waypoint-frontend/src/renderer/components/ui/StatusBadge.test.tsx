import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { Probe } from '@/types/probe';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders `unknown` without anything alarming', () => {
    const probe: Probe<string> = { state: 'unknown' };
    render(<StatusBadge probe={probe} />);

    expect(screen.getByText('Not checked')).toBeInTheDocument();
  });

  it('renders `checking` as in-progress', () => {
    const probe: Probe<string> = { state: 'checking' };
    render(<StatusBadge probe={probe} />);

    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('renders `present` only from a probe that actually carries a value and via', () => {
    const probe: Probe<{ version: string }> = {
      state: 'present',
      value: { version: '2.1.0' },
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };
    render(<StatusBadge probe={probe} />);

    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.getByTitle(/claude --version/)).toBeInTheDocument();
  });

  it('renders a clear failure state for `error`, distinct from `absent`', () => {
    const probe: Probe<string> = {
      state: 'error',
      reason: 'ECONNREFUSED',
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'GET /health',
    };
    render(<StatusBadge probe={probe} />);

    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByTitle(/ECONNREFUSED/)).toBeInTheDocument();
  });

  it('rejects a probe that is missing `via` on `present` at compile time', () => {
    // @ts-expect-error — `via` is required on `present`; StatusBadge cannot
    // be handed a "connected" claim with no evidence of what was read.
    const bad: Probe<string> = {
      state: 'present',
      value: 'x',
      observedAt: '2026-09-03T00:00:00.000Z',
    };
    render(<StatusBadge probe={bad} />);

    // The type error above is the real guarantee; this just confirms the
    // component still renders sensibly (by `state` alone) if that were ever
    // bypassed, rather than crashing on the missing `via`.
    expect(screen.getByText('Detected')).toBeInTheDocument();
  });
});
