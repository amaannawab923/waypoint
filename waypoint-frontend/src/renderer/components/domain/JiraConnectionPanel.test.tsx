import '@testing-library/jest-dom';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  connectJira,
  disconnectJira,
  getJiraConnectionStatus,
  refreshJiraSync,
} from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus } from '@/types/jira';
import { clearMyJiraQuery } from '@/pages/jira/useMyJiraQueue';
import {
  JiraConnectionPanel,
  disconnectJiraConfirmMessage,
} from './JiraConnectionPanel';

jest.mock('@/data/jiraApi', () => ({
  connectJira: jest.fn(),
  refreshJiraSync: jest.fn(),
  disconnectJira: jest.fn(),
  getJiraConnectionStatus: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ setJiraConnection: jest.fn() }));
jest.mock('@/pages/jira/useMyJiraQueue', () => ({
  clearMyJiraQuery: jest.fn(),
}));

// AddProjectWizard is always mounted here (it's the Connect CTA's target),
// and it calls useNavigate() unconditionally on every render regardless of
// its own `open` prop — so every render needs a Router ancestor, not just
// the tests that open the wizard.
function renderPanel(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function status(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    accountId: '5f8a',
    site: 'northwind.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
    countsTruncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Disconnect now gates on window.confirm; default every test to the
  // "user confirmed" path so the pre-existing tests below (written before
  // that guard existed) keep exercising what happens after confirmation,
  // and the guard itself gets its own dedicated test below.
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('JiraConnectionPanel', () => {
  // Refresh used to update only the shared connection store, so the sync
  // clock and the counts went current while the rows beside them kept
  // whatever they fetched on mount — a green "synced 0s ago" over a stale
  // list, and a "98 issues" that could sit next to 97 visible rows.
  describe('Refresh now', () => {
    it("re-reads the surrounding page's data, not just the sync clock", async () => {
      const onRefresh = jest.fn().mockResolvedValue(undefined);
      jest.mocked(getJiraConnectionStatus).mockResolvedValue(status());
      renderPanel(
        <JiraConnectionPanel connection={status()} onRefresh={onRefresh} />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
      expect(setJiraConnection).toHaveBeenCalled();
      // One round trip to Jira, not two: the page's read repopulates the
      // cache and stamps lastSyncAt, and the status read after it is local.
      expect(refreshJiraSync).not.toHaveBeenCalled();
    });

    it('falls back to its own read when it has no page to refresh', async () => {
      jest.mocked(refreshJiraSync).mockResolvedValue(status());
      renderPanel(<JiraConnectionPanel connection={status()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

      await waitFor(() => expect(refreshJiraSync).toHaveBeenCalledTimes(1));
    });
  });

  // A filter belongs to the account it was built against. Disconnecting and
  // reconnecting as someone else used to leave the previous user's project
  // filter and search text in place, so a person who had never touched a
  // filter opened onto "No tickets match these filters." over a queue that
  // was not empty.
  it('forgets the remembered query on disconnect', async () => {
    jest.mocked(disconnectJira).mockResolvedValue(undefined);
    jest
      .mocked(getJiraConnectionStatus)
      .mockResolvedValue(status({ connected: false, issueCount: 0 }));
    renderPanel(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(clearMyJiraQuery).toHaveBeenCalledTimes(1));
  });

  // A capped read used to render as a flat, confident "500 issues in your
  // queue" for a user with 900 — not a rounded number, a wrong one.
  it('renders a capped count as a floor, and says the queue is larger', () => {
    renderPanel(
      <JiraConnectionPanel
        connection={status({ issueCount: 500, countsTruncated: true })}
      />,
    );

    expect(screen.getByText('500+')).toBeInTheDocument();
    expect(
      screen.getByText('issues read (your queue is larger)'),
    ).toBeInTheDocument();
    expect(screen.queryByText('issues in your queue')).toBeNull();
  });

  it('leaves a complete count unqualified', () => {
    renderPanel(<JiraConnectionPanel connection={status({ issueCount: 6 })} />);

    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.queryByText('500+')).toBeNull();
    expect(screen.getByText('issues in your queue')).toBeInTheDocument();
  });

  it('renders the connected account row and live stats from the connection prop', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(screen.getByText('Max Chen')).toBeInTheDocument();
    expect(
      screen.getByText('max@northwind.dev · northwind.atlassian.net'),
    ).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  // The "poll interval" stat and the "Pause sync" button that used to sit
  // here described a background sync that has never existed — no timer, in
  // the fixture layer or the real one, ever re-read the list. They are gone
  // rather than left describing behavior the app does not have.
  it('advertises no poll interval and offers no pause, because nothing polls', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/poll interval/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /pause|resume/i }),
    ).not.toBeInTheDocument();
  });

  // This assertion is the capability register, not decoration. The banner
  // once listed a priority write that did not exist, which this test was
  // originally written to pin shut. jiraApi.ts now genuinely exposes six
  // writes — transitionJiraTicket, postJiraComment, deleteJiraComment,
  // setJiraTicketPriority, setJiraTicketAssignee and uploadJiraAttachment —
  // so the banner names six, and the check moves with it rather than being
  // deleted: what it guards is that the count on screen matches the count in
  // the data layer, in either direction.
  it('names exactly the six writes that exist, deleting a comment among them', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(
      screen.getByText(
        /moving a ticket through its workflow, posting a comment \(a reply included\), deleting a comment you have permission to remove, changing its priority, reassigning it, and attaching a file/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/those six are the whole set/i)).toBeVisible();
  });

  // Reply and Copy link shipped alongside Delete (ROAD-41's comment-actions
  // phase) but neither is a write of its own — Reply posts through the same
  // postJiraComment as any other comment (just prefilled with a mention;
  // Jira comments don't thread, so this is an ordinary top-level comment,
  // not a new capability), and Copy link sends nothing to Jira at all. The
  // register must not count either as a seventh write, and must not claim a
  // comment can be edited — that affordance does not exist.
  it('does not count Reply or Copy link as their own writes, and does not claim comments can be edited', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/those seven are the whole set/i)).toBeNull();
    expect(
      screen.getByText(
        /including copying a comment's link, is read-only here/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/editing a comment/i)).toBeNull();
  });

  // The other direction of the same defect. Uploading an attachment IS built
  // now, so the "Not built yet" list must no longer say it isn't — a list of
  // missing capabilities that has gone stale misleads exactly as much as a
  // banner claiming one that does not exist. The old counts are checked for
  // the same reason: an earlier "those N are the whole set" left standing
  // after another write shipped would be just as wrong.
  it('no longer says attachments cannot be uploaded, because they can', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/Uploading attachments/i)).toBeNull();
    expect(screen.queryByText(/those two are the whole set/i)).toBeNull();
    expect(screen.queryByText(/those three are the whole set/i)).toBeNull();
    expect(screen.queryByText(/those four are the whole set/i)).toBeNull();
    expect(screen.queryByText(/those five are the whole set/i)).toBeNull();
  });

  // What is still genuinely missing stays listed. Removing one true entry
  // from this list must not turn into quietly emptying it.
  it('still says plainly what is not built', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(screen.getByText(/Tables and panels/i)).toBeInTheDocument();
    expect(screen.getByText(/real inline image/i)).toBeInTheDocument();
    expect(screen.getByText(/Background sync/i)).toBeInTheDocument();
    expect(screen.getByText(/Creating issues/i)).toBeInTheDocument();
  });

  // This bullet used to say "the approval rail exists, but nothing generates
  // a proposal from your checkout yet" — false on both halves the moment
  // proposeCommentHandler/proposeJiraTransition shipped and the rail itself
  // was removed in favor of CopilotProposalCard. This pins the corrected
  // claim (only comment/state-change proposals reach Jira) so a future write
  // that lands here has to update this bullet in the same commit, the same
  // rule the two tests above already enforce for the rest of the list.
  it('no longer claims Copilot cannot propose against Jira at all', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(screen.queryByText(/approval rail exists/i)).toBeNull();
    expect(screen.queryByText(/nothing generates a proposal/i)).toBeNull();
    expect(
      screen.getByText(
        /only a comment or moving a ticket through its workflow/i,
      ),
    ).toBeInTheDocument();
  });

  // Comment formatting and emoji shipped in the same feature as the
  // @-mention picker -- this list must not still claim comments are
  // "plain text apart from an @-mention" once bold/italic/lists/etc. work.
  it('no longer claims comments are plain text apart from mentions', () => {
    renderPanel(<JiraConnectionPanel connection={status()} />);

    expect(
      screen.queryByText(/plain text apart from an @-mention/i),
    ).toBeNull();
  });

  it('Refresh now calls refreshJiraSync and pushes the result into jiraStore', async () => {
    const refreshed = status({ lastSyncAt: '2026-01-01T00:05:00.000Z' });
    jest.mocked(refreshJiraSync).mockResolvedValue(refreshed);
    renderPanel(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    await waitFor(() =>
      expect(setJiraConnection).toHaveBeenCalledWith(refreshed),
    );
  });

  it('Disconnect genuinely calls disconnectJira and pushes the re-read status into jiraStore', async () => {
    jest.mocked(disconnectJira).mockResolvedValue(undefined);
    jest
      .mocked(getJiraConnectionStatus)
      .mockResolvedValue(status({ connected: false }));
    renderPanel(<JiraConnectionPanel connection={status()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnectJira).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(setJiraConnection).toHaveBeenCalledWith(
        expect.objectContaining({ connected: false }),
      ),
    );
  });

  it('disables Refresh once disconnected, but keeps Disconnect enabled', () => {
    renderPanel(
      <JiraConnectionPanel connection={status({ connected: false })} />,
    );

    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeDisabled();
    // A credential flagged invalid after a 401 (ROAD-16) reports
    // connected: false while the dead token is still on disk — Disconnect
    // is the only control that removes it, so gating it the same way
    // Refresh is gated would make that token permanently undeletable.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('still calls disconnectJira when clicked while already disconnected', async () => {
    jest.mocked(disconnectJira).mockResolvedValue(undefined);
    jest
      .mocked(getJiraConnectionStatus)
      .mockResolvedValue(status({ connected: false }));
    renderPanel(
      <JiraConnectionPanel connection={status({ connected: false })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(disconnectJira).toHaveBeenCalledTimes(1));
  });

  // Disconnect deletes the stored token immediately with no undo, so it
  // gets the same confirm() guard as every other irreversible action in
  // this app (ProjectsList's archiveConfirmMessage).
  describe('Disconnect confirmation', () => {
    it('asks before disconnecting, naming the account being disconnected', () => {
      renderPanel(<JiraConnectionPanel connection={status()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

      expect(window.confirm).toHaveBeenCalledWith(
        disconnectJiraConfirmMessage('max@northwind.dev'),
      );
    });

    it('does not disconnect when the confirmation is cancelled', () => {
      jest.mocked(window.confirm).mockReturnValue(false);
      renderPanel(<JiraConnectionPanel connection={status()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

      expect(disconnectJira).not.toHaveBeenCalled();
      expect(setJiraConnection).not.toHaveBeenCalled();
    });
  });

  // The header used to render `{accountEmail} · {site}` unconditionally —
  // both collapse to '' once disconnected, leaving a bare " · " with no way
  // back into the app.
  describe('Connect CTA', () => {
    it('shows a real Connect action instead of a bare separator once disconnected', () => {
      renderPanel(
        <JiraConnectionPanel connection={status({ connected: false })} />,
      );

      expect(screen.queryByText('·')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Connect to Jira' }),
      ).toBeInTheDocument();
    });

    it('does not show the Connect action while already connected', () => {
      renderPanel(<JiraConnectionPanel connection={status()} />);

      expect(
        screen.queryByRole('button', { name: 'Connect to Jira' }),
      ).not.toBeInTheDocument();
    });

    it('opens the same connect wizard All-Projects uses, on click', () => {
      renderPanel(
        <JiraConnectionPanel connection={status({ connected: false })} />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Connect to Jira' }));

      expect(screen.getByText('Add project')).toBeInTheDocument();
      expect(connectJira).not.toHaveBeenCalled();
    });
  });
});
