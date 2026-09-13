import { Badge } from '@/components/ui/Badge';
import type { AgentRunStatus } from '@/types/agentRuns';
import { statusView } from './sessionStatus';

/** The status as a chip — the header's, the drawer's, the row's on narrow widths. Hover for the sentence. */
export function SessionStatusPill({ status }: { status: AgentRunStatus }) {
  const view = statusView(status);
  return (
    <span title={view.sentence}>
      <Badge tone={view.tone} outline={view.outline}>
        {view.label}
      </Badge>
    </span>
  );
}

/** A 7 px dot in the status's colour, for the list row. */
export function SessionStatusDot({
  status,
  ring,
}: {
  status: AgentRunStatus;
  ring?: boolean;
}) {
  const view = statusView(status);
  return (
    <span
      aria-hidden
      className={`size-[7px] shrink-0 rounded-full ${view.dotClass} ${
        ring ? 'ring-[3px] ring-current/15' : ''
      }`}
    />
  );
}
