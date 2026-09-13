/**
 * Public surface of ROAD-49, the thin Wire client. Everything else in this
 * directory (byte-level helpers inside `codec.ts`, the `PendingRequest` /
 * `AttachState` bookkeeping inside `client.ts`) is an implementation detail
 * this barrel deliberately does not re-export.
 *
 * The protocol *types* this client speaks (`WireClient`, `EngineTransport`,
 * `EngineCallError`, ...) are not re-exported here either — they live in
 * `../types.ts`, the contract this whole engine module is built against, and
 * a caller that needs them imports from there directly rather than through
 * this slice, so there is exactly one place that owns them.
 */
export {
  createFrameDecoder,
  encodeJsonFrame,
  type FrameDecoder,
} from './codec';
export { createWireClient } from './client';
