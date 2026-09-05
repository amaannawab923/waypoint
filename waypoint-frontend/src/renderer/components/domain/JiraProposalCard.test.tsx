import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { approveJiraProposal, rejectJiraProposal } from '@/data/jiraApi';
import type { JiraProposal } from '@/types/jira';
import { JiraProposalCard } from './JiraProposalCard';

jest.mock('@/data/jiraApi', () => ({
  approveJiraProposal: jest.fn(),
  rejectJiraProposal: jest.fn(),
}));

function proposal(overrides: Partial<JiraProposal> = {}): JiraProposal {
  return {
    id: 'jira-prop-eng-421',
    ticketId: 'jira-eng-421',
    ticketKey: 'ENG-421',
    ticketProjectColor: 'var(--p-eng)',
    status: 'proposed',
    fromStateName: 'In Progress',
    fromStateColor: 'var(--warning)',
    toStateName: 'In Review',
    toStateColor: 'var(--accent)',
    commentBody:
      'PR #418 adds a token-bucket limiter in webhookReceiver.ts (500/min, burst 50) and a regression test for the 501st event. Ready for review — @Priya Raman.',
    commentMentions: ['Priya Raman'],
    repoPath: '~/code/northwind',
    branch: 'fix/webhook-ratelimit',
    commitCount: 3,
    prNumber: 418,
    prStatus: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function renderCard(p: JiraProposal) {
  const onResolved = jest.fn();
  const utils = render(<JiraProposalCard proposal={p} onResolved={onResolved} />);
  return { onResolved, ...utils };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('JiraProposalCard', () => {
  it('renders the combined state-change and comment proposal, never bare ids', () => {
    renderCard(proposal());

    expect(screen.getByText('ENG-421')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('In Review')).toBeInTheDocument();
    expect(screen.getByText(/PR #418 adds a token-bucket limiter/)).toBeInTheDocument();
    expect(screen.queryByText('jira-prop-eng-421')).not.toBeInTheDocument();
    expect(screen.queryByText('jira-eng-421')).not.toBeInTheDocument();
  });

  it('shows live Approve/Reject buttons while pending', () => {
    renderCard(proposal());

    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(screen.getByText('Needs your approval')).toBeInTheDocument();
  });

  // Same focus-guard technique as CopilotProposalCard.tsx, for the same
  // reason: Approve/Reject going disabled (or this footer unmounting on a
  // resolved outcome) force-blurs the focused control to <body> unless
  // something stable claims focus first.
  it('has the focus-guard attributes on its root', () => {
    const { container } = renderCard(proposal());
    const root = container.firstElementChild as HTMLElement;

    expect(root).toHaveAttribute('tabindex', '-1');
    expect(root).toHaveAttribute('data-shortcut-guard');
  });

  // The card is stateless about outcomes — like CopilotProposalCard, it
  // calls onResolved and lets the caller feed the patched proposal back
  // through the `proposal` prop. Here `onResolved` is a bare jest.fn(), so
  // once the POST settles the SAME (still-"proposed") proposal re-renders —
  // proving `acting` correctly re-enables the buttons rather than leaving
  // them stuck disabled forever when nothing re-resolves the prop.
  it('disables both buttons while an approve POST is in flight, and re-enables them once it settles', async () => {
    let resolveApprove: (value: JiraProposal) => void = () => {};
    jest.mocked(approveJiraProposal).mockReturnValue(
      new Promise<JiraProposal>((resolve) => {
        resolveApprove = resolve;
      }),
    );
    renderCard(proposal());

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();

    resolveApprove(proposal({ status: 'executed', resolvedAt: '2026-01-01T01:00:00.000Z' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('approve calls approveJiraProposal with the id and reports the resolved proposal up', async () => {
    const executed = proposal({ status: 'executed', resolvedAt: '2026-01-01T01:00:00.000Z' });
    jest.mocked(approveJiraProposal).mockResolvedValue(executed);
    const { onResolved } = renderCard(proposal());

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(executed));
    expect(approveJiraProposal).toHaveBeenCalledWith('jira-prop-eng-421');
  });

  it('reject calls rejectJiraProposal with the id and reports the resolved proposal up', async () => {
    const rejected = proposal({ status: 'rejected', resolvedAt: '2026-01-01T01:00:00.000Z' });
    jest.mocked(rejectJiraProposal).mockResolvedValue(rejected);
    const { onResolved } = renderCard(proposal());

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(rejected));
    expect(rejectJiraProposal).toHaveBeenCalledWith('jira-prop-eng-421');
  });

  // Unmounted, not merely disabled — a disabled button could be re-enabled
  // by devtools; an absent one cannot re-execute anything (same invariant
  // as CopilotProposalCard.tsx's resolved state).
  it('an executed card shows the written-to-Jira note with buttons UNMOUNTED', () => {
    renderCard(proposal({ status: 'executed', resolvedAt: '2026-01-01T01:00:00.000Z' }));

    expect(screen.getByText('Written to Jira')).toBeInTheDocument();
    expect(screen.getByText(/moved to In Review and the comment posted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('a rejected card shows the dismissed note with no buttons at all', () => {
    renderCard(proposal({ status: 'rejected', resolvedAt: '2026-01-01T01:00:00.000Z' }));

    expect(screen.getByText(/Rejected — Copilot is told why on its next turn/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
