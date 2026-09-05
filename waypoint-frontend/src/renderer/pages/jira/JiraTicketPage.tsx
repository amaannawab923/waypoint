import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listMyJiraTickets } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketDetail } from '@/components/domain/JiraTicketDetail';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTicket } from '@/types/jira';

/**
 * The expanded view of one Jira issue, at /my-jira/:ticketKey — where the
 * drawer's expand button lands, mirroring the native ticket's own
 * drawer→/projects/:projectId/tickets/:identifier jump.
 *
 * Reads the issue out of the same "my work" query the list runs rather than
 * fetching one issue by key: that query is already cached in jiraApi's
 * module-level `lastTickets`, so arriving here from the drawer costs no
 * network call at all, and arriving cold (a reload, a pasted link) runs the
 * one query this whole feature is built around instead of introducing a
 * second read path for the same data.
 *
 * The consequence is worth naming rather than hiding: an issue outside your
 * own queue can't be opened here. That is the same boundary My Jira draws
 * everywhere else — it is "your work", not a general issue browser — and
 * the empty state says so and offers Jira itself instead of pretending the
 * issue doesn't exist.
 */
export default function JiraTicketPage() {
  const { ticketKey } = useParams<{ ticketKey: string }>();
  const [ticket, setTicket] = useState<JiraTicket | null>(null);

  const {
    data: read,
    loading,
    error,
    reload,
  } = useAsync(() => listMyJiraTickets(), []);

  useEffect(() => {
    if (!read || !ticketKey) return;
    setTicket(read.tickets.find((t) => t.key === ticketKey) ?? null);
  }, [read, ticketKey]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <JiraLoadError what="this Jira issue" error={error} onRetry={reload} />
      </div>
    );
  }

  if (loading && !read) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <SkeletonListRows />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="font-display text-[19px] font-semibold text-text">
          {ticketKey} isn&apos;t in your queue
        </h1>
        {/* Two genuinely different reasons an issue isn't here, and saying
            the first one when the second is true would be a flat lie. The
            page finds its issue in the "my work" read; when that read hit the
            page cap, "it isn't one of those" is a claim about a set this app
            never finished looking at. The distinction is exactly what
            `truncated` exists to make sayable. */}
        {read?.truncated ? (
          <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
            Jira had more issues than this app reads in one go, so we only
            looked at the first few hundred, most recently updated. This issue
            may well be yours and simply fell outside them — open it in Jira to
            see it in full.
          </p>
        ) : (
          <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
            My Jira shows what you&apos;re assigned, reported or watching. This
            issue either isn&apos;t one of those, or it&apos;s already resolved
            — open it in Jira to see it in full.
          </p>
        )}
        <Link
          to="/my-jira"
          className="mt-4 inline-block text-[13px] font-semibold text-accent hover:underline"
        >
          ← Back to My Jira
        </Link>
      </div>
    );
  }

  return (
    <JiraTicketDetail
      ticket={ticket}
      variant="page"
      onTicketUpdated={(updated) => setTicket(updated)}
    />
  );
}
