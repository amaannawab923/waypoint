import type {
  AgentRun,
  AgentRunStatus,
  PendingPromptReason,
} from '@/types/agentRuns';
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
  /**
   * The daemon should have a live session for it: the transcript can
   * move. Never a gate on the composer — every status can be messaged
   * (never-lock, 2026-09-20); main resumes, continues, or outboxes as the
   * status needs.
   */
  live: boolean;
  /** Stop makes sense: the run can still be cancelled (runStatusMachine.ts). */
  stoppable: boolean;
}

export const STATUS_VIEW: Record<AgentRunStatus, StatusView> = {
  queued: {
    label: 'Queued',
    tone: 'neutral',
    dotClass: 'bg-text-muted',
    sentence:
      'Asked for; nothing has started yet. A message you send now goes with it.',
    live: false,
    stoppable: true,
  },
  provisioning: {
    label: 'Provisioning',
    tone: 'info',
    dotClass: 'bg-info',
    sentence:
      'Creating the worktree and starting the session. A message you send now goes with it.',
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
    sentence: "Filing the run's report; a message you send now goes next.",
    live: true,
    stoppable: true,
  },
  'needs-review': {
    label: 'Needs review',
    tone: 'warning',
    dotClass: 'bg-warning',
    sentence:
      'Proposals are waiting for your decision in Review. Message it to continue.',
    live: false,
    stoppable: false,
  },
  done: {
    label: 'Done',
    tone: 'success',
    dotClass: 'bg-success',
    sentence: 'Finished. Message it to continue.',
    live: false,
    stoppable: false,
  },
  interrupted: {
    label: 'Interrupted',
    tone: 'neutral',
    outline: true,
    dotClass: 'bg-border-strong',
    sentence:
      'The engine or Waypoint went away mid-run. Message it to continue.',
    live: false,
    stoppable: true,
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    dotClass: 'bg-danger',
    sentence: 'Ended with an error. Message it to continue.',
    live: false,
    stoppable: false,
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    outline: true,
    dotClass: 'bg-border-strong',
    sentence: 'Stopped by a person. Message it to continue.',
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

/**
 * The title the run carries (W4's own, or W5a's "ROAD-116 · Investigate")
 * → the ticket label → branch → the folder (W4b) → the id.
 */
export function runTitle(run: AgentRun, ticketLabel?: string | null): string {
  if (run.title) return run.title;
  if (ticketLabel) return ticketLabel;
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

/**
 * What to tell the person when a resume had to recreate the run's
 * worktree (ROAD-XXX) — one sentence, shared by the composer's send and
 * the Resume button so the two can't drift. `branchReused` is the only
 * distinction that changes what actually survived.
 */
export function worktreeRecreatedNotice(branchReused: boolean): string {
  return branchReused
    ? "This run's worktree had been removed; Waypoint recreated it from its branch. Committed work is intact, but any uncommitted changes from before are gone."
    : "This run's worktree and its branch were both gone; Waypoint recreated a fresh branch from the base. Prior work on this run could not be recovered.";
}

/**
 * Why a message is waiting in the run's outbox rather than with the
 * daemon (never-lock, design §2.4), and when Waypoint sends it — the
 * pending row's second line. Never a refusal: the text has left the box.
 */
export function pendingReasonSentence(
  reason: PendingPromptReason,
  detail: {
    cwd?: string | null;
    lastError?: string | null;
    ownerName?: string | null;
  } = {},
): string {
  switch (reason) {
    case 'starting':
      return 'Waiting to send — the session is starting. Waypoint sends it as soon as the session is up.';
    case 'finishing':
      return "Waiting to send — Waypoint is filing the run's report; your message goes next.";
    case 'folder-missing':
      return `Waiting to send — this run's folder is not on disk${detail.cwd ? ` at ${detail.cwd}` : ''}. Put it back and press Resend, or reopen this pane.`;
    case 'repository-missing':
      return "Waiting to send — the project's repository is not linked. Link it in project settings, then press Resend.";
    case 'spawn-failed':
      return `Waiting to send — the agent could not be started${detail.lastError ? ` (${detail.lastError})` : ''}. Waypoint retries when you send again, or press Resend.`;
    case 'owner-offline':
      return `Queued for ${detail.ownerName ?? 'the run owner'}'s Waypoint; it is sent when they are online.`;
    case 'blocked-by-earlier':
      return 'Waiting to send — behind an earlier message in this run’s outbox. Waypoint sends it right after.';
    // B4 (PR #88 review): unlike every other reason above, this one
    // never clears on its own — Close run already deleted the worktree
    // and branch on purpose, so there is nothing left to recreate and no
    // "press Resend" that could ever work.
    case 'closed':
      return "This run's worktree and branch were removed with Close run. Start a new session to continue this work.";
    default:
      return 'Waiting to send.';
  }
}

/** What a dispatched run was asked to do, as the chip says it (W5a). */
export function intentView(
  run: Pick<AgentRun, 'intent' | 'modeId' | 'autoApprove' | 'entry'>,
): {
  verb: string;
  /** `plan` for a reading session; `auto` for an unattended writing one; null for a writing one that asks. */
  mode: 'plan' | 'auto' | null;
  /** Hover text for the chip — what the verb and the mode mean (feedback round 1, Fix 6). */
  title: string;
  /** A ticket verb (Fix, Investigate) or a plain session with none — drawn quieter so an empty-looking chip reads as intentional. */
  plain: boolean;
} | null {
  if (run.entry !== 'dispatched') return null;
  const verb =
    run.intent === 'investigate'
      ? 'Investigate'
      : run.intent === 'fix'
        ? 'Fix'
        : 'Session';
  const mode = run.modeId === 'plan' ? 'plan' : run.autoApprove ? 'auto' : null;
  return {
    verb,
    mode,
    title: intentTitle(verb, mode),
    plain: verb === 'Session',
  };
}

export const MODE_TITLES = {
  plan: 'Plan mode — reads and reports. Changes nothing.',
  auto: 'Auto-approve — the agent works without asking; nothing pauses mid-run for your approval.',
} as const;

function intentTitle(verb: string, mode: 'plan' | 'auto' | null): string {
  const what =
    verb === 'Investigate'
      ? 'Investigate — find the root cause and report; dispatched from a ticket.'
      : verb === 'Fix'
        ? 'Fix — change the code on a branch and report; dispatched from a ticket.'
        : 'An independent session — not dispatched from a ticket, so it has no Fix/Investigate mode to show.';
  return mode ? `${what} ${MODE_TITLES[mode]}` : what;
}
