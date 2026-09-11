import {
  WIRE_FRAME_BINARY,
  WIRE_FRAME_JSON,
  WIRE_HEADER_BYTES,
  WIRE_MAX_FRAME_BYTES,
  type WireMessage,
} from '../types';
import { createFrameDecoder, encodeJsonFrame } from './codec';

const textEncoder = new TextEncoder();

/** Writes a big-endian u32, the same way `codec.ts`'s own `writeU32` does —
 *  via `DataView` rather than hand-shifted bytes, so this file's frame
 *  builders read as "this is a length field" rather than a bitwise puzzle,
 *  and so this test file satisfies the repo's `no-bitwise` lint rule
 *  honestly instead of needing a suppression for test-only code. */
function writeU32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset + offset, 4).setUint32(
    0,
    value,
    false,
  );
}

/** Builds a JSON frame by hand, independently of `encodeJsonFrame`, so tests
 *  that feed the decoder aren't just checking the codec against itself. */
function jsonFrame(message: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(WIRE_HEADER_BYTES + body.byteLength);
  frame[0] = WIRE_FRAME_JSON;
  writeU32(frame, 1, body.byteLength);
  frame.set(body, WIRE_HEADER_BYTES);
  return frame;
}

/** Builds a binary (`blob-chunk`) frame by hand, matching the layout this
 *  codec's own header comment documents from emdash's `stream.ts:68-84`:
 *  `[0x01][u32 headerLen][header JSON][u32 bodyLen][body]`. `codec.ts`
 *  deliberately exposes no encoder for this frame kind (Waypoint W1 never
 *  sends one), so every test that needs one builds it here instead. */
function binaryFrame(header: unknown, body: Uint8Array): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const frame = new Uint8Array(
    WIRE_HEADER_BYTES + headerBytes.byteLength + 4 + body.byteLength,
  );
  frame[0] = WIRE_FRAME_BINARY;
  writeU32(frame, 1, headerBytes.byteLength);
  frame.set(headerBytes, WIRE_HEADER_BYTES);
  const bodyLenOffset = WIRE_HEADER_BYTES + headerBytes.byteLength;
  writeU32(frame, bodyLenOffset, body.byteLength);
  frame.set(body, bodyLenOffset + 4);
  return frame;
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe('encodeJsonFrame', () => {
  it('encodes a no-input call to the exact byte layout emdash uses for a JSON frame', () => {
    // The four bytes JSON.stringify actually produces for this message: the
    // `input: undefined` key is dropped by JSON.stringify itself (standard
    // behaviour for an object property whose value is `undefined`, not
    // something this codec does), which is why the expected body below has
    // no `input` key rather than an `"input":null`.
    const bytes = encodeJsonFrame({
      kind: 'call',
      id: '1',
      path: 'health',
      input: undefined,
    });

    const expectedBody = textEncoder.encode(
      '{"kind":"call","id":"1","path":"health"}',
    );
    const expected = new Uint8Array(
      WIRE_HEADER_BYTES + expectedBody.byteLength,
    );
    expected[0] = 0x00; // WIRE_FRAME_JSON
    expected[1] = 0x00;
    expected[2] = 0x00;
    expected[3] = 0x00;
    expected[4] = expectedBody.byteLength;
    expected.set(expectedBody, WIRE_HEADER_BYTES);

    expect(bytes).toEqual(expected);
    // Independently pins the two magic numbers this whole layout depends
    // on, so a change to either constant in `../types.ts` fails this test
    // loudly instead of only failing wherever some other test happens to
    // exercise it.
    expect(WIRE_FRAME_JSON).toBe(0x00);
    expect(WIRE_HEADER_BYTES).toBe(5);
  });

  it('writes the body length as big-endian u32, not little-endian or a truncated byte', () => {
    // A body long enough that its length needs more than the low byte —
    // 300 bytes, which is 0x012c, so a little-endian or single-byte bug
    // would corrupt this and a bug limited to the low byte alone would not.
    const input = { padding: 'x'.repeat(300) };
    const bytes = encodeJsonFrame({
      kind: 'call',
      id: '1',
      path: 'health',
      input,
    });

    const expectedBody = textEncoder.encode(
      JSON.stringify({ kind: 'call', id: '1', path: 'health', input }),
    );
    // Reads the four length bytes back as one big-endian u32 via DataView —
    // see `jsonFrame`'s own `writeU32` helper above for why this file
    // reads/writes length fields this way rather than by hand-shifting.
    const declaredLength = new DataView(
      bytes.buffer,
      bytes.byteOffset + 1,
      4,
    ).getUint32(0, false);
    expect(declaredLength).toBe(expectedBody.byteLength);
    expect(bytes.byteLength).toBe(WIRE_HEADER_BYTES + expectedBody.byteLength);
  });
});

describe('createFrameDecoder', () => {
  it('decodes one frame delivered whole in a single push', () => {
    const decoder = createFrameDecoder();
    const message: WireMessage = {
      kind: 'call',
      id: 'abc',
      path: 'health',
      input: undefined,
    };

    const decoded = decoder.push(jsonFrame(message));

    expect(decoded).toEqual([message]);
  });

  it('decodes nothing from a partial frame, then the frame once the rest arrives', () => {
    const decoder = createFrameDecoder();
    const message: WireMessage = {
      kind: 'call',
      id: 'abc',
      path: 'health',
      input: { n: 1 },
    };
    const bytes = jsonFrame(message);

    // Split mid-header (before the 5-byte header itself has fully arrived)
    // and again mid-body, exercising both "wait for more" branches in
    // `push` separately rather than just one split point.
    const first = bytes.subarray(0, 2);
    const second = bytes.subarray(2, WIRE_HEADER_BYTES + 3);
    const third = bytes.subarray(WIRE_HEADER_BYTES + 3);

    expect(decoder.push(first)).toEqual([]);
    expect(decoder.push(second)).toEqual([]);
    expect(decoder.push(third)).toEqual([message]);
  });

  it('decodes a frame split into one push per byte', () => {
    const decoder = createFrameDecoder();
    const message: WireMessage = {
      kind: 'result',
      id: 'xyz',
      ok: true,
      value: { hello: 'world' },
    };
    const bytes = jsonFrame(message);

    const collected: WireMessage[] = [];
    for (let i = 0; i < bytes.byteLength; i += 1) {
      collected.push(...decoder.push(bytes.subarray(i, i + 1)));
    }

    expect(collected).toEqual([message]);
  });

  it('decodes multiple complete frames delivered in a single push, in order', () => {
    const decoder = createFrameDecoder();
    const first: WireMessage = {
      kind: 'call',
      id: '1',
      path: 'health',
      input: undefined,
    };
    const second: WireMessage = {
      kind: 'call',
      id: '2',
      path: 'initialize',
      input: { protocolVersion: '1.0.0' },
    };
    const third: WireMessage = { kind: 'cancel', id: '1' };

    const decoded = decoder.push(
      concatAll([jsonFrame(first), jsonFrame(second), jsonFrame(third)]),
    );

    expect(decoded).toEqual([first, second, third]);
  });

  it('carries a partial trailing frame over to the next push without losing the complete ones before it', () => {
    const decoder = createFrameDecoder();
    const first: WireMessage = {
      kind: 'call',
      id: '1',
      path: 'health',
      input: undefined,
    };
    const second: WireMessage = {
      kind: 'call',
      id: '2',
      path: 'health',
      input: undefined,
    };
    const secondBytes = jsonFrame(second);

    const firstChunk = concatAll([
      jsonFrame(first),
      secondBytes.subarray(0, 3),
    ]);
    const secondChunk = secondBytes.subarray(3);

    expect(decoder.push(firstChunk)).toEqual([first]);
    expect(decoder.push(secondChunk)).toEqual([second]);
  });

  it('skips a whole binary (blob-chunk) frame, returning nothing for it, and keeps decoding after it', () => {
    const decoder = createFrameDecoder();
    const before: WireMessage = {
      kind: 'call',
      id: '1',
      path: 'health',
      input: undefined,
    };
    const after: WireMessage = {
      kind: 'call',
      id: '2',
      path: 'health',
      input: undefined,
    };
    const blob = binaryFrame(
      { kind: 'blob-chunk', channel: 'upload-1', seq: 0 },
      new Uint8Array([1, 2, 3, 4, 5]),
    );

    const decoded = decoder.push(
      concatAll([jsonFrame(before), blob, jsonFrame(after)]),
    );

    // Exactly the two JSON frames — the binary frame contributed nothing,
    // and critically did not desync the JSON frame that follows it.
    expect(decoded).toEqual([before, after]);
  });

  it('skips a binary frame whose header and body each arrive in their own push', () => {
    const decoder = createFrameDecoder();
    const after: WireMessage = {
      kind: 'call',
      id: '2',
      path: 'health',
      input: undefined,
    };
    const blob = binaryFrame(
      { kind: 'blob-chunk', channel: 'c', seq: 7 },
      new Uint8Array(50),
    );

    // Split so the body-length u32 itself straddles two pushes, and the
    // body straddles a third — the two places `push`'s binary branch has
    // its own "wait for more" checks, distinct from the JSON branch's.
    const headerEnd =
      WIRE_HEADER_BYTES +
      JSON.stringify({ kind: 'blob-chunk', channel: 'c', seq: 7 }).length;
    const first = blob.subarray(0, headerEnd + 2);
    const second = blob.subarray(headerEnd + 2, headerEnd + 4 + 10);
    const third = blob.subarray(headerEnd + 4 + 10);

    expect(decoder.push(first)).toEqual([]);
    expect(decoder.push(second)).toEqual([]);
    expect(decoder.push(concatAll([third, jsonFrame(after)]))).toEqual([after]);
  });

  it('throws when a JSON frame declares a header length over WIRE_MAX_FRAME_BYTES', () => {
    const decoder = createFrameDecoder();
    const oversized = new Uint8Array(WIRE_HEADER_BYTES);
    oversized[0] = WIRE_FRAME_JSON;
    writeU32(oversized, 1, WIRE_MAX_FRAME_BYTES + 1);

    expect(() => decoder.push(oversized)).toThrow(/exceeds|over/i);
  });

  it('throws when a binary frame declares a body length over WIRE_MAX_FRAME_BYTES', () => {
    const decoder = createFrameDecoder();
    const header = { kind: 'blob-chunk', channel: 'c', seq: 0 };
    const headerBytes = textEncoder.encode(JSON.stringify(header));
    const frame = new Uint8Array(
      WIRE_HEADER_BYTES + headerBytes.byteLength + 4,
    );
    frame[0] = WIRE_FRAME_BINARY;
    writeU32(frame, 1, headerBytes.byteLength);
    frame.set(headerBytes, WIRE_HEADER_BYTES);
    const bodyLenOffset = WIRE_HEADER_BYTES + headerBytes.byteLength;
    writeU32(frame, bodyLenOffset, WIRE_MAX_FRAME_BYTES + 1);

    expect(() => decoder.push(frame)).toThrow(/exceeds|over/i);
  });

  it('throws on a type byte that is neither the JSON nor the binary marker', () => {
    const decoder = createFrameDecoder();
    const frame = new Uint8Array(WIRE_HEADER_BYTES);
    frame[0] = 0x02; // neither WIRE_FRAME_JSON nor WIRE_FRAME_BINARY
    // headerLength = 0 so the "wait for more" check never masks the type
    // check for lack of bytes.

    expect(() => decoder.push(frame)).toThrow(/type byte/i);
  });

  it('does not choke on an empty push and keeps buffering correctly afterward', () => {
    const decoder = createFrameDecoder();
    const message: WireMessage = {
      kind: 'call',
      id: '1',
      path: 'health',
      input: undefined,
    };
    const bytes = jsonFrame(message);

    expect(decoder.push(new Uint8Array(0))).toEqual([]);
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
    expect(decoder.push(bytes.subarray(2))).toEqual([message]);
  });
});
