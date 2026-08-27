// Parses one line of `claude -p ... --output-format stream-json` output.
// Pure and side-effect-free on purpose: this is the part of the Copilot
// subprocess integration that's meaningfully unit-testable without spawning
// a real process (see copilotRunner.ts, which owns the actual spawn/stdout
// buffering and stays thin specifically so this file can carry the parsing
// logic instead).
export type ParsedStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'result'; fullText: string; sessionId: string | null }
  | { kind: 'auth_error'; message: string }
  | { kind: 'ignored' };

export function parseStreamEventLine(line: string): ParsedStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignored' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'ignored' };
  }

  if (typeof parsed !== 'object' || parsed === null) return { kind: 'ignored' };
  const event = parsed as Record<string, unknown>;

  if (
    event.type === 'system' &&
    event.subtype === 'init' &&
    typeof event.session_id === 'string'
  ) {
    return { kind: 'session', sessionId: event.session_id };
  }

  if (
    event.type === 'system' &&
    event.subtype === 'api_retry' &&
    event.error === 'authentication_failed'
  ) {
    return {
      kind: 'auth_error',
      message:
        'Not logged in to Claude Code — run `claude login` in a terminal, then try again.',
    };
  }

  if (
    event.type === 'stream_event' &&
    typeof event.event === 'object' &&
    event.event !== null
  ) {
    const inner = event.event as Record<string, unknown>;
    const { delta } = inner;
    if (
      typeof delta === 'object' &&
      delta !== null &&
      (delta as Record<string, unknown>).type === 'text_delta' &&
      typeof (delta as Record<string, unknown>).text === 'string'
    ) {
      return {
        kind: 'text_delta',
        text: (delta as Record<string, unknown>).text as string,
      };
    }
    return { kind: 'ignored' };
  }

  if (event.type === 'result' && typeof event.result === 'string') {
    const sessionId =
      typeof event.session_id === 'string' ? event.session_id : null;
    return { kind: 'result', fullText: event.result, sessionId };
  }

  return { kind: 'ignored' };
}
