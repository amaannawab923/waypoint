import { buildSystemPrompt } from './systemPrompt';

// The policy-parameterised knobs claudeSession.ts's runSession() needs to
// drive one SDK session, kept deliberately narrow: only what genuinely
// varies per caller lives here, while the fixed security boundary
// (REPO_DENYLIST_PATTERNS, the resume-id shape check, the waypoint MCP
// server's own transport) stays hardcoded inside claudeSession.ts, not
// something any policy can flip. See copilotRunner.ts's registerCopilotIpc
// for the one caller today; a future agent-run caller would add a second
// constructor here alongside buildCopilotSessionPolicy.
export interface SessionPolicy {
  /**
   * Absolute path to a linked checkout, or null. This is the raw candidate
   * only — claudeSession.ts's resolveRepoRoot() re-validates it (shape AND
   * live directory existence) on every single attempt, including a
   * stale-session retry, so a checkout that vanishes mid-conversation
   * degrades cleanly instead of this policy's initial guess going stale.
   * Drives cwd, built-in tool grants, and which systemPrompt variant is
   * used — always together, off the one fresh check, never off this field
   * directly.
   */
  repoPath: string | null;
  /** Built-in tools granted when repoLinked. NEVER anything that can write
   * or execute — Bash/Edit/Write/Task/WebFetch/WebSearch. Ignored entirely
   * when the repo isn't linked: claudeSession.ts always grants zero
   * built-ins in that branch regardless of this field. */
  builtinTools: readonly string[];
  /** mcp__waypoint__* names this session may call, granted regardless of
   * repoLinked. */
  mcpTools: readonly string[];
  /** Static headers baked into the waypoint MCP server's config. Scope
   * identity only (e.g. the conversation id) — never a tool input, so the
   * model can never choose or spoof where its proposals land. */
  mcpHeaders: Record<string, string>;
  /** Builds the system prompt for a given repoLinked value. A function,
   * not a precomputed string, for the same reason repoPath above is raw:
   * repoLinked is re-derived fresh per attempt, and the prompt variant must
   * never be able to disagree with the tool grant it's paired with. */
  buildSystemPrompt: (repoLinked: boolean) => string;
  /** Prepended (with a blank line) to the prompt on the FIRST attempt only.
   * A stale-session retry replaces this entirely with its own continuation
   * note (see claudeSession.ts's RETRY_CONTINUATION_NOTE) rather than
   * combining the two — retried session has no proposals of its own yet to
   * report on. */
  promptPreamble?: string;
  resumeSessionId?: string;
  /** Wall-clock ceiling. Copilot: undefined (user can see it hang and
   * retry). A future agent-run caller would set this. Not yet consumed by
   * claudeSession.ts — carried on the type now so a later unit can wire it
   * in without another interface change. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

// The built-in tools a linked repo grants — strictly read-only, and
// deliberately not a superset that grows over time. Bash/Edit/Write/Task/
// WebFetch/WebSearch stay denied in BOTH branches: claudeSession.ts never
// lists them regardless of whether a repo is linked, which is the product
// boundary V3 ships, not a default that a later flag could flip.
const REPO_READ_TOOLS = ['Read', 'Glob', 'Grep'];

// Tools served by waypoint-backend's MCP endpoint (see
// waypoint-backend/src/routes/mcp.routes.ts, src/mcp/ticketTools.ts, and
// src/mcp/proposalTools.ts) — the "mcp__waypoint__*" naming is Claude Code's
// own convention for a tool sourced from an MCP server named "waypoint" in
// claudeSession.ts's mcpServers config. The propose_* entries are safe to
// allow with no interactive approval step precisely because they aren't
// write tools: each one only inserts a proposal row the user must approve
// in the Waypoint UI before the backend executes anything. The approval
// gate that used to be "don't ship write tools at all" lives in the
// product itself, per proposal.
const MCP_TOOLS = [
  'mcp__waypoint__list_tickets',
  'mcp__waypoint__get_ticket',
  'mcp__waypoint__get_ticket_by_identifier',
  'mcp__waypoint__search_tickets',
  'mcp__waypoint__list_comments',
  'mcp__waypoint__list_activity',
  'mcp__waypoint__list_states',
  'mcp__waypoint__list_members',
  'mcp__waypoint__list_projects',
  'mcp__waypoint__propose_comment',
  'mcp__waypoint__propose_state_change',
  'mcp__waypoint__propose_assignee_change',
  'mcp__waypoint__propose_priority_change',
  'mcp__waypoint__propose_create_ticket',
];

// Matches waypoint-backend's newId('conv') shape (and is re-validated
// server-side in mcp.routes.ts). Checked before the id is ever embedded into
// the MCP server config: the conversation id reaches the backend as an HTTP
// header baked into that config, and only a value this tightly shaped is
// safe to embed — anything else (including undefined) simply omits the
// header, which degrades to "proposals unavailable" on the backend rather
// than any kind of failure.
const CONVERSATION_ID_PATTERN = /^conv-[a-z0-9]{4,32}$/i;

function buildMcpHeaders(
  conversationId: string | undefined,
): Record<string, string> {
  return conversationId && CONVERSATION_ID_PATTERN.test(conversationId)
    ? { 'x-waypoint-conversation-id': conversationId }
    : {};
}

export interface CopilotSessionPolicyInput {
  /** Raw candidate from IPC — not yet shape- or existence-checked. */
  repoPath?: string;
  resumeSessionId?: string;
  conversationId?: string;
  /** Already validated (trimmed, length-capped) by copilotRunner.ts before
   * this is called — that validation is about the outcome-preamble IPC
   * field specifically, not a general policy concern. */
  promptPreamble?: string;
}

// The one constructor this unit builds — for the Copilot panel's IPC
// handler. A future agent-run caller (§5.3, not this unit) would add a
// second constructor alongside this one, building a SessionPolicy with its
// own mcpTools/builtinTools/systemPrompt and a required timeoutMs.
export function buildCopilotSessionPolicy(
  input: CopilotSessionPolicyInput,
): SessionPolicy {
  return {
    repoPath: input.repoPath ?? null,
    builtinTools: REPO_READ_TOOLS,
    mcpTools: MCP_TOOLS,
    mcpHeaders: buildMcpHeaders(input.conversationId),
    buildSystemPrompt,
    promptPreamble: input.promptPreamble,
    resumeSessionId: input.resumeSessionId,
  };
}
