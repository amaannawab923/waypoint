import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { listTicketAgentRuns } from '@/data/api';
import { onRunChanged } from '@/data/engineApi';
import type { AgentRun } from '@/types/agentRuns';
import { TicketRunsSection } from './TicketRunsSection';

jest.mock('@/lib/featureFlags', () => ({ SESSIONS_ENABLED: true }));
jest.mock('@/data/api', () => ({ listTicketAgentRuns: jest.fn() }));
jest.mock('@/data/engineApi', () => ({ onRunChanged: jest.fn() }));

const run = (id: string, status: AgentRun['status']): AgentRun =>
  ({
    id,
    status,
    providerId: 'claude',
    branch: `feat/${id}`,
    blockedReason: status === 'blocked' ? 'Wants to run pnpm test' : null,
    updatedAt: '2026-09-12T10:00:00Z',
  }) as AgentRun;

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

let changed: ((c: unknown) => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  changed = null;
  (onRunChanged as jest.Mock).mockImplementation((cb) => {
    changed = cb;
    return () => {
      changed = null;
    };
  });
});

function renderSection() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/tickets/ROAD-61']}>
      <Routes>
        <Route
          path="/projects/:p/tickets/:id"
          element={<TicketRunsSection ticketId="wi-61" />}
        />
        <Route path="/sessions/:runId" element={<div>panel</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TicketRunsSection', () => {
  it('shows nothing for a ticket with no runs', async () => {
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([]);
    const { container } = renderSection();
    await flush();
    expect(listTicketAgentRuns).toHaveBeenCalledWith('wi-61');
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the ticket’s runs with status, branch and reason, re-reads when a run changes, and opens the session', async () => {
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([
      run('run-a', 'blocked'),
      run('run-b', 'done'),
    ]);
    renderSection();
    await flush();
    expect(screen.getByText('Runs (2)')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Wants to run pnpm test')).toBeInTheDocument();
    expect(screen.getByText('feat/run-b')).toBeInTheDocument();

    (listTicketAgentRuns as jest.Mock).mockResolvedValue([
      run('run-a', 'running'),
    ]);
    // Braces: the callback returns load()'s promise, and a promise handed
    // to act() makes it asynchronous.
    act(() => {
      changed?.({ runId: 'run-a', status: 'running' });
    });
    await flush();
    expect(screen.getByText('Runs (1)')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Open session →'));
    expect(screen.getByText('panel')).toBeInTheDocument();
  });
});
