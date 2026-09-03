import { parseSdkMessage } from './parseSdkMessage';
import type { SDKMessage } from './claudeSdkClient';

// Fixtures name only the fields this parser actually discriminates on. The
// real SDKMessage variants carry a dozen more (usage, costs, uuids, timing)
// that no branch here reads, and spelling them all out would bury the one
// field each case exists to exercise. The cast is the local, deliberate
// escape hatch for that — narrow to this helper, never in the parser itself.
function message(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

describe('parseSdkMessage', () => {
  it('parses a system/init message into a session id', () => {
    expect(
      parseSdkMessage(
        message({ type: 'system', subtype: 'init', session_id: 'sess-abc123' }),
      ),
    ).toEqual({ kind: 'session', sessionId: 'sess-abc123' });
  });

  it('parses a stream_event text_delta into a text chunk', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello' },
          },
        }),
      ),
    ).toEqual({ kind: 'text_delta', text: 'Hello' });
  });

  it('ignores a stream_event whose delta is not a text_delta (e.g. an input_json_delta)', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        }),
      ),
    ).toEqual({ kind: 'ignored' });
  });

  it('parses a success result into the full text and session id', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'The full assistant reply.',
          session_id: 'sess-abc123',
          total_cost_usd: 0.002,
        }),
      ),
    ).toEqual({
      kind: 'result',
      fullText: 'The full assistant reply.',
      sessionId: 'sess-abc123',
      needsRepoLink: false,
    });
  });

  it('parses a success result with no session id as sessionId: null', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'reply text',
        }),
      ),
    ).toEqual({
      kind: 'result',
      fullText: 'reply text',
      sessionId: null,
      needsRepoLink: false,
    });
  });

  // Copilot V3's structural "I needed code I don't have" signal. The token
  // must never survive into fullText: the renderer renders fullText straight
  // into the transcript AND persists it, so a leak would be permanent and
  // user-visible, not a one-render glitch.
  describe('the [[NEEDS_REPO]] sentinel', () => {
    function successResult(result: string, sessionId?: string): SDKMessage {
      return message({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
    }

    it('strips a trailing sentinel line and reports needsRepoLink: true', () => {
      expect(
        parseSdkMessage(
          successResult(
            "I can't tell without seeing the code.\n\n[[NEEDS_REPO]]",
            'sess-abc123',
          ),
        ),
      ).toEqual({
        kind: 'result',
        fullText: "I can't tell without seeing the code.",
        sessionId: 'sess-abc123',
        needsRepoLink: true,
      });
    });

    // Replies routinely end with trailing newlines — what matters is that
    // the sentinel is the last NON-BLANK line, not literally the last one.
    it('strips the sentinel even when blank lines follow it', () => {
      expect(
        parseSdkMessage(successResult('Some prose.\n[[NEEDS_REPO]]\n\n  \n')),
      ).toEqual({
        kind: 'result',
        fullText: 'Some prose.',
        sessionId: null,
        needsRepoLink: true,
      });
    });

    it('tolerates whitespace around the sentinel on its own line', () => {
      expect(
        parseSdkMessage(successResult('Some prose.\n   [[NEEDS_REPO]]   ')),
      ).toEqual({
        kind: 'result',
        fullText: 'Some prose.',
        sessionId: null,
        needsRepoLink: true,
      });
    });

    it('handles a reply consisting of nothing but the sentinel', () => {
      expect(parseSdkMessage(successResult('[[NEEDS_REPO]]'))).toEqual({
        kind: 'result',
        fullText: '',
        sessionId: null,
        needsRepoLink: true,
      });
    });

    // Only a final line counts. The model was told to END its reply with the
    // token, so an earlier occurrence is far likelier to be it quoting or
    // explaining the token than signalling with it — leaving that text
    // untouched is the honest reading.
    it('leaves a sentinel that is not the final line alone', () => {
      expect(
        parseSdkMessage(
          successResult('[[NEEDS_REPO]]\nActually, here is the answer.'),
        ),
      ).toEqual({
        kind: 'result',
        fullText: '[[NEEDS_REPO]]\nActually, here is the answer.',
        sessionId: null,
        needsRepoLink: false,
      });
    });

    it('leaves a final line that merely contains the token as prose alone', () => {
      expect(
        parseSdkMessage(
          successResult(
            'The app looks for [[NEEDS_REPO]] at the end of a reply.',
          ),
        ),
      ).toEqual({
        kind: 'result',
        fullText: 'The app looks for [[NEEDS_REPO]] at the end of a reply.',
        sessionId: null,
        needsRepoLink: false,
      });
    });
  });

  it('parses an error-subtype result into a result_error, not a real reply', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['Error: something went wrong internally.'],
          session_id: 'sess-abc123',
        }),
      ),
    ).toEqual({
      kind: 'result_error',
      message: 'Error: something went wrong internally.',
      sessionId: 'sess-abc123',
    });
  });

  // The real shape a stale resume produces (verified live): the error
  // subtype, with `errors` and no `result` field at all.
  it('parses an error result carrying only `errors` into a result_error', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'sess-abc123',
          errors: ['No conversation found with session ID: sess-abc123'],
        }),
      ),
    ).toEqual({
      kind: 'result_error',
      message: 'No conversation found with session ID: sess-abc123',
      sessionId: 'sess-abc123',
    });
  });

  it('joins multiple errors when result is absent', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['first problem', 'second problem'],
        }),
      ),
    ).toEqual({
      kind: 'result_error',
      message: 'first problem; second problem',
      sessionId: null,
    });
  });

  it('falls back to a generic message when a result error has neither result nor errors', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
        }),
      ),
    ).toEqual({
      kind: 'result_error',
      message: 'Claude Code reported an error while responding.',
      sessionId: null,
    });
  });

  // The success subtype doubles as the carrier for a turn that ended on an
  // API error (an expired token, a 401) — the exact shape copilotAuth.ts's
  // probe has always read. Treating it as a reply would persist the error
  // text into the transcript as if the model had said it.
  it('parses a success-subtype result with is_error: true as a result_error', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 401,
          result: 'Failed to authenticate. API Error: 401 token expired.',
          session_id: 'sess-abc123',
        }),
      ),
    ).toEqual({
      kind: 'result_error',
      message: 'Failed to authenticate. API Error: 401 token expired.',
      sessionId: 'sess-abc123',
    });
  });

  it('parses a system/api_retry authentication_failed message into an auth_error', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 401,
          error: 'authentication_failed',
          uuid: 'evt-1',
          session_id: 'sess-abc123',
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'auth_error',
        message: expect.stringMatching(/claude login/i),
      }),
    );
  });

  it('ignores a system/api_retry message for a different error category (e.g. rate_limit)', () => {
    expect(
      parseSdkMessage(
        message({ type: 'system', subtype: 'api_retry', error: 'rate_limit' }),
      ),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores a well-formed but irrelevant message type', () => {
    expect(
      parseSdkMessage(message({ type: 'assistant', message: { content: [] } })),
    ).toEqual({ kind: 'ignored' });
  });

  // The SDK's SDKMessage union is far wider than this parser branches on —
  // rate-limit events, hook events, task notifications, permission denials,
  // compact boundaries. Silent pass-through is the deliberate behavior for
  // all of them, not a gap: V1/V2/V3 need nothing from any of them.
  it('ignores the SDK message variants this app has no use for', () => {
    [
      { type: 'rate_limit_event' },
      { type: 'system', subtype: 'status' },
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'task_started' },
      { type: 'thinking_tokens' },
      { type: 'user', message: { content: [] } },
    ].forEach((variant) => {
      expect(parseSdkMessage(message(variant))).toEqual({ kind: 'ignored' });
    });
  });

  // Pin for Copilot V2: with the propose_* tools allowed, the stream now
  // routinely carries assistant tool_use blocks (and their stream_event
  // deltas). None of that is user-visible text — it must keep parsing as
  // `ignored`, exactly as before, with NO new parsing added for it (the
  // proposal flow is pull-based via REST, not stream-parsed, by design).
  it('still ignores tool_use stream events — proposals are never parsed out of the stream', () => {
    expect(
      parseSdkMessage(
        message({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'mcp__waypoint__propose_comment',
            },
          },
        }),
      ),
    ).toEqual({ kind: 'ignored' });

    expect(
      parseSdkMessage(
        message({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"ticketId":' },
          },
        }),
      ),
    ).toEqual({ kind: 'ignored' });

    expect(
      parseSdkMessage(
        message({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'mcp__waypoint__propose_comment',
                input: {},
              },
            ],
          },
        }),
      ),
    ).toEqual({ kind: 'ignored' });
  });
});
