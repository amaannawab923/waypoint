import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getJiraTicketByKey } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { JiraTicketDetail } from '@/components/domain/JiraTicketDetail';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { JiraApiError } from '@/types/jira';
import type { JiraTicket } from '@/types/jira';

/**
 * The expanded view of one Jira issue, at /my-jira/:ticketKey — where the
 * drawer's expand button lands, mirroring the native ticket's own
 * drawer→/projects/:projectId/tickets/:identifier jump.
 *
 * ROAD-158: used to resolve the issue by re-running the "my work" list query
 * and finding the key in it — cheap when arriving from that one list, but it
 * meant a key surfaced by any OTHER read (My past tickets, Viewed, a
 * resolved Worked-on issue) 404'd here even though this app had just shown
 * it to the user seconds earlier. Fetches the one issue directly by key
 * instead (the same function CopilotPanel already uses for a key the model
 * cites), so this page answers "does this issue exist and can you see it",
 * not "was it in the one query this page used to run".
 */
export default function JiraTicketPage() {
  const { ticketKey } = useParams<{ ticketKey: string }>();
  const [ticket, setTicket] = useState<JiraTicket | null>(null);

  const {
    data,
    loading,
    error,
    reload,
  } = useAsync(
    () => (ticketKey ? getJiraTicketByKey(ticketKey) : Promise.resolve(null)),
    [ticketKey],
  );

  useEffect(() => {
    setTicket(data ?? null);
  }, [data]);

  // Jira answering "no such issue" (or "not visible to you", which Jira
  // itself does not distinguish from not existing) is a normal, expected
  // outcome here — not a load failure. Every other reason getJiraTicketByKey
  // can fail (network, credentials, a genuine Jira outage) still goes
  // through JiraLoadError below.
  const notFound = error instanceof JiraApiError && error.reason === 'not_found';

  if (error && !notFound) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <JiraLoadError what="this Jira issue" error={error} onRetry={reload} />
      </div>
    );
  }

  if (loading && !ticket) {
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
          {ticketKey} isn&apos;t here
        </h1>
        <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
          Jira didn&apos;t return an issue for that key — it may not exist, or
          it may not be visible to your account.
        </p>
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
