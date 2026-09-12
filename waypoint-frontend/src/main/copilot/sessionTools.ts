import { z } from 'zod';
import { RUN_INTENTS, type RunIntent } from '../engine/types';
import {
  TICKET_IDENTIFIER,
  assertRunId,
  type AgentRun,
  type LedgerClient,
  type LedgerTicket,
} from '../engine/runs/ledgerClient';
import type { InProcessServerSpec, InProcessToolSpec } from './claudeSdkClient';

/**
 * Copilot's two session tools — W5a, ROAD-121 (docs/design/w5a-investigate-fix.md
 * §1.2, §1.8, §2.6, §3.4). In main, beside the ledger and the engine,
 * as an in-process MCP server on the Agent SDK's own transport
 * (claudeSdkClient.ts `createInProcessMcpServer`).
 *
 *  - `dispatch_session` never starts anything. It resolves the ticket the
 *    model named and hands the renderer a *session offer* — the three
 *    verbs as buttons in the conversation (`copilot:session-offer`). The
 *    person picks one, sees the brief, presses Start. The model is told
 *    exactly that, so it does not claim a session is running.
 *  - `get_run` is a read: a run's facts from the ledger and, once
 *    finished, the closing message it filed (the run's comment proposal),
 *    so "what was the problem?" is answered without touching the session.
 *
 * The specs are plain data with handlers, so the tests exercise them
 * without the SDK; the server is built from them per Copilot turn.
 */

export const SESSION_TOOLS_SERVER = 'waypoint_sessions';
export const SESSION_TOOL_NAMES = [
  `mcp__${SESSION_TOOLS_SERVER}__dispatch_session`,
  `mcp__${SESSION_TOOLS_SERVER}__get_run`,
] as const;

/** What the renderer is handed: the ticket, and the verb the model leaned to, if any. */
export interface SessionOffer {
  conversationId: string;
  ticketId: string;
  identifier: string;
  title: string;
  intent: RunIntent | null;
  /** The model's note for the brief (a *Something else…* instruction, or a hint for Fix). */
  note: string | null;
}

export interface SessionToolsDeps {
  conversationId: string;
  ledger: Pick<
    LedgerClient,
    | 'getTicket'
    | 'getTicketByIdentifier'
    | 'getRun'
    | 'listAllRuns'
    | 'listTicketProposals'
  >;
  /** Push the offer to the renderer; false when no window is there to take it. */
  offer: (offer: SessionOffer) => boolean;
}

const MAX_NOTE_CHARS = 4_000;

async function resolveTicket(
  ledger: SessionToolsDeps['ledger'],
  ref: string,
): Promise<LedgerTicket> {
  const trimmed = ref.trim();
  const key = trimmed.toUpperCase();
  let ticket: LedgerTicket | null = null;
  // A key (`ROAD-116`) is taken case-insensitively, since people type it;
  // an id has a lowercase prefix (`wi-…`, lib/ids.ts). `road-116` is both
  // shapes, so the key is tried first and the id second — two reads.
  const looksLikeKey = TICKET_IDENTIFIER.test(key);
  const looksLikeId = /^[a-z]+-[A-Za-z0-9]{1,64}$/.test(trimmed);
  if (looksLikeKey) ticket = await ledger.getTicketByIdentifier(key);
  if (!ticket && looksLikeId) ticket = await ledger.getTicket(trimmed);
  if (!looksLikeKey && !looksLikeId) {
    throw new Error(
      `"${trimmed}" is not a ticket key (like ROAD-116) or a ticket id.`,
    );
  }
  if (!ticket) throw new Error(`No ticket ${trimmed}.`);
  return ticket;
}

const INTENT_LABEL: Record<RunIntent, string> = {
  investigate: 'Investigate',
  fix: 'Fix',
  custom: 'Session',
};

function describeRun(run: AgentRun): string {
  const lines = [
    `Run ${run.id} — ${run.title ?? '(untitled)'}`,
    `Status: ${run.status}${run.blockedReason ? ` (${run.blockedReason})` : ''}${run.errorMessage ? ` — ${run.errorMessage}` : ''}`,
    `Intent: ${run.intent ? INTENT_LABEL[run.intent] : 'independent session'}; mode: ${run.modeId ?? 'default'}${run.autoApprove ? ' (auto-approve)' : ''}`,
  ];
  if (run.branch)
    lines.push(
      `Branch: ${run.branch}${run.baseRef ? ` from ${run.baseRef}` : ''}`,
    );
  lines.push(
    `Turns: ${run.turnCount}; started ${run.createdAt}; last change ${run.updatedAt}`,
  );
  if (run.summary) lines.push(`Summary: ${run.summary}`);
  return lines.join('\n');
}

const MAX_CLOSING_CHARS = 8_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildSessionToolSpecs(
  deps: SessionToolsDeps,
): InProcessToolSpec[] {
  return [
    {
      name: 'dispatch_session',
      description:
        'Offer the person a coding session on a ticket: Investigate (find the root cause, change nothing), Fix (implement it on a branch), or their own instruction. This does NOT start anything — it shows the person the three options in this conversation; they pick one, review the brief, and press Start. Use it when the person wants a session, an RCA, an investigation, or a fix on a ticket. Pass the ticket key (e.g. ROAD-116).',
      input: {
        ticket: z
          .string()
          .min(1)
          .max(80)
          .describe('The ticket key (ROAD-116) or id'),
        intent: z
          .enum(RUN_INTENTS as [RunIntent, ...RunIntent[]])
          .optional()
          .describe(
            'The verb the person asked for, if they said: investigate, fix, or custom',
          ),
        note: z
          .string()
          .max(MAX_NOTE_CHARS)
          .optional()
          .describe(
            'For custom: the instruction. For fix: a short note to include in the brief.',
          ),
      },
      async handler(args) {
        const ticket = await resolveTicket(
          deps.ledger,
          String(args.ticket ?? ''),
        );
        const intent =
          typeof args.intent === 'string' &&
          (RUN_INTENTS as readonly string[]).includes(args.intent)
            ? (args.intent as RunIntent)
            : null;
        const note =
          typeof args.note === 'string' && args.note.trim()
            ? args.note.trim()
            : null;
        const shown = deps.offer({
          conversationId: deps.conversationId,
          ticketId: ticket.id,
          identifier: ticket.identifier,
          title: ticket.title,
          intent,
          note,
        });
        if (!shown) {
          throw new Error(
            'Waypoint could not show the session options (no window). Ask the person to open the ticket and use Investigate or Fix there.',
          );
        }
        return [
          `Waypoint is showing the person the session options for ${ticket.identifier} (${ticket.title}) in this conversation: Investigate, Fix, Something else.`,
          intent
            ? `You suggested ${INTENT_LABEL[intent]}; that button is highlighted.`
            : '',
          'Nothing has started. They will review the brief and press Start themselves; when the run finishes, a note arrives in this conversation. Do not say a session is running.',
        ]
          .filter(Boolean)
          .join(' ');
      },
    },
    {
      name: 'get_run',
      description:
        "Read what a session (run) did: its status, intent, branch, and — once finished — the closing message it filed for review. Pass a run id, or a ticket key to get that ticket's runs, newest first.",
      input: {
        run_id: z.string().optional().describe('A run id (run-…)'),
        ticket: z
          .string()
          .optional()
          .describe('A ticket key (ROAD-116) — all of its runs'),
      },
      async handler(args) {
        let runs: AgentRun[];
        if (typeof args.run_id === 'string' && args.run_id.trim()) {
          const id = args.run_id.trim();
          assertRunId(id);
          const run = await deps.ledger.getRun(id);
          if (!run) throw new Error(`No run ${id}.`);
          runs = [run];
        } else if (typeof args.ticket === 'string' && args.ticket.trim()) {
          const ticket = await resolveTicket(deps.ledger, args.ticket);
          runs = (await deps.ledger.listAllRuns({ ticketId: ticket.id })).sort(
            (a, b) => b.createdAt.localeCompare(a.createdAt),
          );
          if (runs.length === 0) return `${ticket.identifier} has no runs yet.`;
        } else {
          throw new Error('Pass run_id or ticket.');
        }
        const ticketIds = [
          ...new Set(
            runs.map((r) => r.ticketId).filter((t): t is string => !!t),
          ),
        ];
        const proposals = (
          await Promise.all(
            ticketIds.map((t) => deps.ledger.listTicketProposals(t)),
          )
        ).flat();
        return runs
          .map((run) => {
            const filed = proposals.filter((p) => p.agentRunId === run.id);
            const closing = filed.find((p) => p.kind === 'comment');
            const parts = [describeRun(run)];
            if (filed.length) {
              parts.push(
                `Filed: ${filed.map((p) => `${p.kind} (${p.status})`).join(', ')}`,
              );
            }
            if (closing && typeof closing.payload.body === 'string') {
              parts.push(
                `Closing message:\n${clip(closing.payload.body, MAX_CLOSING_CHARS)}`,
              );
            }
            return parts.join('\n');
          })
          .join('\n\n---\n\n');
      },
    },
  ];
}

/** The server spec claudeSdkClient.ts builds on the loaded SDK, per turn. */
export function sessionToolsServer(
  deps: SessionToolsDeps,
): InProcessServerSpec {
  return {
    name: SESSION_TOOLS_SERVER,
    instructions:
      'Waypoint coding sessions: offer one on a ticket (dispatch_session — the person starts it), and read what a session did (get_run).',
    tools: buildSessionToolSpecs(deps),
  };
}
