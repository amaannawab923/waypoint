import type { RunIntent } from '@/types/agentRuns';

/**
 * Copilot's slash commands — W5a, ROAD-121 (docs/design/w5a-investigate-fix.md
 * §1.2). Deterministic: a slash command opens the brief preview directly,
 * no model in the loop. Pure so the composer's menu and the send path are
 * unit-tested without rendering.
 *
 *   /investigate KEY          — plan mode, find the root cause
 *   /fix KEY [note]           — a writing session; the note goes in the brief
 *   /session KEY <text>       — the person's own instruction (Something else…)
 */
export interface SlashCommand {
  name: 'investigate' | 'fix' | 'session';
  intent: RunIntent;
  /** The line the menu shows. */
  usage: string;
  hint: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'investigate',
    intent: 'investigate',
    usage: '/investigate KEY',
    hint: 'Find the root cause in a fresh worktree; changes nothing',
  },
  {
    name: 'fix',
    intent: 'fix',
    usage: '/fix KEY [note]',
    hint: 'Implement the fix on a branch in a fresh worktree',
  },
  {
    name: 'session',
    intent: 'custom',
    usage: '/session KEY what to do',
    hint: 'Your own instruction on the ticket',
  },
];

/** `ROAD-116`, typed in any case. */
const KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;

export interface ParsedSlash {
  command: SlashCommand;
  /** Upper-cased. */
  key: string;
  /** The rest of the line, trimmed; empty when none. */
  text: string;
}

export type SlashParse =
  | { kind: 'not-slash' }
  /** Starts with `/` but is not (yet) a complete command: the menu shows what would complete it. */
  | { kind: 'incomplete'; typed: string; reason: string }
  | { kind: 'command'; parsed: ParsedSlash };

export function parseSlash(input: string): SlashParse {
  const value = input.replace(/^\s+/, '');
  if (!value.startsWith('/')) return { kind: 'not-slash' };
  const [word, ...rest] = value.slice(1).split(/\s+/);
  const name = (word ?? '').toLowerCase();
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  if (!command) {
    return {
      kind: 'incomplete',
      typed: name,
      reason: name ? `No command /${name}` : 'Pick a command',
    };
  }
  const key = rest[0] ?? '';
  if (!KEY.test(key)) {
    return {
      kind: 'incomplete',
      typed: name,
      reason: key
        ? `${key} is not a ticket key`
        : 'Add the ticket key (ROAD-116)',
    };
  }
  const text = rest.slice(1).join(' ').trim();
  if (command.intent === 'custom' && !text) {
    return {
      kind: 'incomplete',
      typed: name,
      reason: 'Say what the session should do',
    };
  }
  return {
    kind: 'command',
    parsed: { command, key: key.toUpperCase(), text },
  };
}

/** The commands whose name starts with what was typed after the slash. */
export function matchingCommands(typed: string): SlashCommand[] {
  const t = typed.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(t));
}

/** Ticket keys (with titles) that start with the partial key being typed, most recent first as given. */
export function matchingKeys(
  partial: string,
  tickets: ReadonlyArray<{ identifier: string; title: string }>,
  limit = 6,
): Array<{ identifier: string; title: string }> {
  const p = partial.toUpperCase();
  return tickets
    .filter((t) => t.identifier.toUpperCase().startsWith(p))
    .slice(0, limit);
}

/**
 * Where the composer's caret is in the command: after the slash word
 * (completing the command) or in the key (completing the ticket).
 */
export function slashCompletionStage(
  input: string,
):
  { stage: 'command'; typed: string } | { stage: 'key'; typed: string } | null {
  const value = input.replace(/^\s+/, '');
  if (!value.startsWith('/')) return null;
  const parts = value.slice(1).split(/\s+/);
  if (parts.length === 1) return { stage: 'command', typed: parts[0] };
  if (
    parts.length === 2 &&
    SLASH_COMMANDS.some((c) => c.name === parts[0].toLowerCase())
  ) {
    return { stage: 'key', typed: parts[1] };
  }
  return null;
}
