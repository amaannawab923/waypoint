import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProposalView } from '@/types/entities';
import { CopilotProposalCard } from './CopilotProposalCard';

const DISCLOSURE =
  'Hi, this is Copilot — Amaan’s agent — commenting on their behalf: ';

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-abc1234',
    conversationId: 'conv-abc1234',
    kind: 'state_change',
    ticketId: 'wi-1',
    payload: { stateId: 'st-done' },
    snapshot: {
      identifier: 'LAUNCH-3',
      title: 'Responsive nav breaks on iPad landscape',
      fromStateId: 'st-progress',
      fromStateName: 'In Progress',
      fromStateColor: '#f2c94c',
      toStateName: 'Done',
      toStateColor: '#157a3d',
    },
    anchorSeq: 3,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: DISCLOSURE,
    expiresAt: '2026-01-02T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'copilot',
    projectId: 'proj-1',
    agentId: null,
    agentRunId: null,
    sourceRequestId: null,
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...overrides,
  };
}

function renderCard(p: ProposalView, agentName?: string) {
  const onApprove = jest.fn().mockResolvedValue(undefined);
  const onReject = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <CopilotProposalCard
      proposal={p}
      onApprove={onApprove}
      onReject={onReject}
      agentName={agentName}
    />,
  );
  return { onApprove, onReject, ...utils };
}

describe('CopilotProposalCard', () => {
  it('renders state names and snapshot colors, never bare ids', () => {
    renderCard(proposal());

    expect(screen.getByText('LAUNCH-3')).toBeInTheDocument();
    expect(
      screen.getByText('Responsive nav breaks on iPad landscape'),
    ).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    // Ids from the payload/snapshot must never leak into the card.
    expect(screen.queryByText(/st-done|st-progress/)).not.toBeInTheDocument();
  });

  it('shows the single-execution microcopy and live Approve/Reject buttons while pending', () => {
    renderCard(proposal());

    expect(
      screen.getByText(/Executes once on approve · expires in 24h/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
  });

  it('disables both buttons while an approve POST is in flight', async () => {
    let resolveApprove: () => void = () => {};
    const onApprove = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApprove = resolve;
        }),
    );
    render(
      <CopilotProposalCard
        proposal={proposal()}
        onApprove={onApprove}
        onReject={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    resolveApprove();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );
  });

  it('an executed card shows Applied ✓ with the buttons UNMOUNTED, not merely disabled', () => {
    renderCard(
      proposal({ status: 'executed', resolvedAt: '2026-01-01T01:00:00.000Z' }),
    );

    expect(screen.getByText('Applied ✓')).toBeInTheDocument();
    // Unmounted is the invariant: a disabled button could be re-enabled by
    // CSS/devtools; an absent one cannot re-execute anything.
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Reject' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Applied — moved to Done/)).toBeInTheDocument();
  });

  it('a stale card shows the warning banner with statusReason and offers Dismiss only', () => {
    const { onReject } = renderCard(
      proposal({
        status: 'stale',
        statusReason:
          'This ticket changed since Copilot proposed this — ask again',
      }),
    );

    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This ticket changed since Copilot proposed this — ask again',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismiss);
    expect(onReject).toHaveBeenCalledWith('prop-abc1234');
  });

  it('re-renders straight into the stale banner when an approve comes back stale', () => {
    // The card is stateless about outcomes — approve() patches the list and
    // the SAME card re-renders from the stale row; nothing is optimistic.
    const { rerender } = render(
      <CopilotProposalCard
        proposal={proposal()}
        onApprove={jest.fn().mockResolvedValue(undefined)}
        onReject={jest.fn().mockResolvedValue(undefined)}
      />,
    );
    rerender(
      <CopilotProposalCard
        proposal={proposal({
          status: 'stale',
          statusReason: 'This ticket is no longer available',
        })}
        onApprove={jest.fn().mockResolvedValue(undefined)}
        onReject={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(
      screen.getByText('This ticket is no longer available'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('rejected and superseded cards read as Dismissed with no buttons', () => {
    renderCard(proposal({ status: 'rejected' }));
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('comment preview shows the server disclosure plus the Posted as you pill', () => {
    renderCard(
      proposal({
        kind: 'comment',
        payload: { body: 'Fixed by removing the breakpoint override.' },
        snapshot: {
          identifier: 'LAUNCH-3',
          title: 'Responsive nav breaks on iPad landscape',
        },
      }),
    );

    // getByText normalizes whitespace, so match the trimmed disclosure —
    // the trailing space lives in the string but not the rendered match.
    expect(screen.getByText(DISCLOSURE.trim())).toBeInTheDocument();
    expect(
      screen.getByText(/Fixed by removing the breakpoint override\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Posted as you')).toBeInTheDocument();
  });

  it('renders a hostile comment body as literal text — no HTML injection path exists', () => {
    const { container } = renderCard(
      proposal({
        kind: 'comment',
        payload: { body: '<img src=x onerror="window.pwned=1"> hello' },
        snapshot: { identifier: 'LAUNCH-3', title: 'T' },
      }),
    );

    // The literal characters render as text (React text nodes)…
    expect(
      screen.getByText(/<img src=x onerror="window\.pwned=1"> hello/),
    ).toBeInTheDocument();
    // …and no actual <img> element ever enters the DOM.
    expect(container.querySelector('img')).toBeNull();
  });

  it('assignee card says "currently unassigned" only when the ticket truly has no assignees', () => {
    renderCard(
      proposal({
        kind: 'assignee_change',
        payload: { assigneeId: 'mem-2', action: 'add' },
        snapshot: {
          identifier: 'LAUNCH-5',
          title: 'Empty-state copy for the board view',
          assigneeName: 'Priya Sharma',
          wasAssigned: false,
          currentAssigneeNames: [],
        },
      }),
    );

    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('· currently unassigned')).toBeInTheDocument();
    expect(screen.queryByText(/mem-2/)).not.toBeInTheDocument();
  });

  // Regression test (QA finding): "Assign Priya" on a ticket Lena already
  // holds previously showed "· currently unassigned" — the old copy
  // reflected only the PROPOSED person's own assignment status, but read as
  // a statement about the whole ticket, misleading exactly the person
  // deciding whether to approve.
  it("assignee card shows the ticket's actual current assignees as context", () => {
    renderCard(
      proposal({
        kind: 'assignee_change',
        payload: { assigneeId: 'mem-2', action: 'add' },
        snapshot: {
          identifier: 'LAUNCH-6',
          title: 'Board drag-and-drop jitter',
          assigneeName: 'Priya Sharma',
          wasAssigned: false,
          currentAssigneeNames: ['Lena Park'],
        },
      }),
    );

    expect(screen.getByText('· currently: Lena Park')).toBeInTheDocument();
    expect(
      screen.queryByText('· currently unassigned'),
    ).not.toBeInTheDocument();
  });

  it('assignee card omits the context line entirely for a pre-upgrade proposal without the field', () => {
    renderCard(
      proposal({
        kind: 'assignee_change',
        payload: { assigneeId: 'mem-2', action: 'add' },
        snapshot: {
          identifier: 'LAUNCH-5',
          title: 'Empty-state copy for the board view',
          assigneeName: 'Priya Sharma',
          wasAssigned: false,
        },
      }),
    );

    expect(screen.queryByText(/currently/)).not.toBeInTheDocument();
  });

  it('create card renders the full draft preview from the snapshot', () => {
    renderCard(
      proposal({
        kind: 'create_ticket',
        ticketId: null,
        payload: {
          projectId: 'proj-1',
          title: 'Crash reporting for the tray process',
          description: 'Wire up the reporter.',
          stateId: 'st-backlog',
          priority: 'high',
          dueDate: '2026-02-01',
        },
        snapshot: {
          projectName: 'Launch',
          projectIdentifier: 'LAUNCH',
          stateName: 'Backlog',
          stateColor: '#9c9280',
          assigneeNames: ['Priya Sharma'],
        },
      }),
    );

    expect(screen.getByText('LAUNCH')).toBeInTheDocument();
    expect(screen.getByText('New ticket in Launch')).toBeInTheDocument();
    expect(
      screen.getByText('Crash reporting for the tray process'),
    ).toBeInTheDocument();
    expect(screen.getByText('Wire up the reporter.')).toBeInTheDocument();
    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Due 2026-02-01')).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
  });

  // W4.2 (architecture §4.2) — 'add_label' has no real producer yet; this
  // proves the card renders it defensively from the schema-implied shape
  // (a label id in the payload, name/color in the snapshot) rather than
  // crashing on an unhandled kind.
  it('add_label card renders the label chip from the snapshot, never the bare id', () => {
    renderCard(
      proposal({
        kind: 'add_label',
        payload: { labelId: 'lbl-9' },
        snapshot: {
          identifier: 'LAUNCH-7',
          title: 'Flaky upload retry',
          labelName: 'needs-triage',
          labelColor: '#9b51e0',
        },
      }),
    );

    expect(screen.getByText('Proposed change · Label')).toBeInTheDocument();
    expect(screen.getByText('Add label:')).toBeInTheDocument();
    expect(screen.getByText('needs-triage')).toBeInTheDocument();
    expect(screen.queryByText(/lbl-9/)).not.toBeInTheDocument();
  });

  it('an executed add_label card reports the label that was added', () => {
    renderCard(
      proposal({
        kind: 'add_label',
        status: 'executed',
        resolvedAt: '2026-01-01T01:00:00.000Z',
        payload: { labelId: 'lbl-9' },
        snapshot: {
          identifier: 'LAUNCH-7',
          title: 'Flaky upload retry',
          labelName: 'needs-triage',
        },
      }),
    );

    expect(
      screen.getByText(/Applied — needs-triage added/),
    ).toBeInTheDocument();
  });

  // W4.2 (architecture §1.8) — the same card must render correctly for a
  // proposal that came from an autonomous agent run, not just a Copilot
  // conversation turn. The comment kind is the one branch that used to
  // assume Copilot-conversation origin (parsing the poster's name out of
  // server-computed disclosure text); for origin === 'agent_run' it must
  // credit the agent instead, via the caller-supplied `agentName` prop.
  it('an agent_run-origin comment card credits the agent, not "you"', () => {
    renderCard(
      proposal({
        kind: 'comment',
        origin: 'agent_run',
        agentId: 'agent-1',
        agentRunId: 'run-1',
        payload: { body: 'Reproduced on staging; filing details below.' },
        snapshot: {
          identifier: 'LAUNCH-3',
          title: 'Responsive nav breaks on iPad landscape',
        },
      }),
      'Triage Bot',
    );

    expect(screen.getByText(/Proposed by Triage Bot/)).toBeInTheDocument();
    expect(screen.queryByText('Posted as you')).not.toBeInTheDocument();
  });

  it('an agent_run-origin card without an agentName prop falls back to the agent id, not "You"', () => {
    renderCard(
      proposal({
        kind: 'comment',
        origin: 'agent_run',
        agentId: 'agent-1',
        payload: { body: 'hi' },
        snapshot: { identifier: 'LAUNCH-3', title: 'T' },
      }),
    );

    expect(screen.getByText(/Proposed by agent-1/)).toBeInTheDocument();
  });

  it('a copilot-origin comment card keeps the exact prior "Posted as you" behavior unaffected by the agentName prop', () => {
    renderCard(
      proposal({
        kind: 'comment',
        payload: { body: 'Fixed by removing the breakpoint override.' },
        snapshot: {
          identifier: 'LAUNCH-3',
          title: 'Responsive nav breaks on iPad landscape',
        },
      }),
    );

    expect(screen.getByText('Posted as you')).toBeInTheDocument();
  });
});
