import {
  WIRE_FRAME_BINARY,
  WIRE_FRAME_JSON,
  WIRE_HEADER_BYTES,
  WIRE_MAX_FRAME_BYTES,
  type WireMessage,
} from '../types';

/**
 * Streaming frame codec for the engine daemon's Wire protocol.
 *
 * The daemon on the other end of the socket is emdash's own
 * `workspace-server`, unmodified — so this codec does not invent an encoding,
 * it reproduces emdash's byte-for-byte. Every claim below is read off emdash
 * `main` at 9b102a5f3 (the commit `../types.ts`'s `ENGINE_PIN.sourceCommit`
 * pins), `packages/wire/src/api/transports/stream.ts`.
 *
 * JSON frame (`stream.ts:87-93`, `encodeFrame`'s default branch):
 *   byte 0        type byte, `WIRE_FRAME_JSON` (0x00)
 *   bytes 1-4     big-endian u32 — byte length of the body that follows
 *   bytes 5..     UTF-8 JSON body: exactly one `WireMessage`
 *
 * Binary frame (`stream.ts:68-84`). The only message emdash ever frames this
 * way is `blob-chunk` (a file-upload byte chunk); Waypoint sends none of
 * those in W1 (`../types.ts`'s own header says so), but the daemon can still
 * emit one as part of its normal protocol, so this decoder has to walk past
 * one correctly rather than assume it will never see one:
 *   byte 0        type byte, `WIRE_FRAME_BINARY` (0x01)
 *   bytes 1-4     big-endian u32 — byte length of the HEADER that follows
 *   header        UTF-8 JSON `{ kind: 'blob-chunk', channel, seq }` —
 *                 deliberately no `data` field; the payload bytes are NOT
 *                 JSON-escaped into this header, they travel raw, below
 *   next 4 bytes  big-endian u32 — byte length of the BODY that follows
 *   body          the raw chunk bytes themselves, unencoded
 * (On emdash's own read side, `emitParsedMessage` at `stream.ts:142-153`
 * splices header and body back into one `{ ...header, data: new
 * Uint8Array(body) }` object. This codec never reassembles that: it only
 * ever needs to skip past a binary frame so it cannot desync the byte
 * stream, never to hand its contents to a caller — see `createFrameDecoder`
 * below.)
 *
 * `WIRE_MAX_FRAME_BYTES` (16 MiB, matching `stream.ts`'s own
 * `MAX_FRAME_BYTES`) caps every length field independently — the JSON
 * frame's body length, and separately each of the binary frame's header and
 * body lengths — exactly as emdash's own `emitParsedFrames`
 * (`stream.ts:95-140`) checks them: there is no combined-frame-size check,
 * only these three per-field ones.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Number of bytes the binary frame's second length field (the BODY length,
 *  after the header) occupies. The header's own length field is already
 *  counted in `WIRE_HEADER_BYTES`; this is the extra one unique to the
 *  binary frame shape (`stream.ts`'s own `BODY_LENGTH_BYTES`). */
const BINARY_BODY_LENGTH_BYTES = 4;

/**
 * Big-endian u32 read/write, via `DataView` rather than hand-rolled shifts.
 * `stream.ts`'s own `writeU32`/`readU32` (`stream.ts:186-191`) build the
 * same four bytes by hand, and do it correctly: the top byte is multiplied
 * (`* 0x1000000`), so only the low 24 bits ever go through `<<` and a
 * length with its top bit set reads back positive. (An earlier version of
 * this comment claimed the opposite about upstream; it was wrong — found
 * in review.) `DataView.getUint32`/`setUint32` are used here because
 * reading "a big-endian u32 at this byte offset" is exactly what they are
 * for, and because it keeps this file's `no-bitwise` lint genuinely
 * satisfied rather than suppressed — not because upstream has a bug.
 *
 * `target.buffer`/`source.buffer` may be a `SharedArrayBuffer` (part of
 * `ArrayBufferLike`, the type every `Uint8Array` in this file carries) —
 * `DataView`'s constructor accepts that directly, no cast needed.
 */
function writeU32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset + offset, 4).setUint32(
    0,
    value,
    false,
  );
}

function readU32(source: Uint8Array, offset: number): number {
  return new DataView(source.buffer, source.byteOffset + offset, 4).getUint32(
    0,
    false,
  );
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return new Uint8Array(right);
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

/**
 * Encodes one `WireMessage` as a JSON frame — the only frame kind Waypoint
 * ever writes. There is no `encodeBinaryFrame`: Waypoint's `WireClient`
 * (`./client.ts`) never sends a `blob-chunk`, because W1 does no file
 * transfer over this connection (`../types.ts`'s own framing comment), so a
 * binary-frame encoder would be dead code with no test that could prove it
 * matches emdash's `blob-chunk` branch of `encodeFrame` (`stream.ts:69-85`)
 * for real. If a later milestone needs to upload a file, that encoder is
 * built then, against a real need instead of a guess.
 *
 * `JSON.stringify` on a `WireCallMessage` whose `input` is `undefined` (the
 * shape `health`/`initialize`-style no-argument calls use) drops the `input`
 * key entirely rather than writing `"input":null` — this is standard
 * `JSON.stringify` behaviour for an object property whose value is
 * `undefined`, and it is what emdash's own `encodeJson` (`stream.ts:155-157`,
 * a bare `JSON.stringify`) produces too, so the two sides agree on the wire
 * without this codec doing anything special about it.
 */
export function encodeJsonFrame(message: WireMessage): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(WIRE_HEADER_BYTES + body.byteLength);
  frame[0] = WIRE_FRAME_JSON;
  writeU32(frame, 1, body.byteLength);
  frame.set(body, WIRE_HEADER_BYTES);
  return frame;
}

export interface FrameDecoder {
  /**
   * Feeds newly arrived bytes and returns every `WireMessage` that is now
   * fully decodable. A frame split across two or more `push` calls yields
   * nothing until the split half arrives; multiple complete frames in one
   * `push` all come back from that one call, in order. A binary (blob-chunk)
   * frame is consumed silently — it contributes nothing to the returned
   * array — once it has fully arrived; until then it is buffered like any
   * other incomplete frame.
   *
   * Throws if a frame declares a header or body length over
   * `WIRE_MAX_FRAME_BYTES`, or if a JSON frame's body fails to parse as
   * JSON. Both are the same class of problem — the byte stream can no longer
   * be trusted to contain well-formed frames — and the contract for both is
   * identical to emdash's own decoder's: the caller must treat this as fatal
   * and close the transport, never call `push` again, and never attempt to
   * resynchronize by scanning for the next plausible frame boundary. (A
   * throw mid-parse also discards any messages already decoded earlier in
   * that same `push` call, since they were never returned — acceptable only
   * because the caller is about to tear the connection down anyway, and any
   * pending request those messages would have completed instead completes,
   * a moment later, via that teardown's own "reject everything in flight"
   * path — see `./client.ts`'s `handleClose`.)
   */
  push(chunk: Uint8Array): WireMessage[];
}

export function createFrameDecoder(): FrameDecoder {
  // Explicitly typed rather than inferred: TypeScript infers `new
  // Uint8Array(0)` (a length-constructed array) as the narrower
  // `Uint8Array<ArrayBuffer>`, but `concat` below returns the wider, default
  // `Uint8Array<ArrayBufferLike>` — the same type every other `Uint8Array`
  // in this codec and `EngineTransport` itself uses. Left inferred, the
  // reassignment two lines into `push` would be a type error on every
  // `push` after the first, only because of what the FIRST assignment
  // happened to narrow to.
  let buffer: Uint8Array = new Uint8Array(0);

  return {
    push(chunk: Uint8Array): WireMessage[] {
      buffer = concat(buffer, chunk);
      const messages: WireMessage[] = [];
      let offset = 0;

      while (buffer.byteLength - offset >= WIRE_HEADER_BYTES) {
        const kind = buffer[offset];
        const headerLength = readU32(buffer, offset + 1);
        if (headerLength > WIRE_MAX_FRAME_BYTES) {
          throw new Error(
            `Wire frame declares a ${headerLength}-byte header, over the ${WIRE_MAX_FRAME_BYTES}-byte cap`,
          );
        }
        const headerStart = offset + WIRE_HEADER_BYTES;
        const headerEnd = headerStart + headerLength;
        // The header itself hasn't fully arrived yet — wait for more bytes
        // rather than parse a truncated slice.
        if (buffer.byteLength < headerEnd) break;

        if (kind === WIRE_FRAME_JSON) {
          const text = textDecoder.decode(
            buffer.subarray(headerStart, headerEnd),
          );
          const parsed: unknown = JSON.parse(text);
          // A non-object body (`null`, a number, a string) is valid JSON
          // and not a message; pushing it would put `null` into the
          // client's router, which reads `.kind` off it inside the
          // transport's data listener — an uncaught TypeError in Electron
          // main (found in review, L4). emdash guards the same way with
          // `isWireMessage`. A frame that parses but is not a message is a
          // peer that is not speaking Wire; the decoder throws, and the
          // client closes the transport rather than desync.
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            typeof (parsed as { kind?: unknown }).kind !== 'string'
          ) {
            throw new Error('Wire frame body is not a message object');
          }
          messages.push(parsed as WireMessage);
          offset = headerEnd;
          continue;
        }

        if (kind !== WIRE_FRAME_BINARY) {
          // Neither type byte emdash's own protocol defines. A future
          // emdash build could in principle add a third frame kind before
          // Waypoint's pinned build (`../types.ts`'s `ENGINE_PIN`) is
          // upgraded to speak it, but this client is pinned to one daemon
          // build precisely so that never happens silently — treating an
          // unrecognized type byte as fatal, the same as an oversized
          // frame, is what makes a real protocol drift loud instead of a
          // silently corrupted stream.
          throw new Error(
            `Wire frame has unrecognized type byte 0x${kind.toString(16)}`,
          );
        }

        // Binary (blob-chunk) frame: read past the header AND the body,
        // returning nothing — see this file's header comment for the exact
        // layout and why Waypoint never needs the reassembled message.
        if (buffer.byteLength - headerEnd < BINARY_BODY_LENGTH_BYTES) break;
        const bodyLength = readU32(buffer, headerEnd);
        if (bodyLength > WIRE_MAX_FRAME_BYTES) {
          throw new Error(
            `Wire binary frame declares a ${bodyLength}-byte body, over the ${WIRE_MAX_FRAME_BYTES}-byte cap`,
          );
        }
        const bodyStart = headerEnd + BINARY_BODY_LENGTH_BYTES;
        const bodyEnd = bodyStart + bodyLength;
        // The body hasn't fully arrived yet — wait for more bytes rather
        // than skip past a chunk that hasn't actually landed, which would
        // desync every frame after it.
        if (buffer.byteLength < bodyEnd) break;
        offset = bodyEnd;
      }

      // Keep only the unconsumed tail. `subarray` is a view over the same
      // backing buffer rather than a copy, matching `stream.ts`'s own
      // `emitParsedFrames` return — the next `push` still allocates a fresh
      // concatenated array, so this never accumulates more than one
      // in-flight partial frame's worth of retained memory.
      buffer = buffer.subarray(offset);
      return messages;
    },
  };
}
