import type { EngineTransport } from '../types';
import { connectSocketTransport } from './socket';
import {
  spawnStdioTransport,
  type StdioEngineTransport,
  type StdioTransportOptions,
} from './stdio';

// The one door into the transports (ROAD-50). The supervisor picks a mode
// from the contract's EngineTransportMode and gets back the contract's
// EngineTransport; the Wire client on top of it neither knows nor cares
// which mode it is speaking over (types.ts, section 3).

/**
 * What each mode needs to open. A discriminated union rather than
 * `(mode, ...rest)` so the compiler, not a runtime check, is what stops a
 * socket path being handed to the stdio spawner or an env to the socket
 * connector.
 */
export type OpenEngineTransportOptions =
  | { mode: 'socket'; socketPath: string }
  | ({ mode: 'stdio'; launcherPath: string } & StdioTransportOptions);

/**
 * The stdio mode hands back more than the contract's transport (its pid
 * and stderr — see StdioEngineTransport); this keeps that visible to a
 * caller who asked for stdio by name, without overloads.
 */
export type OpenedEngineTransport<O extends OpenEngineTransportOptions> =
  O extends { mode: 'stdio' } ? StdioEngineTransport : EngineTransport;

/**
 * Opens a transport in the given mode. Resolves only once the daemon on
 * the other end can be spoken to — the socket accepted, or the stdio
 * child reported it is listening — and rejects with each mode's own
 * diagnosis otherwise. See `connectSocketTransport` and
 * `spawnStdioTransport` for what those are.
 */
export function openEngineTransport<O extends OpenEngineTransportOptions>(
  options: O,
): Promise<OpenedEngineTransport<O>> {
  // The narrowing below is exact per branch; only the generic return type
  // needs the cast, because TypeScript cannot relate a switch on
  // `options.mode` back to the conditional type over `O`.
  const opened = ((): Promise<EngineTransport> => {
    switch (options.mode) {
      case 'socket':
        return connectSocketTransport(options.socketPath);
      case 'stdio':
        // `options` is structurally a StdioTransportOptions; the two extra
        // fields ride along unread.
        return spawnStdioTransport(options.launcherPath, options);
      default: {
        // Exhaustiveness: a new EngineTransportMode in types.ts has to be
        // handled here before this compiles again.
        const unreachable: never = options;
        throw new Error(
          `unknown engine transport mode: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  })();
  return opened as Promise<OpenedEngineTransport<O>>;
}

export { connectSocketTransport } from './socket';
export {
  spawnStdioTransport,
  STDIO_READY_LINE,
  STDIO_READY_TIMEOUT_MS,
  STDIO_TERM_GRACE_MS,
  type EngineEnv,
  type StdioEngineTransport,
  type StdioTransportOptions,
} from './stdio';
