const TITLE_MAX_LENGTH = 60;

// Matches copilot_conversations.title's own schema default — a message that's
// pure whitespace produces no better a title than not having one at all.
export const DEFAULT_CONVERSATION_TITLE = 'New session';

// Ported from the frontend's former client-side copilotSessions.ts version
// (issue #11's backend migration) — a conversation's auto-title, derived
// from its first user message: single-lined and truncated so a long or
// multi-line message can't blow out the session-list row.
export function truncateTitle(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return DEFAULT_CONVERSATION_TITLE;
  if (singleLine.length <= TITLE_MAX_LENGTH) return singleLine;
  return `${singleLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}
