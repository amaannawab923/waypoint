import { useEffect, useState } from 'react';
import { getJiraTicketRef } from '@/data/engineApi';
import { SESSIONS_ENABLED } from '@/lib/featureFlags';
import { TicketRunsSection } from './TicketRunsSection';

/**
 * A Jira issue's Sessions section — W5b, ROAD-126
 * (docs/design/w5b-jira-dispatch.md §1.1, §2.8). The same three verbs and
 * the same runs list a native ticket has (TicketRunsSection), on the
 * issue's ledger handle: the drawer knows the issue's key and summary,
 * main mints (or refreshes) the `tref-…` handle through the backend with
 * the site from its own stored credential, and everything below is the
 * W5a section on that id. Renders nothing with the feature flag off, and
 * nothing until the handle is known — a section that cannot list runs is
 * not shown half-built. A handle that cannot be minted (the engine
 * unavailable in this window, Jira disconnected between the list and the
 * drawer) leaves the section out rather than showing verbs that would fail.
 */
function JiraSessions({
  issueKey,
  title,
}: {
  issueKey: string;
  title: string;
}) {
  const [ticketId, setTicketId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTicketId(null);
    getJiraTicketRef({ key: issueKey, title })
      .then((ref) => {
        if (!cancelled) setTicketId(ref.ticketId);
        return undefined;
      })
      .catch(() => {
        // Said nowhere: the verbs are not offered on an issue the ledger
        // cannot name; the rest of the drawer is unaffected.
      });
    return () => {
      cancelled = true;
    };
    // The summary only refreshes the cached title; a change to it alone
    // is not worth a second mint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey]);
  if (!ticketId) return null;
  return (
    <div data-jira-sessions={issueKey}>
      <TicketRunsSection ticketId={ticketId} />
    </div>
  );
}

export function JiraSessionsSection({
  issueKey,
  title,
}: {
  /** `ENG-4`. */
  issueKey: string;
  title: string;
}) {
  if (!SESSIONS_ENABLED) return null;
  return <JiraSessions issueKey={issueKey} title={title} />;
}
