import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { listTicketAgentRuns } from '@/data/api';
import { getBriefPreview, onRunChanged } from '@/data/engineApi';
import type { AgentRun, BriefPreview } from '@/types/agentRuns';
import { TicketRunsSection } from './TicketRunsSection';

jest.mock('@/lib/featureFlags', () => ({ SESSIONS_ENABLED: true }));
jest.mock('@/data/api', () => ({
  listTicketAgentRuns: jest.fn(),
  getWorkspace: jest.fn(async () => ({ defaultAgentProvider: 'claude' })),
}));
jest.mock('@/data/engineApi', () => ({
  onRunChanged: jest.fn(),
  getBriefPreview: jest.fn(),
  dispatchRun: jest.fn(),
}));

const run = (
  id: string,
  status: AgentRun['status'],
  extra: Partial<AgentRun> = {},
): AgentRun =>
  ({
    id,
    status,
    entry: 'independent',
    providerId: 'claude',
    branch: `feat/${id}`,
    blockedReason: status === 'blocked' ? 'Wants to run pnpm test' : null,
    updatedAt: '2026-09-12T10:00:00Z',
    ...extra,
  }) as AgentRun;

const preview = (over: Partial<BriefPreview> = {}): BriefPreview => ({
  ticketId: 'wi-61',
  identifier: 'ROAD-61',
  title: 'Stop a run',
  intent: 'investigate',
  brief: 'You are working on ROAD-61…',
  repo: {
    handle: 'h1',
    path: '/Users/me/waypoint',
    displayPath: '~/waypoint',
    name: 'waypoint',
    kind: 'repo',
    projectId: 'proj-1',
    projectName: 'Roadmap',
    lastAutoApprove: null,
    lastUsedAt: null,
  },
  branches: { branches: ['main', 'feat/x'], suggested: 'main' },
  baseRef: 'main',
  branchHint: 'agent/ROAD-61',
  mode: 'plan',
  autoApproveDefault: false,
  seededFromRunId: null,
  liveWriterRunId: null,
  ...over,
});

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
  it('offers the three verbs even for a ticket with no runs, and no history', async () => {
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([]);
    renderSection();
    await flush();
    expect(listTicketAgentRuns).toHaveBeenCalledWith('wi-61');
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Investigate' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Something else…' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Open session →')).not.toBeInTheDocument();
  });

  it('lists the ticket’s runs with status, intent, branch and reason, re-reads when a run changes, and opens the session', async () => {
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([
      run('run-a', 'blocked'),
      run('run-b', 'needs-review', {
        entry: 'dispatched',
        intent: 'investigate',
        modeId: 'plan',
        autoApprove: false,
      }),
    ]);
    renderSection();
    await flush();
    expect(screen.getByText('Sessions (2)')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Wants to run pnpm test')).toBeInTheDocument();
    expect(screen.getByText('feat/run-b')).toBeInTheDocument();
    expect(screen.getByText('Proposals need your review')).toBeInTheDocument();
    const chip = document.querySelector('[data-intent-chip]');
    expect(chip).toHaveTextContent('Investigate');
    expect(chip).toHaveTextContent('plan');

    (listTicketAgentRuns as jest.Mock).mockResolvedValue([
      run('run-a', 'running'),
    ]);
    act(() => {
      changed?.({ runId: 'run-a', status: 'running' });
    });
    await flush();
    expect(screen.getByText('Sessions (1)')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Open session →'));
    expect(screen.getByText('panel')).toBeInTheDocument();
  });

  it('Investigate opens the brief preview for the ticket in plan mode', async () => {
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([]);
    (getBriefPreview as jest.Mock).mockResolvedValue(preview());
    renderSection();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    await flush();
    expect(getBriefPreview).toHaveBeenCalledWith({
      ticketId: 'wi-61',
      intent: 'investigate',
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('You are working on ROAD-61…'),
    ).toBeInTheDocument();
    expect(screen.getByText('~/waypoint')).toBeInTheDocument();
    expect(screen.getByText(/Plan — reads and reports/)).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Auto-approve' }),
    ).not.toBeInTheDocument();
  });

  it('Something else… needs text, then previews with the switch’s choice', async () => {
    (listTicketAgentRuns as jest.Mock).mockResolvedValue([]);
    (getBriefPreview as jest.Mock).mockResolvedValue(
      preview({ intent: 'custom', mode: 'write', autoApproveDefault: true }),
    );
    renderSection();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Something else…' }));
    const field = screen.getByLabelText('What the session should do');
    expect(
      screen.getByRole('button', { name: 'Preview brief…' }),
    ).toBeDisabled();
    expect(screen.getByText(/Reads only — plan mode/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'May change files' }));
    expect(
      screen.getByText(/May change files — a writing session/),
    ).toBeInTheDocument();
    fireEvent.change(field, {
      target: { value: '  List every IPC channel.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview brief…' }));
    await flush();
    expect(getBriefPreview).toHaveBeenCalledWith({
      ticketId: 'wi-61',
      intent: 'custom',
      instructions: 'List every IPC channel.',
      mayChangeFiles: true,
    });
    expect(screen.getByText(/Writing session/)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Auto-approve' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});
