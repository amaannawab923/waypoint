import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { groupRuns, useMySessions } from '@/lib/sessionsStore';
import type { AgentRun } from '@/types/agentRuns';
import SessionsPage from './SessionsPage';

jest.mock('@/lib/sessionsStore', () => ({
  ...jest.requireActual('@/lib/sessionsStore'),
  useMySessions: jest.fn(),
}));
jest.mock('@/components/sessions/SessionDetail', () => ({
  SessionDetail: ({
    run,
    narrow,
    onBack,
  }: {
    run: AgentRun;
    narrow: boolean;
    onBack: () => void;
  }) => (
    <div data-testid="detail" data-narrow={String(narrow)}>
      detail {run.id}
      <button type="button" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));
jest.mock('@/lib/useTicketLabel', () => ({
  useTicketLabel: () => null,
  useTicketSummary: () => null,
}));

const run = (id: string, status: AgentRun['status']): AgentRun =>
  ({
    id,
    status,
    providerId: 'claude',
    entry: 'independent',
    ticketId: null,
    branch: `feat/${id}`,
    updatedAt: '2026-09-12T10:00:00Z',
  }) as AgentRun;

function mockSessions(
  runs: AgentRun[],
  over: Partial<ReturnType<typeof useMySessions>> = {},
) {
  (useMySessions as jest.Mock).mockReturnValue({
    runs,
    groups: groupRuns(runs),
    loaded: true,
    loading: false,
    error: null,
    engine: { kind: 'running', since: 1 },
    waitingCount: 0,
    refresh: jest.fn(),
    ...over,
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:runId" element={<SessionsPage />} />
        <Route path="/machine" element={<div>machine page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function setViewport(narrow: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  setViewport(false);
});

describe('SessionsPage', () => {
  it('with nothing selected: the list beside the "select a session" state, New session disabled with the W4 sentence', () => {
    mockSessions([run('run-a', 'running')]);
    renderAt('/sessions');
    expect(
      screen.getByRole('listbox', { name: 'Sessions' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Select a session, or start one'),
    ).toBeInTheDocument();
    // Two of them — the list header's "+" and the empty state's button —
    // both disabled until W4.
    const buttons = screen.getAllByRole('button', { name: /New session/ });
    expect(buttons).toHaveLength(2);
    expect(
      buttons.every((b) => b.getAttribute('aria-disabled') === 'true'),
    ).toBe(true);
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });

  it('with a run selected: list and detail side by side; an unknown id says so', () => {
    mockSessions([run('run-a', 'running')]);
    renderAt('/sessions/run-a');
    expect(
      screen.getByRole('listbox', { name: 'Sessions' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('detail')).toHaveTextContent('detail run-a');
    expect(screen.getByTestId('detail')).toHaveAttribute(
      'data-narrow',
      'false',
    );

    renderAt('/sessions/run-nope');
    expect(screen.getByText('No such session')).toBeInTheDocument();
  });

  it('tells the two empty states apart: the engine not running, and no sessions yet', () => {
    mockSessions([], {
      engine: { kind: 'stopped', installDir: '/x', version: '1' } as never,
    });
    const stopped = renderAt('/sessions');
    expect(
      screen.getByText('The agent engine is not running'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open This machine' }));
    expect(screen.getByText('machine page')).toBeInTheDocument();
    stopped.unmount();

    mockSessions([]);
    renderAt('/sessions');
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(
      screen.queryByText('The agent engine is not running'),
    ).not.toBeInTheDocument();
  });

  it('a failed read with nothing cached offers a retry', () => {
    const refresh = jest.fn();
    mockSessions([], { error: 'Network error: /agent-runs', refresh });
    renderAt('/sessions');
    expect(screen.getByText('Sessions could not be read')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('under 1100 px the list and the detail take turns, and Esc goes back to the list', () => {
    setViewport(true);
    mockSessions([run('run-a', 'running')]);
    renderAt('/sessions/run-a');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('detail')).toHaveAttribute('data-narrow', 'true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.getByRole('listbox', { name: 'Sessions' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });
});
