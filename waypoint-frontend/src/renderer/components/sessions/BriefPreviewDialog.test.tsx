import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  chooseFolder,
  dispatchRun,
  getBriefPreview,
  listRecentFolders,
} from '@/data/engineApi';
import type { BriefPreview, SessionFolder } from '@/types/agentRuns';
import { BriefPreviewDialog } from './BriefPreviewDialog';

jest.mock('@/data/api', () => ({
  getWorkspace: jest.fn(async () => ({ defaultAgentProvider: 'claude' })),
}));
jest.mock('@/data/engineApi', () => ({
  getBriefPreview: jest.fn(),
  dispatchRun: jest.fn(),
  listRecentFolders: jest.fn(async () => []),
  chooseFolder: jest.fn(async () => ({ canceled: true })),
}));
// AT12 (ROAD-147): the dialog resolves its dispatch identity through
// activeIdentity.ts now, not the bare CURRENT_USER_ID constant — mocked
// the same way dispatchRun/getBriefPreview above are, matching what the
// dialog actually calls.
jest.mock('@/data/activeIdentity', () => ({
  getActiveMemberId: jest.fn(async () => 'mem-1'),
}));

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
  ticketSystem: 'waypoint',
  ticketUrl: null,
  jiraProjectKey: null,
  repoRemembered: false,
  baseRef: 'main',
  branchHint: 'agent/ROAD-61',
  mode: 'write',
  autoApproveDefault: true,
  seededFromRunId: 'run-inv00001',
  liveWriterRunId: null,
  ...over,
});

// W5b: a Jira issue's preview — the folder remembered for its project, or
// none yet.
const engRepo: SessionFolder = {
  handle: 'h-eng',
  path: '/Users/me/eng',
  displayPath: '~/eng',
  name: 'eng',
  kind: 'repo',
  projectId: null,
  projectName: null,
  lastAutoApprove: null,
  lastUsedAt: null,
};
const jiraPreview = (over: Partial<BriefPreview> = {}): BriefPreview =>
  preview({
    ticketId: 'tref-eng4',
    identifier: 'ENG-4',
    title: 'Checkout 500s',
    intent: 'investigate',
    mode: 'plan',
    autoApproveDefault: false,
    seededFromRunId: null,
    ticketSystem: 'jira',
    ticketUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
    jiraProjectKey: 'ENG',
    branchHint: 'agent/ENG-4',
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
    fireEvent.click(screen.getByRole('combobox', { name: 'Base branch' }));
    fireEvent.click(screen.getByRole('option', { name: /^release/ }));
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

  it('Verify in the browser: off by default, rebuilds the brief with the flag when switched on', async () => {
    (getBriefPreview as jest.Mock)
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(
        preview({ brief: 'The brief, with ## Verification.' }),
      );
    renderDialog();
    await flush();
    const verify = screen.getByRole('switch', {
      name: 'Verify in the browser',
    });
    expect(verify).toHaveAttribute('aria-checked', 'false');
    expect(getBriefPreview).toHaveBeenLastCalledWith({
      ticketId: 'wi-61',
      intent: 'fix',
    });
    fireEvent.click(verify);
    await flush();
    expect(getBriefPreview).toHaveBeenLastCalledWith({
      ticketId: 'wi-61',
      intent: 'fix',
      verifyInBrowser: true,
    });
    expect(
      screen.getByDisplayValue('The brief, with ## Verification.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/brings back screenshots/)).toBeInTheDocument();
  });

  it('a plan-mode session has no Verify switch — nothing to verify', async () => {
    (getBriefPreview as jest.Mock).mockResolvedValue(
      preview({
        intent: 'investigate',
        mode: 'plan',
        autoApproveDefault: false,
      }),
    );
    renderDialog({ request: { ticketId: 'wi-61', intent: 'investigate' } });
    await flush();
    expect(
      screen.queryByRole('switch', { name: 'Verify in the browser' }),
    ).not.toBeInTheDocument();
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

  // W5b (docs/design/w5b-jira-dispatch.md §1.2): a Jira issue with no
  // folder remembered for its project — the picker instead of a folder,
  // Start gated; a choice re-fires the preview with the handle, and Start
  // sends it so main remembers it.
  it('Jira, no folder yet: the picker, Start disabled; a pick rebuilds the brief and rides along on Start', async () => {
    (getBriefPreview as jest.Mock)
      .mockResolvedValueOnce(
        jiraPreview({
          repo: null,
          branches: { branches: [], suggested: null },
          baseRef: null,
          brief: 'The brief, no folder.',
        }),
      )
      .mockResolvedValueOnce(
        jiraPreview({ repo: engRepo, brief: 'The brief, on ~/eng.' }),
      );
    (listRecentFolders as jest.Mock).mockResolvedValue([
      engRepo,
      {
        ...engRepo,
        handle: 'h-plain',
        path: '/Users/me/notes',
        name: 'notes',
        kind: 'folder',
      },
    ]);
    (dispatchRun as jest.Mock).mockResolvedValue({
      id: 'run-new0001',
      status: 'provisioning',
    });
    renderDialog({ request: { ticketId: 'tref-eng4', intent: 'investigate' } });
    await flush();

    expect(screen.getByText('Investigate · ENG-4')).toBeInTheDocument();
    expect(screen.getByText('ENG-4 in Jira ↗')).toHaveAttribute(
      'href',
      'https://yourteam.atlassian.net/browse/ENG-4',
    );
    expect(
      screen.getByText(/Not set yet — choose the folder ENG's code lives in/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start session' }),
    ).toBeDisabled();
    await flush();
    // Only git repositories are offered: a session on a ticket takes a worktree.
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('eng');

    fireEvent.click(options[0]);
    await flush();
    expect(getBriefPreview).toHaveBeenLastCalledWith({
      ticketId: 'tref-eng4',
      intent: 'investigate',
      folder: 'h-eng',
    });
    expect(
      screen.getByDisplayValue('The brief, on ~/eng.'),
    ).toBeInTheDocument();
    expect(screen.getByText('~/eng')).toBeInTheDocument();
    expect(screen.getByText(/will be remembered for ENG/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    await flush();
    expect(dispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'tref-eng4',
        folder: 'h-eng',
        baseRef: 'main',
      }),
    );
  });

  it('Jira, a remembered folder: shown as remembered with Change; Browse… picks another', async () => {
    (getBriefPreview as jest.Mock)
      .mockResolvedValueOnce(
        jiraPreview({ repo: engRepo, repoRemembered: true }),
      )
      .mockResolvedValueOnce(
        jiraPreview({
          repo: {
            ...engRepo,
            handle: 'h-other',
            path: '/Users/me/other',
            displayPath: '~/other',
          },
        }),
      );
    (chooseFolder as jest.Mock).mockResolvedValue({
      canceled: false,
      folder: {
        ...engRepo,
        handle: 'h-other',
        path: '/Users/me/other',
        displayPath: '~/other',
      },
    });
    renderDialog({ request: { ticketId: 'tref-eng4', intent: 'investigate' } });
    await flush();
    expect(screen.getByText(/remembered for ENG/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await flush();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    await flush();
    expect(getBriefPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ folder: 'h-other' }),
    );
    expect(screen.getByText('~/other')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('a native ticket never shows the picker, the Issue row, or Change', async () => {
    (getBriefPreview as jest.Mock).mockResolvedValue(preview());
    renderDialog();
    await flush();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText(/in Jira/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change' }),
    ).not.toBeInTheDocument();
    expect(listRecentFolders).not.toHaveBeenCalled();
  });
});
