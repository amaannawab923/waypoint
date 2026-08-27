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
  | { kind: 'result_error'; message: string; sessionId: string | null }
  | { kind: 'auth_error'; message: string }
  | { kind: 'ignored' };

// A `result` event reporting is_error can carry its message in either
// field, confirmed live against a real stale --resume: `result` when the
// CLI produced any text before failing, `errors` (and no `result` at all)
// when it didn't.
function extractErrorMessage(event: Record<string, unknown>): string {
  if (typeof event.result === 'string' && event.result) {
    return event.result;
  }
  if (
    Array.isArray(event.errors) &&
    event.errors.every((e) => typeof e === 'string')
  ) {
    return (event.errors as string[]).join('; ');
  }
  return 'Claude Code reported an error while responding.';
}

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

  if (event.type === 'result') {
    const sessionId =
      typeof event.session_id === 'string' ? event.session_id : null;
    // The CLI can end a run with a `result` event that is itself an error
    // report (e.g. a --resume against a session id that no longer exists)
    // rather than a real reply. is_error/subtype is checked BEFORE
    // requiring event.result to be a string — confirmed live against a
    // stale --resume: that error shape carries no `result` field at all,
    // only `errors: [string, ...]`. Gating this whole branch on
    // `typeof event.result === 'string'` (as an earlier version did) made
    // the error case unreachable for exactly the failure it exists to
    // catch, silently falling through to `ignored` instead.
    if (event.is_error === true || event.subtype === 'error_during_execution') {
      return {
        kind: 'result_error',
        message: extractErrorMessage(event),
        sessionId,
      };
    }
    if (typeof event.result === 'string') {
      return { kind: 'result', fullText: event.result, sessionId };
    }
  }

  return { kind: 'ignored' };
}
