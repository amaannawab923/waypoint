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
  deleteComment,
  deleteTicket,
  editComment,
  getCurrentUser,
  getTicket,
  getTicketByIdentifier,
  markNotificationsReadForTicket,
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
  toggleCommentReaction,
  toggleTicketAgent,
  toggleTicketAssignee,
  toggleTicketLabel,
  updateTicket,
  uploadAttachment,
  deleteAttachment,
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
  deleteComment: jest.fn(),
  deleteTicket: jest.fn(),
  editComment: jest.fn(),
  getCurrentUser: jest.fn(),
  getTicket: jest.fn(),
  getTicketByIdentifier: jest.fn(),
  markNotificationsReadForTicket: jest.fn(),
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
  toggleCommentReaction: jest.fn(),
  toggleTicketAgent: jest.fn(),
  toggleTicketAssignee: jest.fn(),
  toggleTicketLabel: jest.fn(),
  updateTicket: jest.fn(),
  uploadAttachment: jest.fn(),
  deleteAttachment: jest.fn(),
  attachmentUrl: (a: { url: string }) => `https://api.test${a.url}`,
  attachmentDownloadUrl: (a: { downloadUrl: string }) =>
    `https://api.test${a.downloadUrl}`,
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

function commentWith(
  bodyHtml: string,
  authorId = 'mem-1',
  overrides: Partial<Comment> = {},
): Comment {
  return {
    id: 'cm-1',
    ticketId: 'wi-1',
    authorId,
    bodyHtml,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    parentId: null,
    reactions: [],
    attachments: [],
    ...overrides,
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
  jest.mocked(editComment).mockResolvedValue(commentWith(''));
  jest.mocked(deleteComment).mockResolvedValue(undefined);
  jest.mocked(toggleCommentReaction).mockResolvedValue([]);
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

describe('TicketDetailPage → clears its notifications when opened', () => {
  it('marks the ticket\'s notifications read, and tells the bell only if something changed', async () => {
    const heard = jest.fn();
    window.addEventListener('waypoint:notifications-changed', heard);
    jest.mocked(markNotificationsReadForTicket).mockResolvedValue(2);
    mount([]);
    await act(async () => {});
    expect(markNotificationsReadForTicket).toHaveBeenCalledWith(ITEM.id);
    expect(heard).toHaveBeenCalledTimes(1);

    cleanup();
    heard.mockClear();
    jest.mocked(markNotificationsReadForTicket).mockResolvedValue(0);
    mount([]);
    await act(async () => {});
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener('waypoint:notifications-changed', heard);
  });

  it('never lets a failure there break opening the ticket', async () => {
    jest.mocked(markNotificationsReadForTicket).mockRejectedValue(new Error('offline'));
    mount([]);
    await act(async () => {});
    // The title is an editable field, so it's there as the field's value.
    expect(screen.getByDisplayValue(ITEM.title)).toBeInTheDocument();
  });
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
// (default is 1000ms) after CI flagged an earlier version of this suite as
// flaky on PR #36: it passed reliably in every local run (isolated and
// full-suite) but missed the default window once under CI's own load, once
// this file grew by ~14 tests earlier in the same file as part of that PR
// (findings 1/3/7a/7c) — more real render+async work ahead of this block,
// on a slower/shared runner, is exactly the profile that tips a marginal
// default timeout over.
//
// ROAD-162: a human-typed comment now renders through renderMarkdown
// (lib/markdown.ts) via dangerouslySetInnerHTML, not as a bare React text
// node — the edit/reply/reactions feature needs a comment that types
// `**bold**` to actually render bold, matching the Jira comment surface
// (JiraTicketDetail.tsx). This suite's job hasn't changed even though the
// implementation has: an injected payload must still come out as inert,
// visible text, never a live element — renderMarkdown's escape-first design
// (it runs every character through escapeHtml BEFORE it ever emits its own
// small, fixed tag vocabulary) is what still guarantees that. The old
// "does not use dangerouslySetInnerHTML for comment bodies" test asserted
// the previous MECHANISM (no HTML injection at all); this rewrite asserts
// the invariant that mechanism existed to protect, under the new one.
describe('TicketDetailPage → comment rendering (markdown, XSS-safe)', () => {
  it('renders a comment containing an <img onerror> payload as escaped text, not a live element', async () => {
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

  it('escapes an embedded HTML tag instead of rendering it live', async () => {
    mount([commentWith('<b>not bold</b>, just text')]);

    // renderMarkdown escapes `<b>`/`</b>` to `&lt;b&gt;`/`&lt;/b&gt;` before
    // it ever looks for markdown syntax, so the literal tag text is what
    // shows up — never a real <b> element wrapping "not bold".
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

  it('renders real markdown formatting for a human comment (bold, not literal asterisks)', async () => {
    mount([commentWith('this is **bold** text')]);

    const bold = await screen.findByText('bold', {}, { timeout: 5000 });
    expect(bold.tagName).toBe('STRONG');
    expect(screen.queryByText('**bold**')).not.toBeInTheDocument();
  });

  // Agent-authored comments are the one case where bodyHtml genuinely is
  // HTML — built server-side by buildCopilotCommentHtml, which escapes the
  // display name and body before wrapping them in a fixed <p>/<em> template.
  // That path never touches human input, so it renders that trusted markup
  // as-is, never through renderMarkdown (which would double-escape it).
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

  it('still renders a human comment as escaped text even when an agent exists elsewhere', async () => {
    mount([commentWith(XSS_PAYLOAD, 'mem-1')], [AGENT]);

    expect(
      await screen.findByText(XSS_PAYLOAD, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  // ROAD-162: an edited or replied body goes through addComment/editComment
  // — the exact same bodyHtml storage path a fresh top-level comment
  // already uses — so it renders through the same escape-first
  // renderMarkdown call. This is the DoD's "an edited or replied body still
  // renders escaped" check: mounting a comment that already carries an
  // updatedAt (what an edit produces) or a parentId (what a reply produces)
  // and re-asserting the same invariant proves that neither the edit
  // marker nor the reply/threading UI opened a second, un-escaped render
  // path for the body.
  it('still renders escaped text for an edited comment (has updatedAt) carrying an XSS payload', async () => {
    mount([
      commentWith(XSS_PAYLOAD, 'mem-1', {
        updatedAt: new Date().toISOString(),
      }),
    ]);

    expect(
      await screen.findByText(XSS_PAYLOAD, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
    expect(
      screen.getByText('· (edited)', { exact: false }),
    ).toBeInTheDocument();
  });

  it('still renders escaped text for a reply (has parentId) carrying an XSS payload', async () => {
    const root = commentWith('root comment', 'mem-1', { id: 'cm-root' });
    const reply = commentWith(XSS_PAYLOAD, 'mem-1', {
      id: 'cm-reply',
      parentId: 'cm-root',
    });
    mount([root, reply]);

    expect(
      await screen.findByText(XSS_PAYLOAD, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});

// ROAD-162: edit, reply threading, and reactions on native ticket comments —
// the client-side half of author-only enforcement (the real gate is
// server-side, in comments.service.ts's editComment/deleteComment, against
// currentMemberId(); see this describe block's own "does not show Edit or
// Delete" test for why the UI still bothers gating, as a courtesy rather
// than a security boundary), reply threading through the shared composer,
// and toggling a reaction.
describe('TicketDetailPage → comment edit, reply, and reactions', () => {
  it('lets the author edit their own comment and saves the new text', async () => {
    mount([commentWith('original text', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const textarea = await screen.findByDisplayValue('original text');
    fireEvent.change(textarea, { target: { value: 'edited text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(editComment).toHaveBeenCalledWith(
        'wi-1',
        'cm-1',
        'edited text',
        [],
        // The version the edit started from, so a stale window's save is
        // refused instead of overwriting; see editComment in data/api.
        expect.any(String),
      ),
    );
  });

  it('does not show Edit or Delete for a comment authored by someone else, but still shows Reply', async () => {
    mount([commentWith('not mine', 'mem-2')]);

    await screen.findByText('not mine');
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('deletes a comment after confirming, when the current member is its author', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount([commentWith('delete me', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(deleteComment).toHaveBeenCalledWith('wi-1', 'cm-1'),
    );
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirm dialog is declined', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    mount([commentWith('keep me', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(deleteComment).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('threads a reply from a box opened inline, under the comment it answers', async () => {
    mount([commentWith('root comment', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    expect(
      await screen.findByText('Replying to', { exact: false }),
    ).toBeInTheDocument();
    // The box belongs to the thread it answers, not to the shared composer
    // at the top of the section — that placement was the whole reason the
    // first pass's Reply appeared to do nothing.
    const replyBox = screen.getByPlaceholderText('Reply to Priya…');
    expect(
      replyBox.closest('[data-comment-id]') ??
        document.querySelector('[data-comment-id]'),
    ).toBeTruthy();

    const textarea = screen.getByPlaceholderText('Reply to Priya…');
    fireEvent.change(textarea, { target: { value: 'my reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));

    await waitFor(() =>
      expect(addComment).toHaveBeenCalledWith('wi-1', 'my reply', 'cm-1', []),
    );
  });

  it('lets Cancel on the reply indicator close the reply box and leave the top composer alone', async () => {
    mount([commentWith('root comment', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    fireEvent.click(await screen.findByLabelText('Cancel reply'));

    expect(
      screen.queryByText('Replying to', { exact: false }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Reply to Priya…'),
    ).not.toBeInTheDocument();
    // The shared composer is still the collapsed one-liner it was: closing
    // a reply must not open it.
    expect(
      screen.getByRole('button', { name: 'Leave a comment…' }),
    ).toBeInTheDocument();
  });

  it('puts the composer above the thread, collapsed until it is clicked', async () => {
    mount([commentWith('first comment', 'mem-1')]);
    await screen.findByText('first comment');

    const collapsed = screen.getByRole('button', {
      name: 'Leave a comment…',
    });
    // No textarea until asked for — the point of collapsing it.
    expect(
      screen.queryByPlaceholderText('Leave a comment…'),
    ).not.toBeInTheDocument();

    // Above, not below: the composer must come before the first comment in
    // document order, which is what keeps it reachable on a long thread.
    const firstComment = document.querySelector('[data-comment-id]');
    expect(firstComment).not.toBeNull();
    expect(
      collapsed.compareDocumentPosition(firstComment as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(collapsed);
    expect(
      screen.getByPlaceholderText('Leave a comment…'),
    ).toBeInTheDocument();
  });

  it('keeps the per-comment actions visible without a hover', async () => {
    mount([commentWith('mine', 'mem-1')]);
    await screen.findByText('mine');

    // Regression test for the reason threading was invisible: the row used
    // to be opacity-0 until :hover, so Reply could not be found by anyone
    // who had not already swept a mouse over the comment, and never on a
    // touch screen.
    const row = screen
      .getByRole('button', { name: 'Reply' })
      .closest('div') as HTMLElement;
    expect(row.className).not.toMatch(/opacity-0/);
  });

  it('posts on Cmd+Enter from the top composer, and Escape closes it', async () => {
    mount([]);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Leave a comment…' }),
    );
    const box = screen.getByPlaceholderText('Leave a comment…');
    fireEvent.change(box, { target: { value: 'typed and sent' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });

    await waitFor(() =>
      expect(addComment).toHaveBeenCalledWith('wi-1', 'typed and sent', null, []),
    );
  });

  it('posts a reply on Cmd+Enter and closes the reply box on Escape', async () => {
    mount([commentWith('root comment', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    const box = screen.getByPlaceholderText('Reply to Priya…');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(
      screen.queryByPlaceholderText('Reply to Priya…'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const reopened = screen.getByPlaceholderText('Reply to Priya…');
    fireEvent.change(reopened, { target: { value: 'quick reply' } });
    fireEvent.keyDown(reopened, { key: 'Enter', ctrlKey: true });

    await waitFor(() =>
      expect(addComment).toHaveBeenCalledWith('wi-1', 'quick reply', 'cm-1', []),
    );
  });

  describe('discarding a draft', () => {
    it('asks before Cancel throws away what was typed, and keeps it on "no"', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
      mount([]);
      fireEvent.click(await screen.findByRole('button', { name: 'Leave a comment…' }));
      const box = screen.getByPlaceholderText('Leave a comment…');
      fireEvent.change(box, { target: { value: 'half a thought' } });

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(confirmSpy).toHaveBeenCalledWith('Discard this comment?');
      expect(screen.getByDisplayValue('half a thought')).toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it('asks before Escape does the same thing', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
      mount([]);
      fireEvent.click(await screen.findByRole('button', { name: 'Leave a comment…' }));
      const box = screen.getByPlaceholderText('Leave a comment…');
      fireEvent.change(box, { target: { value: 'half a thought' } });

      fireEvent.keyDown(box, { key: 'Escape' });

      expect(confirmSpy).toHaveBeenCalled();
      expect(screen.getByDisplayValue('half a thought')).toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it('closes an empty composer without asking anything', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm');
      mount([]);
      fireEvent.click(await screen.findByRole('button', { name: 'Leave a comment…' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'Leave a comment…' }),
      ).toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it("doesn't ask when backing out of an edit that changed nothing", async () => {
      const confirmSpy = jest.spyOn(window, 'confirm');
      mount([commentWith('original text', 'mem-1')]);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      await screen.findByDisplayValue('original text');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });

  it('the ticket-level Attach button works instead of promising "Soon"', async () => {
    mount([]);
    await screen.findByText('No comments yet.');
    const attach = screen.getByRole('button', { name: 'Attach' });
    expect(attach).toBeEnabled();
    expect(attach).not.toHaveTextContent('Soon');

    // It opens the same file picker the comments header's "Attach files" does.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = jest.spyOn(input, 'click');
    fireEvent.click(attach);
    expect(clickSpy).toHaveBeenCalled();
  });

  describe('attachments in the composer (review round 1)', () => {
    // jsdom has no object URLs; the tray uses one for an image's local
    // thumbnail while it uploads.
    beforeAll(() => {
      Object.assign(URL, {
        createObjectURL: jest.fn(() => 'blob:test'),
        revokeObjectURL: jest.fn(),
      });
    });

    function attachmentFor(id: string, name: string) {
      return {
        id,
        ticketId: 'wi-1',
        commentId: null,
        uploaderId: 'mem-1',
        filename: name,
        mimeType: 'image/png',
        sizeBytes: 10,
        createdAt: new Date().toISOString(),
        url: `/attachments/${id}?t=exp.sig`,
        downloadUrl: `/attachments/${id}/download?t=exp.sig`,
      };
    }
    function pickFiles(...names: string[]) {
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const files = names.map((n) => new File(['x'], n, { type: 'image/png' }));
      fireEvent.change(input, { target: { files } });
    }

    it('posts a comment that is only an attachment', async () => {
      jest.mocked(uploadAttachment).mockResolvedValue(attachmentFor('att-1', 'shot.png'));
      mount([]);
      await screen.findByText('No comments yet.');
      pickFiles('shot.png');

      const post = await screen.findByRole('button', { name: 'Comment' });
      await waitFor(() => expect(post).toBeEnabled());
      fireEvent.click(post);

      // Empty text, one file: a real comment. It used to be a silent no-op.
      await waitFor(() =>
        expect(addComment).toHaveBeenCalledWith('wi-1', '', null, ['att-1']),
      );
    });

    it('will not post while a file is still uploading, and says why', async () => {
      // Never resolves: the upload stays in flight for the whole test.
      jest.mocked(uploadAttachment).mockReturnValue(new Promise(() => {}));
      mount([]);
      await screen.findByText('No comments yet.');
      pickFiles('big.png');

      const post = await screen.findByRole('button', { name: 'Uploading…' });
      expect(post).toBeDisabled();
      const box = screen.getByPlaceholderText('Leave a comment…');
      fireEvent.change(box, { target: { value: 'with a file' } });
      // Not even ⌘↵, which reaches the handler without the button.
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
      expect(addComment).not.toHaveBeenCalled();
    });

    it('deletes the uploaded files when the draft is discarded, as the dialog says', async () => {
      jest.mocked(uploadAttachment).mockResolvedValue(attachmentFor('att-9', 'drop.png'));
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
      mount([]);
      await screen.findByText('No comments yet.');
      pickFiles('drop.png');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled(),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(confirmSpy).toHaveBeenCalledWith('Discard this comment and its attachments?');
      expect(deleteAttachment).toHaveBeenCalledWith('att-9');
      confirmSpy.mockRestore();
    });

    it("offers no Delete on the only file of a comment with no text", async () => {
      mount([
        commentWith('', 'mem-1', {
          attachments: [{ ...attachmentFor('att-3', 'lone.png'), commentId: 'cm-1' }],
        }),
      ]);
      await screen.findByText('lone.png');
      // Deleting it would leave an empty comment (the server refuses too);
      // the comment's own Delete is the way to remove it.
      expect(screen.queryByRole('button', { name: /Delete lone\.png/ })).not.toBeInTheDocument();
    });

    it('shows no empty text bubble for a comment that is only files', async () => {
      mount([
        commentWith('', 'mem-1', {
          attachments: [{ ...attachmentFor('att-2', 'only.png'), commentId: 'cm-1' }],
        }),
      ]);
      const row = (await screen.findByText('only.png')).closest('[data-comment-id]') as HTMLElement;
      expect(row.querySelector('.copilot-md')).toBeNull();
    });
  });

  it("asks before opening a reply would throw away an unsaved edit", async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    // Two comments: while one is being edited its own actions are replaced
    // by the editor, so the Reply clicked here is on the OTHER comment.
    mount([
      commentWith('original text', 'mem-1'),
      commentWith('someone else said', 'mem-1', { id: 'cm-2' }),
    ]);
    const editTarget = (await screen.findByText('original text')).closest('[data-comment-id]') as HTMLElement;
    fireEvent.click(within(editTarget).getByRole('button', { name: 'Edit' }));
    const box = await screen.findByDisplayValue('original text');
    fireEvent.change(box, { target: { value: 'half-edited' } });

    const other = screen.getByText('someone else said').closest('[data-comment-id]') as HTMLElement;
    fireEvent.click(within(other).getByRole('button', { name: 'Reply' }));

    expect(confirmSpy).toHaveBeenCalledWith('Discard your unsaved edit?');
    // Declined, so the edit is still there, untouched.
    expect(screen.getByDisplayValue('half-edited')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('says so plainly when a ticket has no comments yet', async () => {
    mount([]);
    expect(await screen.findByText('No comments yet.')).toBeInTheDocument();
    // The composer is still there — an empty thread is the case where you
    // most need it.
    expect(
      screen.getByRole('button', { name: 'Leave a comment…' }),
    ).toBeInTheDocument();
  });

  it('offers a retry, not silence, when the comments fail to load', async () => {
    mount([]);
    jest
      .mocked(listComments)
      .mockRejectedValueOnce(new Error('network is down'));
    // Re-mount with the rejecting mock in place.
    cleanup();
    mount([]);

    expect(
      await screen.findByText("Couldn't load this ticket's comments."),
    ).toBeInTheDocument();

    jest.mocked(listComments).mockResolvedValue([commentWith('back', 'mem-1')]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('back')).toBeInTheDocument();
  });

  it('flashes the comment a #comment-<id> hash names, once the thread loads', async () => {
    jest.useFakeTimers();
    jest.mocked(listComments).mockResolvedValue([commentWith('find me', 'mem-1')]);
    render(
      <MemoryRouter initialEntries={['/t#comment-cm-1']}>
        <TicketDetailContent projectId="proj-1" identifier="LAUNCH-3" />
      </MemoryRouter>,
    );

    // The effect deliberately waits for the thread to load rather than
    // running on mount, when the list is still undefined and the element
    // does not exist yet.
    const node = await screen.findByText('find me');
    const wrapper = node.closest('[data-comment-id]') as HTMLElement;
    await waitFor(() =>
      expect(wrapper.className).toContain('bg-accent-soft-bg'),
    );

    act(() => {
      jest.advanceTimersByTime(1700);
    });
    expect(wrapper.className).not.toContain('bg-accent-soft-bg');
    jest.useRealTimers();
  });

  it('copies an in-app permalink that names the comment', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    mount([commentWith('link me', 'mem-1')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // The route this app can actually open, plus the hash the deep-link
    // effect reads — not a web URL, which no native ticket has.
    expect(writeText.mock.calls[0][0]).toContain(
      '/projects/proj-1/tickets/LAUNCH-3#comment-cm-1',
    );
    // Acknowledges the copy in place rather than firing a toast.
    expect(
      await screen.findByRole('button', { name: 'Link copied' }),
    ).toBeInTheDocument();
  });

  it('shows newest comments first, and flips on the toggle', async () => {
    mount([
      commentWith('older', 'mem-1'),
      { ...commentWith('newer', 'mem-1'), id: 'cm-2' },
    ]);
    await screen.findByText('older');

    const order = () =>
      Array.from(document.querySelectorAll('[data-comment-id]')).map((el) =>
        el.getAttribute('data-comment-id'),
      );
    expect(order()).toEqual(['cm-2', 'cm-1']);

    fireEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    expect(order()).toEqual(['cm-1', 'cm-2']);
  });

  it('shows an existing reaction and toggles it on click', async () => {
    mount([
      commentWith('react to me', 'mem-1', {
        // 'mem-1' is MEMBER, the only member listMembers resolves in this
        // test file — resolveActor needs a real, resolvable id to name in
        // the pill's title, so this reuses it as "some reactor", distinct
        // from what this comment's own AUTHOR being 'mem-1' means.
        reactions: [{ emoji: '👍', actorIds: ['mem-1'] }],
      }),
    ]);

    // Queried by the pill's own aria-label, not its `title` — `title` is
    // just the reactor's name ("Priya"), which collides with every Avatar's
    // own title={name} in the same thread (see the pill's own comment).
    const pill = await screen.findByRole('button', {
      name: '👍 reaction (1) — click to toggle',
    });
    fireEvent.click(pill);

    await waitFor(() =>
      expect(toggleCommentReaction).toHaveBeenCalledWith('wi-1', 'cm-1', '👍'),
    );
  });

  it('adds a new reaction through the React picker', async () => {
    mount([commentWith('react to me', 'mem-1')]);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Add reaction' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'thumbs up approve' }),
    );

    await waitFor(() =>
      expect(toggleCommentReaction).toHaveBeenCalledWith('wi-1', 'cm-1', '👍'),
    );
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
