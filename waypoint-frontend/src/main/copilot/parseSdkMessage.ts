// Maps one already-typed SDKMessage from @anthropic-ai/claude-agent-sdk's
// query() generator onto the small event vocabulary copilotRunner.ts pushes
// over IPC. Pure and side-effect-free on purpose: this is the part of the
// Copilot integration that's meaningfully unit-testable without running a
// real query (see copilotRunner.ts, which owns the generator loop and stays
// thin specifically so this file can carry the discrimination logic instead).
//
// Unlike its predecessor there is no JSON.parse/malformed-text defense here:
// the SDK itself produces these objects, so there is no serialization
// boundary left to guard.
import type { SDKMessage } from './claudeSdkClient';

export type ParsedStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text_delta'; text: string }
  | {
      kind: 'result';
      fullText: string;
      sessionId: string | null;
      needsRepoLink: boolean;
    }
  | { kind: 'result_error'; message: string; sessionId: string | null }
  | { kind: 'auth_error'; message: string }
  | { kind: 'ignored' };

// Copilot V3's structural "I needed code I don't have" signal. The model is
// instructed to emit this line — and told never to mention it — only by the
// unlinked-repo variant of the system prompt (copilotRunner.ts's
// buildSystemPrompt), so it can't fire in a state where a repo is already
// linked. Stripping happens here rather than downstream so nothing past this
// function, renderer included, ever sees the token.
const NEEDS_REPO_SENTINEL = '[[NEEDS_REPO]]';

function stripNeedsRepoSentinel(fullText: string): {
  text: string;
  needsRepoLink: boolean;
} {
  const lines = fullText.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  if (last < 0 || lines[last].trim() !== NEEDS_REPO_SENTINEL) {
    return { text: fullText, needsRepoLink: false };
  }
  return {
    text: lines.slice(0, last).join('\n').trimEnd(),
    needsRepoLink: true,
  };
}

// A failed turn carries its message in one of two places depending on which
// result variant reports it, confirmed live against the real runtime: the
// error subtypes (SDKResultError, e.g. a stale resume) carry `errors` and no
// `result` at all, while an API-level failure comes back as the SUCCESS
// subtype with is_error true and the error text in `result` — the exact shape
// copilotAuth.ts's own probe has always had to read.
function extractErrorMessage(message: {
  result?: string;
  errors?: string[];
}): string {
  if (message.result) return message.result;
  if (message.errors?.length) return message.errors.join('; ');
  return 'Claude Code reported an error while responding.';
}

export function parseSdkMessage(message: SDKMessage): ParsedStreamEvent {
  if (message.type === 'system' && message.subtype === 'init') {
    return { kind: 'session', sessionId: message.session_id };
  }

  if (
    message.type === 'system' &&
    message.subtype === 'api_retry' &&
    message.error === 'authentication_failed'
  ) {
    return {
      kind: 'auth_error',
      message:
        'Not logged in to Claude Code — run `claude login` in a terminal, then try again.',
    };
  }

  if (message.type === 'stream_event') {
    const inner = message.event;
    if (
      inner.type === 'content_block_delta' &&
      inner.delta.type === 'text_delta'
    ) {
      return { kind: 'text_delta', text: inner.delta.text };
    }
    return { kind: 'ignored' };
  }

  if (message.type === 'result') {
    const sessionId = message.session_id ?? null;
    // is_error is checked before the subtype, not after: the 'success'
    // subtype doubles as the carrier for a turn that ended on an API error
    // (an expired token, a 401), and reporting that to the renderer as a real
    // reply would persist the error text into the transcript as if the model
    // had said it.
    if (message.is_error || message.subtype !== 'success') {
      return {
        kind: 'result_error',
        message: extractErrorMessage(message),
        sessionId,
      };
    }
    const { text, needsRepoLink } = stripNeedsRepoSentinel(message.result);
    return { kind: 'result', fullText: text, sessionId, needsRepoLink };
  }

  // Every other SDKMessage variant — assistant/user messages, hook events,
  // task notifications, rate-limit events, permission denials, compact
  // boundaries, and whatever the SDK adds next — falls through here
  // deliberately, not for lack of handling: V1/V2/V3 only ever need a session
  // id, text deltas, a terminal result, and one auth-failure signal, and the
  // proposal flow is pull-based over REST rather than parsed out of this
  // stream.
  return { kind: 'ignored' };
}
