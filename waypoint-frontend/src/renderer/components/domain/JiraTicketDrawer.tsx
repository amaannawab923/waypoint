import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listJiraComments } from '@/data/jiraApi';
import { useAsync } from '@/lib/useAsync';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconX } from '@/components/icons';
import { JiraCommentComposer } from '@/components/domain/JiraCommentComposer';
import { JIRA_PROJECT_COLOR } from '@/types/jira';
import type { JiraComment, JiraTicket } from '@/types/jira';

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 45) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return 'a while ago';
}

/**
 * Right-side "peek" panel for one Jira ticket — structurally the same
 * portal/backdrop/ESC-to-close convention as components/domain/TicketDrawer.tsx
 * (docked right, slides in), not a byte-for-byte port: this one is
 * self-contained (it takes the ticket object it already has, rather than a
 * projectId/identifier pair to refetch by).
 */
export function JiraTicketDrawer({
  ticket,
  onClose,
}: {
  ticket: JiraTicket;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [comments, setComments] = useState<JiraComment[]>([]);

  const { data: fetchedComments } = useAsync(
    () => listJiraComments(ticket.id),
    [ticket.id],
  );
  useEffect(() => {
    if (fetchedComments) setComments(fetchedComments);
  }, [fetchedComments]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const projectColor = JIRA_PROJECT_COLOR[ticket.projectKey];

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className="thin-scroll absolute inset-y-0 right-0 flex h-full w-full max-w-[460px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
        style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span
            className="font-mono text-xs font-bold"
            style={{ color: projectColor }}
          >
            {ticket.key}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold text-text">
            <span
              className="size-[7px] shrink-0 rounded-full"
              style={{ background: ticket.stateColor }}
            />
            {ticket.stateName}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled
            title="Opening a ticket in Jira isn't wired up yet."
          >
            Open in Jira ↗
          </Button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto px-4 py-4">
          <h3 className="mb-2.5 font-display text-[15px] leading-snug font-semibold text-text">
            {ticket.title}
          </h3>

          <div className="mb-3.5 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
              Assignee · {ticket.assigneeName}
            </span>
            <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
              Reporter · {ticket.reporterName}
            </span>
            {ticket.epicName && (
              <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                Epic · {ticket.epicName}
              </span>
            )}
            {ticket.storyPoints != null && (
              <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                Story points · {ticket.storyPoints}
              </span>
            )}
            {ticket.sprintName && (
              <span className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                Sprint · {ticket.sprintName}
              </span>
            )}
          </div>

          <p className="mb-3.5 text-[12.5px] leading-relaxed text-text-secondary">
            {ticket.description}
          </p>

          {ticket.attachments.map((a) => (
            <div
              key={a.fileName}
              className="mb-4 flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-2.5 py-2 text-[11.5px] text-text-secondary"
            >
              <span className="font-mono text-[11px]">{a.fileName}</span>
              <span>
                · {a.sizeLabel} · {a.uploaderName}
              </span>
              <span className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-muted">
                download in Jira
              </span>
            </div>
          ))}

          <div className="mb-2 text-[11px] font-bold tracking-wide text-text-muted uppercase">
            Comments
          </div>
          <div className="mb-4 space-y-3.5">
            {comments.map((c) => (
              <div key={c.id} className="flex gap-2">
                <Avatar name={c.authorName} size={22} />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-xs">
                    <b className="font-semibold text-text">{c.authorName}</b>{' '}
                    <span className="text-text-muted">
                      {formatRelativeTime(c.createdAt)}
                      {c.postedByWaypoint ? ' · via Waypoint' : ''}
                    </span>
                  </div>
                  {c.disclosureText && (
                    <div className="mb-1 inline-block rounded bg-jira-bg px-1.5 py-0.5 text-[11px] text-jira">
                      {c.disclosureText}
                    </div>
                  )}
                  <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-text-secondary">
                    {c.body}
                  </div>
                </div>
              </div>
            ))}
            {comments.length === 0 && (
              <p className="text-[12.5px] text-text-muted">No comments yet.</p>
            )}
          </div>

          <JiraCommentComposer
            ticketId={ticket.id}
            onPosted={(comment) => setComments((cs) => [...cs, comment])}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
