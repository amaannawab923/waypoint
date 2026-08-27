import { parseStreamEventLine } from './parseStreamEvent';

describe('parseStreamEventLine', () => {
  it('parses a system/init event into a session id', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc123',
    });
    expect(parseStreamEventLine(line)).toEqual({
      kind: 'session',
      sessionId: 'sess-abc123',
    });
  });

  it('parses a stream_event text_delta into a text chunk', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });
    expect(parseStreamEventLine(line)).toEqual({
      kind: 'text_delta',
      text: 'Hello',
    });
  });

  it('ignores a stream_event whose delta is not a text_delta (e.g. an input_json_delta)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    });
    expect(parseStreamEventLine(line)).toEqual({ kind: 'ignored' });
  });

  it('parses a result event into the full text and session id', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'The full assistant reply.',
      session_id: 'sess-abc123',
      total_cost_usd: 0.002,
    });
    expect(parseStreamEventLine(line)).toEqual({
      kind: 'result',
      fullText: 'The full assistant reply.',
      sessionId: 'sess-abc123',
    });
  });

  it('parses a result event with no session id as sessionId: null', () => {
    const line = JSON.stringify({ type: 'result', result: 'reply text' });
    expect(parseStreamEventLine(line)).toEqual({
      kind: 'result',
      fullText: 'reply text',
      sessionId: null,
    });
  });

  it('parses a result event with is_error: true into a result_error, not a real reply', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Error: something went wrong internally.',
      session_id: 'sess-abc123',
    });
    expect(parseStreamEventLine(line)).toEqual({
      kind: 'result_error',
      message: 'Error: something went wrong internally.',
      sessionId: 'sess-abc123',
    });
  });

  it('parses a result event with subtype error_during_execution but no explicit is_error field as a result_error', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      result: 'ran out of retries',
    });
    expect(parseStreamEventLine(line)).toEqual({
      kind: 'result_error',
      message: 'ran out of retries',
      sessionId: null,
    });
  });

  it('parses a system/api_retry authentication_failed event into an auth_error', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
      error_status: 401,
      error: 'authentication_failed',
      uuid: 'evt-1',
      session_id: 'sess-abc123',
    });
    const result = parseStreamEventLine(line);
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'auth_error',
        message: expect.stringMatching(/claude login/i),
      }),
    );
  });

  it('ignores a system/api_retry event for a different error category (e.g. rate_limit)', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      error: 'rate_limit',
    });
    expect(parseStreamEventLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores a well-formed but irrelevant event type', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [] },
    });
    expect(parseStreamEventLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores malformed JSON rather than throwing', () => {
    expect(parseStreamEventLine('{not valid json')).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores an empty or whitespace-only line', () => {
    expect(parseStreamEventLine('')).toEqual({ kind: 'ignored' });
    expect(parseStreamEventLine('   \n')).toEqual({ kind: 'ignored' });
  });

  it('ignores a JSON value that parses but is not an object (e.g. a bare string or number)', () => {
    expect(parseStreamEventLine('"just a string"')).toEqual({
      kind: 'ignored',
    });
    expect(parseStreamEventLine('42')).toEqual({ kind: 'ignored' });
    expect(parseStreamEventLine('null')).toEqual({ kind: 'ignored' });
  });

  it('ignores a system/init event missing a session_id', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(parseStreamEventLine(line)).toEqual({ kind: 'ignored' });
  });
});
