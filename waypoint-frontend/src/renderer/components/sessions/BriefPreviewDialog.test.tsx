import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { dispatchRun, getBriefPreview } from '@/data/engineApi';
import type { BriefPreview } from '@/types/agentRuns';
import { BriefPreviewDialog } from './BriefPreviewDialog';

jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(async () => ({ defaultAgentProvider: 'claude' })),
}));
jest.mock('@/data/engineApi', () => ({
  getBriefPreview: jest.fn(),
  dispatchRun: jest.fn(),
}));
jest.mock('@/data/currentUser', () => ({ CURRENT_USER_ID: 'mem-1' }));

const preview = (over: Partial<BriefPreview> = {}): BriefPreview => ({
  ticketId: 'wi-61',
  identifier: 'ROAD-61',
  title: 'Stop a run',
  intent: 'fix',
  brief: 'The brief.',
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
  branches: { branches: ['main', 'release'], suggested: 'main' },
  baseRef: 'main',
  branchHint: 'agent/ROAD-61',
  mode: 'write',
  autoApproveDefault: true,
  seededFromRunId: 'run-inv00001',
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

function renderDialog(
  props: Partial<Parameters<typeof BriefPreviewDialog>[0]> = {},
) {
  const onClose = jest.fn();
  const utils = render(
    <MemoryRouter initialEntries={['/tickets']}>
      <Routes>
        <Route
          path="/tickets"
          element={
            <BriefPreviewDialog
              request={{ ticketId: 'wi-61', intent: 'fix' }}
              onClose={onClose}
              {...props}
            />
          }
        />
        <Route path="/sessions/:runId" element={<div>panel</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, onClose };
}

beforeEach(() => jest.clearAllMocks());

describe('BriefPreviewDialog', () => {
  it('Fix: the seeded brief, the facts, auto-approve on by default; Start dispatches the edited brief and opens the run', async () => {
    (getBriefPreview as jest.Mock).mockResolvedValue(preview());
    (dispatchRun as jest.Mock).mockResolvedValue({
      id: 'run-new0001',
      status: 'provisioning',
    });
    const { onClose } = renderDialog({ copilotConversationId: 'conv-1' });
    await flush();
    expect(screen.getByText('Fix · ROAD-61')).toBeInTheDocument();
    expect(
      screen.getByText(/Seeded with the approved root cause/),
    ).toBeInTheDocument();
    expect(screen.getByText('agent/ROAD-61')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Auto-approve' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByText(/credentials are kept from it/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/The brief/), {
      target: { value: 'The brief, edited.' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    await flush();
    expect(dispatchRun).toHaveBeenCalledWith({
      ticketId: 'wi-61',
      intent: 'fix',
      brief: 'The brief, edited.',
      mayChangeFiles: false,
      autoApprove: false,
      baseRef: 'main',
      ownerMemberId: 'mem-1',
      providerId: 'claude',
      copilotConversationId: 'conv-1',
    });
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByText('panel')).toBeInTheDocument();
  });

  it('changing the base branch rebuilds the brief for it', async () => {
    (getBriefPreview as jest.Mock)
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(
        preview({ baseRef: 'release', brief: 'The brief, from release.' }),
      );
    renderDialog();
    await flush();
    fireEvent.change(screen.getByLabelText('Base branch'), {
      target: { value: 'release' },
    });
    await flush();
    expect(getBriefPreview).toHaveBeenLastCalledWith({
      ticketId: 'wi-61',
      intent: 'fix',
      baseRef: 'release',
    });
    expect(
      screen.getByDisplayValue('The brief, from release.'),
    ).toBeInTheDocument();
  });

  it('a live writer on the ticket is said, Start refused, and the live run opened from the notice', async () => {
    (getBriefPreview as jest.Mock).mockResolvedValue(
      preview({ liveWriterRunId: 'run-fix00001' }),
    );
    renderDialog();
    await flush();
    expect(
      screen.getByText(/A writing session is already live on ROAD-61/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start session' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'open it' }));
    expect(screen.getByText('panel')).toBeInTheDocument();
  });

  it('a refusal from main is shown in the dialog', async () => {
    (getBriefPreview as jest.Mock).mockRejectedValue(
      new Error(
        'Roadmap has no linked repository, so there is nothing for a session to work in.',
      ),
    );
    renderDialog();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Roadmap has no linked repository',
    );
    expect(
      screen.getByRole('button', { name: 'Start session' }),
    ).toBeDisabled();
  });

  it('⌘⏎ starts; a dispatch error keeps the dialog open with the sentence', async () => {
    (getBriefPreview as jest.Mock).mockResolvedValue(preview());
    (dispatchRun as jest.Mock).mockRejectedValue(
      new Error('The agent engine is not running.'),
    );
    const { onClose } = renderDialog();
    await flush();
    fireEvent.keyDown(screen.getByLabelText(/The brief/), {
      key: 'Enter',
      metaKey: true,
    });
    await flush();
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The agent engine is not running.',
    );
  });
});
