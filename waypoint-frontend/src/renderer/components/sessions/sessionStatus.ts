import type { AgentRun, AgentRunStatus } from '@/types/agentRuns';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * The ten `agent_run_status` values, each as the panel shows it — one
 * table for the list row's dot, the header's pill and the drawer's chip,
 * so the three can never disagree (W3, docs/design/w3-sessions-rail.md
 * §1). What each status *means* is documented once, on the backend's
 * db/schema/agentRuns.ts; the sentence here is that meaning in the
 * user's terms, and only claims what the status itself supports.
 */
export interface StatusView {
  label: string;
  tone: BadgeTone;
  /** Rendered as an outline chip: a state that has stopped without success or failure. */
  outline?: boolean;
  /** Tailwind background class for the list row's dot. */
  dotClass: string;
  sentence: string;
  /** The daemon should have a live session for it: the transcript can move, the composer can send. */
  live: boolean;
  /** Stop makes sense: the run can still be cancelled (runStatusMachine.ts). */
  stoppable: boolean;
}

export const STATUS_VIEW: Record<AgentRunStatus, StatusView> = {
  queued: {
    label: 'Queued',
    tone: 'neutral',
    dotClass: 'bg-text-muted',
    sentence: 'Asked for; nothing has started yet.',
    live: false,
    stoppable: true,
  },
  provisioning: {
    label: 'Provisioning',
    tone: 'info',
    dotClass: 'bg-info',
    sentence: 'Creating the worktree and starting the session.',
    live: false,
    stoppable: true,
  },
  running: {
    label: 'Running',
    tone: 'info',
    dotClass: 'bg-info',
    sentence: 'The agent is working.',
    live: true,
    stoppable: true,
  },
  blocked: {
    label: 'Blocked',
    tone: 'warning',
    dotClass: 'bg-warning',
    sentence: 'Waiting on you.',
    live: true,
    stoppable: true,
  },
  finishing: {
    label: 'Finishing',
    tone: 'info',
    dotClass: 'bg-info',
    sentence: 'The agent is done; pushing and proposing.',
    live: true,
    stoppable: true,
  },
  'needs-review': {
    label: 'Needs review',
    tone: 'warning',
    dotClass: 'bg-warning',
    sentence: 'Proposals are waiting for your decision in Review.',
    live: false,
    stoppable: false,
  },
  done: {
    label: 'Done',
    tone: 'success',
    dotClass: 'bg-success',
    sentence: 'Finished.',
    live: false,
    stoppable: false,
  },
  interrupted: {
    label: 'Interrupted',
    tone: 'neutral',
    outline: true,
    dotClass: 'bg-border-strong',
    sentence:
      'The engine or Waypoint went away mid-run; the worktree is still there.',
    live: false,
    stoppable: true,
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    dotClass: 'bg-danger',
    sentence: 'Ended with an error.',
    live: false,
    stoppable: false,
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    outline: true,
    dotClass: 'bg-border-strong',
    sentence: 'Stopped by a person.',
    live: false,
    stoppable: false,
  },
};

export function statusView(status: AgentRunStatus): StatusView {
  return STATUS_VIEW[status];
}

/** `run-abc1234` → `abc1234`, for a title of last resort. */
export function shortRunId(runId: string): string {
  const dash = runId.indexOf('-');
  return dash === -1 ? runId : runId.slice(dash + 1);
}

/**
 * The provider's display name and a one-letter chip. The ledger stores
 * emdash's provider ids; the names below are the plugin manifests' own
 * (emdash packages/plugins/src/agents/impl/<id>/index.ts at 9b102a5f3).
 * Anything else shows its id — a name the panel cannot vouch for is not
 * invented.
 */
const PROVIDER_NAMES: Record<string, { name: string; chipClass: string }> = {
  claude: { name: 'Claude Code', chipClass: 'bg-[#c96a3e]' },
  codex: { name: 'Codex', chipClass: 'bg-[#3e5fc9]' },
  opencode: { name: 'OpenCode', chipClass: 'bg-[#2f7d5a]' },
  cursor: { name: 'Cursor', chipClass: 'bg-[#4b4b55]' },
  copilot: { name: 'GitHub Copilot', chipClass: 'bg-[#5b46c9]' },
  amp: { name: 'Amp', chipClass: 'bg-[#b0442e]' },
};

export function providerView(providerId: string): {
  name: string;
  letter: string;
  chipClass: string;
} {
  const known = PROVIDER_NAMES[providerId];
  const name = known?.name ?? providerId;
  return {
    name,
    letter: name.charAt(0).toUpperCase() || '?',
    chipClass: known?.chipClass ?? 'bg-text-muted',
  };
}

/**
 * What the row's third line says for a run that is waiting on the user:
 * the ledger's own reason for a blocked run (written by main's live
 * follower from the pending tool call), or the fixed sentence for a run
 * whose proposals await a decision. Nothing for the other statuses.
 */
export function waitingReason(run: AgentRun): string | null {
  if (run.status === 'blocked')
    return run.blockedReason ?? 'Waiting for your permission';
  if (run.status === 'needs-review') return 'Proposals need your review';
  return null;
}

/**
 * The title a row and a header show. The ledger keeps no title of its own
 * (a run is a ticket, a branch, an id); a dispatched run is named by its
 * ticket (resolved by the caller, `ticketLabel`), an independent one by
 * its branch, and a run that has neither yet by its id.
 */
/** The last segment of a path, for a run named by its folder. */
export function folderName(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed : trimmed.slice(i + 1) || trimmed;
}

/** `/Users/me/code/x` → `~/code/x` when a home is known; the renderer only shortens what main shows. */
export function shortenHome(absolute: string, home: string | null): string {
  if (!home) return absolute;
  if (absolute === home) return '~';
  return absolute.startsWith(`${home}/`)
    ? `~${absolute.slice(home.length)}`
    : absolute;
}

/** Ticket label → the title the user gave it (W4) → branch → the folder (W4b) → the id. */
export function runTitle(run: AgentRun, ticketLabel?: string | null): string {
  if (ticketLabel) return ticketLabel;
  if (run.title) return run.title;
  if (run.branch) return run.branch;
  if (run.isolation === 'directory' && run.cwd) return folderName(run.cwd);
  return `Session ${shortRunId(run.id)}`;
}

/**
 * Where the agent works, as one line (W4b): a worktree run is its branch
 * (from its base), a direct run is its folder. Null while nothing is
 * known yet (queued, provisioning without a folder).
 */
export function runWhere(
  run: AgentRun,
  home: string | null = null,
):
  | { kind: 'branch'; branch: string; baseRef: string | null }
  | { kind: 'folder'; path: string }
  | null {
  if (run.isolation === 'directory') {
    return run.cwd
      ? { kind: 'folder', path: shortenHome(run.cwd, home) }
      : null;
  }
  if (run.branch)
    return { kind: 'branch', branch: run.branch, baseRef: run.baseRef };
  return null;
}
