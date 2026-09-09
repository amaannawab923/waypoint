import '@testing-library/jest-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  addComment,
  addTicketLink,
  approveCopilotProposal,
  deleteTicket,
  getCurrentUser,
  getTicket,
  getTicketByIdentifier,
  listActivity,
  listAgentAssignments,
  listAgents,
  listComments,
  listSprints,
  listLabels,
  listMembers,
  listWorkstreams,
  listStates,
  listSubItems,
  listTickets,
  listTicketProposals,
  rejectCopilotProposal,
  removeTicketLink,
  takeBackOverFromAgent,
  toggleTicketAgent,
  toggleTicketAssignee,
  toggleTicketLabel,
  updateTicket,
} from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import { resetProposalStoreForTests } from '@/lib/proposalStore';
import type {
  Agent,
  Comment,
  Member,
  Project,
  ProposalView,
  Ticket,
} from '@/types/entities';
import { TicketDetailContent } from './TicketDetailPage';

jest.mock('@/data/api', () => ({
  addComment: jest.fn(),
  addTicketLink: jest.fn(),
  // approveCopilotProposal/rejectCopilotProposal aren't called directly by
  // this page — they're what lib/proposalStore.ts's approveProposal/
  // rejectProposal call underneath — but that module also imports them from
  // '@/data/api', so this mock factory needs to cover them too.
  approveCopilotProposal: jest.fn(),
  rejectCopilotProposal: jest.fn(),
  deleteTicket: jest.fn(),
  getCurrentUser: jest.fn(),
  getTicket: jest.fn(),
  getTicketByIdentifier: jest.fn(),
  listActivity: jest.fn(),
  listAgentAssignments: jest.fn(),
  listAgents: jest.fn(),
  listComments: jest.fn(),
  listSprints: jest.fn(),
  listLabels: jest.fn(),
  listMembers: jest.fn(),
  listWorkstreams: jest.fn(),
  listStates: jest.fn(),
  listSubItems: jest.fn(),
  listTicketProposals: jest.fn(),
  // Not called by this page directly — CreateTicketModal (rendered for
  // the "Add subtask" flow) calls it to populate the new Parent field
  // (finding 2a).
  listTickets: jest.fn(),
  removeTicketLink: jest.fn(),
  takeBackOverFromAgent: jest.fn(),
  toggleTicketAgent: jest.fn(),
  toggleTicketAssignee: jest.fn(),
  toggleTicketLabel: jest.fn(),
  updateTicket: jest.fn(),
}));
jest.mock('@/layouts/ProjectLayout', () => ({ useProject: jest.fn() }));

const PROJECT: Project = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Launch',
  identifier: 'LAUNCH',
  description: '',
  icon: '📦',
  coverGradient: ['#c2542a', '#3a2314'],
  visibility: 'public',
  leadId: null,
  defaultAssigneeId: null,
  timezone: 'UTC',
  estimate: null,
  automations: {
    autoArchiveEnabled: false,
    autoArchiveAfterDays: 30,
    autoCloseEnabled: false,
    autoCloseAfterDays: 30,
  },
  createdAt: new Date().toISOString(),
  archivedAt: null,
  memberIds: ['mem-1'],
  guestAccessEnabled: false,
  repoPath: null,
  primitiveCounts: {
    sprints: 0,
    workstreams: 0,
    views: 0,
    docs: 0,
    requests: 0,
    requestsPending: 0,
  },
  acceptsRequests: false,
};

const MEMBER: Member = {
  id: 'mem-1',
  workspaceId: 'ws-1',
  fullName: 'Priya Sharma',
  displayName: 'Priya',
  email: 'priya@example.com',
  avatarColor: '#123456',
  role: 'member',
  authMethod: 'email',
  joinedAt: new Date().toISOString(),
  firstDayOfWeek: 'Sunday',
  notificationPrefs: null,
};

const ITEM: Ticket = {
  id: 'wi-1',
  projectId: 'proj-1',
  identifier: 'LAUNCH-3',
  sequenceId: 3,
  title: 'Responsive nav breaks on iPad landscape',
  description: '',
  stateId: 'st-1',
  priority: 'none',
  source: 'manual',
  assigneeIds: [],
  labelIds: [],
  workstreamId: null,
  sprintId: null,
  parentId: null,
  estimatePoints: null,
  estimateValue: null,
  startDate: null,
  dueDate: null,
  createdById: 'mem-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attachmentCount: 0,
  linkCount: 0,
  links: [],
  isDraft: false,
};

const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';

const AGENT: Agent = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  name: 'Triage Agent',
  avatarColor: '#654321',
  instructionsFile: { filename: 'agent.md', contentMarkdown: '' },
  scopeAllProjects: true,
  scopeProjectIds: [],
  executionMethod: 'local-claude-subscription',
  model: 'Claude Opus',
  autonomy: 'ask-before-write',
  triggers: ['manual'],
  isActive: true,
  createdById: 'mem-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function commentWith(bodyHtml: string, authorId = 'mem-1'): Comment {
  return {
    id: 'cm-1',
    ticketId: 'wi-1',
    authorId,
    bodyHtml,
    createdAt: new Date().toISOString(),
  };
}

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-1',
    conversationId: 'conv-1',
    kind: 'state_change',
    ticketId: 'wi-1',
    payload: { stateId: 'st-done' },
    snapshot: { identifier: 'LAUNCH-3', title: 'T', toStateName: 'Done' },
    anchorSeq: 1,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
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

function mount(
  comments: Comment[],
  agents: Agent[] = [],
  proposals: ProposalView[] = [],
  item: Ticket = ITEM,
  subItemsList: Ticket[] = [],
) {
  jest
    .mocked(useProject)
    .mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(getTicketByIdentifier).mockResolvedValue(item);
  jest.mocked(listStates).mockResolvedValue([]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([MEMBER]);
  jest.mocked(getCurrentUser).mockResolvedValue(MEMBER);
  jest.mocked(listAgents).mockResolvedValue(agents);
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(listSubItems).mockResolvedValue(subItemsList);
  jest.mocked(listTickets).mockResolvedValue([]);
  jest.mocked(listActivity).mockResolvedValue([]);
  jest.mocked(listComments).mockResolvedValue(comments);
  jest.mocked(getTicket).mockResolvedValue(ITEM);
  jest.mocked(listTicketProposals).mockResolvedValue(proposals);
  jest.mocked(addComment).mockResolvedValue(commentWith(''));
  jest.mocked(addTicketLink).mockResolvedValue(ITEM);
  jest.mocked(removeTicketLink).mockResolvedValue(ITEM);
  jest.mocked(deleteTicket).mockResolvedValue(undefined);
  jest.mocked(takeBackOverFromAgent).mockResolvedValue(undefined as never);
  jest.mocked(toggleTicketAgent).mockResolvedValue(undefined as never);
  jest.mocked(toggleTicketAssignee).mockResolvedValue(undefined as never);
  jest.mocked(toggleTicketLabel).mockResolvedValue(undefined as never);
  jest.mocked(updateTicket).mockResolvedValue(ITEM);

  return render(
    <MemoryRouter>
      <TicketDetailContent projectId="proj-1" identifier="LAUNCH-3" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetProposalStoreForTests();
});

afterEach(() => {
  cleanup();
});

// Finding 1: the description field used to be a fixed rows={4} textarea
// that silently clipped anything past 4 lines. It now measures its own
// scrollHeight and grows to fit, capped at 400px.
describe('TicketDetailPage → description auto-grow (finding 1)', () => {
  it('is no longer a fixed rows={4} textarea', async () => {
    mount([]);

    const textarea = (await screen.findByPlaceholderText(
      'Add description…',
    )) as HTMLTextAreaElement;
    expect(textarea).not.toHaveAttribute('rows');
  });

  it('grows the textarea height to fit content, up to the 400px cap', async () => {
    mount([]);

    const textarea = (await screen.findByPlaceholderText(
      'Add description…',
    )) as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 250,
    });

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'line\n'.repeat(20) } });
    });

    expect(textarea.style.height).toBe('250px');
  });

  it('caps the grown height at 400px so it scrolls instead of growing forever', async () => {
    mount([]);

    const textarea = (await screen.findByPlaceholderText(
      'Add description…',
    )) as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 900,
    });

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'line\n'.repeat(100) } });
    });

    expect(textarea.style.height).toBe('400px');
  });
});

// Finding 3: the title input used to clip mid-word with no ellipsis
// (overflow: clip). It now truncates visually at rest — native input
// behavior already scrolls to the caret while focused, so this only
// changes the unfocused display, never what's actually saved.
describe('TicketDetailPage → title truncation (finding 3)', () => {
  it('truncates the title input at rest instead of clipping mid-word', async () => {
    mount([]);

    const title = await screen.findByDisplayValue(ITEM.title);
    expect(title).toHaveClass('truncate');
  });

  it('still saves and round-trips a long title in full through updateTicket()', async () => {
    mount([]);
    const longTitle =
      'A very long ticket title that would visually clip mid-word before this fix landed and must still be saved in full';

    const title = (await screen.findByDisplayValue(
      ITEM.title,
    )) as HTMLInputElement;
    fireEvent.change(title, { target: { value: longTitle } });
    fireEvent.blur(title);

    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('wi-1', { title: longTitle }),
    );
  });
});

// Finding 7a: estimatePoints (a free, unconstrained numeric field) had no
// UI surface at all — distinct from estimateValue (constrained to the
// project's configured Fibonacci/T-shirt preset). Deliberately always
// visible, unlike the existing Estimate row, so it must render correctly
// even with project.estimate: null — the PROJSET-06-adjacent defensive
// test the proposal called for near this historically fragile area.
describe('TicketDetailPage → Story points field (finding 7a)', () => {
  it('renders even when the project has no configured estimate system', async () => {
    mount([]);

    // Waits on the input itself, not the 'Story points' label text — the
    // loading skeleton renders that same label too (it's now unconditional
    // there, matching this row's own always-visible behavior), so a wait
    // keyed on the label alone would resolve prematurely against it.
    const input = (await screen.findByPlaceholderText(
      'No estimate',
    )) as HTMLInputElement;
    expect(screen.getByText('Story points')).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('step', '0.5');
    expect(input).toHaveAttribute('min', '0');
    expect(input.value).toBe('');
  });

  // B2: the field used to be a plain controlled input bound straight to
  // item.estimatePoints, saving on every keystroke via patchItem() (which
  // awaits updateTicket() then reloads) — typing "17.5" got the reload's
  // Number("17.") === 17 written back into the input before "5" could ever
  // be typed, so a decimal was unreachable by typing. Now it's local draft
  // state committed on blur, matching the title/description fields' own
  // pattern — nothing commits until blur.
  it('does NOT call updateTicket while still typing (before blur)', async () => {
    mount([]);

    const input = await screen.findByPlaceholderText('No estimate');
    fireEvent.change(input, { target: { value: '17' } });
    fireEvent.change(input, { target: { value: '17.' } });
    fireEvent.change(input, { target: { value: '17.5' } });

    expect(updateTicket).not.toHaveBeenCalled();
  });

  it('commits the full decimal value on blur, not truncated at the last whole digit typed', async () => {
    mount([]);

    const input = (await screen.findByPlaceholderText(
      'No estimate',
    )) as HTMLInputElement;
    // Character-by-character, as a real typed "17.5" would arrive: each
    // fireEvent.change reflects one more character landing in the field.
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '17' } });
    fireEvent.change(input, { target: { value: '17.' } });
    fireEvent.change(input, { target: { value: '17.5' } });
    expect(input.value).toBe('17.5');

    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('wi-1', {
        estimatePoints: 17.5,
      }),
    );
  });

  it('calls updateTicket with the new estimatePoints value on blur', async () => {
    mount([]);

    const input = await screen.findByPlaceholderText('No estimate');
    fireEvent.change(input, { target: { value: '17.5' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('wi-1', {
        estimatePoints: 17.5,
      }),
    );
  });

  it('clears estimatePoints back to null when the field is emptied and blurred', async () => {
    // Seeded with a real starting value (not mount()'s default null) so
    // "clear the field" is a genuine, detectable change from the draft's
    // initial sync.
    mount([], [], [], { ...ITEM, estimatePoints: 8 });

    const input = (await screen.findByDisplayValue('8')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('wi-1', {
        estimatePoints: null,
      }),
    );
  });

  it('saves on Enter, matching the title field convention', async () => {
    mount([]);

    const input = (await screen.findByPlaceholderText(
      'No estimate',
    )) as HTMLInputElement;
    // The handler saves via `e.target.blur()`, which only fires a real
    // blur event when the element is actually focused first — mirrors a
    // real user's flow (focus, type, hit Enter) rather than jsdom's default
    // of not focusing anything on a bare fireEvent.change.
    input.focus();
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('wi-1', { estimatePoints: 3 }),
    );
  });

  // M5: `min="0"` on the <input type="number"> only constrains the stepper
  // arrows/native form validation, not a value typed via the keyboard and
  // committed through this blur-save handler — a probe confirmed a typed
  // "-5" reached updateTicket unrejected before this fix. Rejected the same
  // way as an unparseable draft (see savePoints' own comment): reverted to
  // the last saved value instead of persisted.
  it('rejects a typed negative value on blur, reverting the draft instead of persisting it', async () => {
    mount([], [], [], { ...ITEM, estimatePoints: 8 });

    const input = (await screen.findByDisplayValue('8')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);

    // Give any (incorrect) async updateTicket call a turn to fire before
    // asserting it never did.
    await Promise.resolve();
    expect(updateTicket).not.toHaveBeenCalled();
    expect(input.value).toBe('8');
  });
});

function subItem(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ...ITEM,
    id: 'sub-1',
    identifier: 'LAUNCH-4',
    title: 'Subtask',
    parentId: 'wi-1',
    ...overrides,
  };
}

// Finding 7c: sums estimatePoints across a ticket's already-fetched
// subItems, shown next to the existing Subtasks progress bar. Only the
// ticket-detail roll-up is in scope here — no workspace-wide List/Board
// epic-total roll-up.
describe('TicketDetailPage → subtask points roll-up (finding 7c)', () => {
  it('shows the summed points suffix when at least one subtask carries a point value', async () => {
    mount([], [], [], ITEM, [
      subItem({ id: 's1', estimatePoints: 5 }),
      subItem({ id: 's2', estimatePoints: 8 }),
    ]);

    expect(
      await screen.findByText('Subtasks (2) · 13 pts'),
    ).toBeInTheDocument();
  });

  it('omits the suffix entirely when no subtask has a point value', async () => {
    mount([], [], [], ITEM, [
      subItem({ id: 's1', estimatePoints: null }),
      subItem({ id: 's2', estimatePoints: null }),
    ]);

    expect(await screen.findByText('Subtasks (2)')).toBeInTheDocument();
    expect(screen.queryByText(/pts/)).not.toBeInTheDocument();
  });

  it('sums only the subtasks that carry a point value, ignoring unestimated ones', async () => {
    mount([], [], [], ITEM, [
      subItem({ id: 's1', estimatePoints: 3 }),
      subItem({ id: 's2', estimatePoints: null }),
      subItem({ id: 's3', estimatePoints: 2.5 }),
    ]);

    expect(
      await screen.findByText('Subtasks (3) · 5.5 pts'),
    ).toBeInTheDocument();
  });
});

// This describe block's async findBy* calls got a longer explicit timeout
// (default is 1000ms) after CI flagged "does not use dangerouslySetInnerHTML
// for comment bodies" as flaky on PR #36: it passed reliably in every local
// run (isolated and full-suite) but missed the default window once under
// CI's own load, once this file grew by ~14 tests earlier in the same file
// as part of that PR (findings 1/3/7a/7c) — more real render+async work
// ahead of this block, on a slower/shared runner, is exactly the profile
// that tips a marginal default timeout over. Not a logic bug in the
// component; the assertions themselves are unchanged.
describe('TicketDetailPage → comment rendering (stored XSS fix)', () => {
  it('renders a comment containing an <img onerror> payload as visible text, not a live element', async () => {
    mount([commentWith(XSS_PAYLOAD)]);

    // The payload must appear as literal, visible text …
    expect(
      await screen.findByText(XSS_PAYLOAD, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // … and must never have been parsed into a real <img> element (which
    // would fire the onerror handler and execute the injected script).
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  it('preserves newlines in a plain-text comment', async () => {
    mount([commentWith('first line\nsecond line')]);

    const node = await screen.findByText(
      (_, element) => element?.textContent === 'first line\nsecond line',
      {},
      { timeout: 5000 },
    );
    expect(node).toHaveClass('whitespace-pre-wrap');
  });

  it('does not use dangerouslySetInnerHTML for comment bodies', async () => {
    mount([commentWith('<b>not bold</b>, just text')]);

    // If this were still injected as HTML, "<b>not bold</b>" would render an
    // actual <b> element wrapping "not bold" instead of showing the tags.
    expect(
      await screen.findByText(
        '<b>not bold</b>, just text',
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('not bold', { selector: 'b' }),
    ).not.toBeInTheDocument();
  });

  // Agent-authored comments are the one case where bodyHtml genuinely is
  // HTML — built server-side by buildCopilotCommentHtml, which escapes the
  // display name and body before wrapping them in a fixed <p>/<em> template.
  // That path never touches human input, so it should still render as real
  // markup instead of falling back to the plain-text guard above.
  it('still renders trusted, backend-escaped HTML for an agent-authored comment', async () => {
    const html =
      '<p><em>Hi, this is Copilot — Priya’s agent — commenting on their behalf: </em>Repro’d on Safari 17.</p>';
    mount([commentWith(html, 'agent-1')], [AGENT]);

    const disclosure = await screen.findByText(
      (_, el) =>
        el?.tagName === 'EM' &&
        el.textContent ===
          'Hi, this is Copilot — Priya’s agent — commenting on their behalf: ',
      {},
      { timeout: 5000 },
    );
    expect(disclosure.tagName).toBe('EM');
    expect(screen.getByText('Repro’d on Safari 17.')).toBeInTheDocument();
  });

  it('still renders a human comment as plain text even when an agent exists elsewhere', async () => {
    mount([commentWith(XSS_PAYLOAD, 'mem-1')], [AGENT]);

    expect(
      await screen.findByText(XSS_PAYLOAD, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});

// W4.4 (architecture §4.4) — the ticket-detail inline "Pending proposals"
// section, fetched via listTicketProposals and rendered through the same
// CopilotProposalCard as the Copilot panel, wired through the shared
// proposalStore so approve/reject stay in sync with any other mounted
// surface reading the same store.
describe('TicketDetailPage → pending proposals section', () => {
  it('shows no section at all when the ticket has zero pending proposals', async () => {
    mount([], [], []);

    await waitFor(() =>
      expect(listTicketProposals).toHaveBeenCalledWith('wi-1', 'proposed'),
    );
    expect(screen.queryByText(/Pending proposals/)).not.toBeInTheDocument();
  });

  it('renders a card for each pending proposal returned for this ticket', async () => {
    mount([], [], [proposal({ id: 'prop-1' })]);

    expect(
      await screen.findByText('Pending proposals (1)'),
    ).toBeInTheDocument();
    // The card's own kind label — from CopilotProposalCard.tsx — confirms
    // the shared card component rendered, not a bespoke one.
    expect(screen.getByText('Proposed change · State')).toBeInTheDocument();
  });

  it('approving from this card resolves through the shared proposalStore and updates the card in place', async () => {
    mount([], [], [proposal({ id: 'prop-1', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'prop-1', status: 'executed' }));

    expect(
      await screen.findByText('Pending proposals (1)'),
    ).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(approveCopilotProposal).toHaveBeenCalledWith('prop-1');
    expect(
      await screen.findByText('Applied — moved to Done'),
    ).toBeInTheDocument();
  });

  it('rejecting from this card resolves through the shared proposalStore', async () => {
    mount([], [], [proposal({ id: 'prop-1', status: 'proposed' })]);
    jest
      .mocked(rejectCopilotProposal)
      .mockResolvedValue(proposal({ id: 'prop-1', status: 'rejected' }));

    expect(
      await screen.findByText('Pending proposals (1)'),
    ).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'Reject' }).click();
    });

    expect(rejectCopilotProposal).toHaveBeenCalledWith('prop-1');
    expect(
      await screen.findByText('Dismissed, nothing changed'),
    ).toBeInTheDocument();
  });

  // Regression test for the bug this page's approve wiring used to have:
  // approving executes the proposal server-side (it mutates THIS ticket's
  // own priority via proposals.service.ts's executeProposal ->
  // ticketsService.updateTicket), but the proposal store only ever knew
  // about the proposal row's status, not the ticket underneath it — so the
  // sidebar kept rendering the pre-approve value until a full page reload.
  // Asserts the fix: approving re-fetches this ticket (getTicketByIdentifier
  // called again) and the sidebar's Priority field reflects the new value
  // with no reload/remount.
  it("approving a proposal that mutates this ticket refreshes the ticket's own sidebar fields, not just the card", async () => {
    mount(
      [],
      [],
      [
        proposal({
          id: 'prop-1',
          kind: 'priority_change',
          payload: { priority: 'high' },
          snapshot: {
            identifier: 'LAUNCH-3',
            title: 'T',
            fromPriority: 'none',
          },
        }),
      ],
    );
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(
        proposal({ id: 'prop-1', kind: 'priority_change', status: 'executed' }),
      );

    expect(
      await screen.findByText('Pending proposals (1)'),
    ).toBeInTheDocument();

    const priorityRowBefore = screen.getByText('Priority')
      .parentElement as HTMLElement;
    expect(within(priorityRowBefore).getByText('None')).toBeInTheDocument();

    // The reload this fix adds resolves to the post-approve ticket — same shape a real GET
    // would return once proposals.service.ts's executeProposal has actually run the priority
    // update server-side.
    jest
      .mocked(getTicketByIdentifier)
      .mockResolvedValue({ ...ITEM, priority: 'high' });

    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(getTicketByIdentifier).toHaveBeenCalledTimes(2);
    const priorityRowAfter = screen.getByText('Priority')
      .parentElement as HTMLElement;
    await waitFor(() =>
      expect(within(priorityRowAfter).getByText('High')).toBeInTheDocument(),
    );
    expect(
      within(priorityRowAfter).queryByText('None'),
    ).not.toBeInTheDocument();
  });
});
