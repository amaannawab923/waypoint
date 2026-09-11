/* eslint import/prefer-default-export: off -- one named export, re-exported
   by name from ./index.ts; same call util.ts makes. */
import * as net from 'net';
import type {
  EngineTransport,
  EngineTransportCloseReason,
  Unsubscribe,
} from '../types';

// The socket-mode transport (ROAD-50): a client connection to a daemon that
// is already serving on a Unix domain socket, started earlier with
// `start --socket <path>` and living on independently of this process.
//
// This file does exactly one thing the contract asks of a transport — move
// bytes and report, once, when the connection is gone. It does NOT start
// the daemon (daemonCli.ts), does NOT frame or parse Wire messages
// (../wire/), and does NOT retry or reconnect: the contract reserves that
// decision for the supervisor so a dropped engine is reported honestly
// rather than papered over inside the transport (types.ts, section 4's note
// on WireClient, and the EngineStatus posture in section 5).

/**
 * How long `close()` waits for the daemon to answer our FIN with its own
 * before the socket is torn down regardless.
 *
 * `close()` uses `socket.end()` rather than `destroy()` so any bytes still
 * queued on our side (a final `detach`, say) are flushed before the FIN
 * goes out. The price of that politeness is that Node keeps the socket
 * open for reading until the peer closes its side too — and a daemon that
 * is mid-teardown, wedged, or simply never ends its half would leave
 * `onClose` unfired forever. On a local Unix socket the peer's FIN arrives
 * in microseconds when it arrives at all, so one second is not a tuning
 * knob; it only exists so "the daemon ignored our goodbye" still ends in
 * `closed-by-us` instead of silence.
 */
const END_GRACE_MS = 1_000;

type ErrnoLike = Error & { code?: string };

/**
 * The two failures a caller has to tell apart, phrased for the person who
 * eventually reads them in the engine panel. ENOENT means there is no
 * socket file — nothing was ever started here, or it already cleaned up
 * after itself (`serve-socket.ts`'s dispose unlinks the socket). ECONNREFUSED
 * means the file is there but nothing is accepting on it — the classic
 * stale socket a daemon leaves behind when it is killed rather than
 * stopped; emdash's own `start` unlinks exactly that case before spawning
 * (`daemon/start.ts:147-156`). Every other code is passed through with its
 * name so it is at least googleable.
 */
function describeConnectError(socketPath: string, err: ErrnoLike): string {
  switch (err.code) {
    case 'ENOENT':
      return `no daemon at ${socketPath} (socket file does not exist)`;
    case 'ECONNREFUSED':
      return `daemon socket exists at ${socketPath} but refused the connection (stale socket from a daemon that is no longer running?)`;
    default:
      return `could not connect to daemon socket ${socketPath}: ${err.message}`;
  }
}

/**
 * Wraps an already-connected socket in the contract's `EngineTransport`
 * shape. Split from `connectSocketTransport` so the connected-state
 * bookkeeping (listeners, the once-only close, the first-cause reason) has
 * no way to run against a socket that never connected.
 */
function attach(socket: net.Socket): EngineTransport {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<
    (reason: EngineTransportCloseReason) => void
  >();

  // Set by the first of: our close(), a socket 'error', the peer's 'end'.
  // Read exactly once, when the socket's 'close' event finally fires.
  let firstCause: EngineTransportCloseReason | undefined;
  // True from the moment send() must refuse: after our close() is called,
  // or after the socket has reported itself gone.
  let writable = true;
  let closeFired = false;

  socket.on('data', (chunk: Buffer) => {
    // A Buffer is a Uint8Array subclass and Node hands each 'data' chunk
    // out as its own allocation, never re-used after emission, so this is
    // a zero-copy pass-through rather than a view over memory the socket
    // is about to overwrite.
    dataListeners.forEach((cb) => cb(chunk));
  });

  socket.on('error', (err: Error) => {
    writable = false;
    firstCause ??= { kind: 'error', message: err.message };
    // 'close' always follows 'error' on a net.Socket, so the once-only
    // onClose dispatch lives there and this handler only records the cause.
  });

  socket.on('end', () => {
    // The daemon sent FIN. With Node's default allowHalfOpen=false the
    // socket ends our side automatically and 'close' follows; nothing to
    // write to anyone who has half-closed on us, so refuse sends now rather
    // than let them fail later with a less useful stream error.
    writable = false;
    firstCause ??= { kind: 'peer-closed' };
  });

  socket.on('close', () => {
    writable = false;
    if (closeFired) return;
    closeFired = true;
    const reason: EngineTransportCloseReason = firstCause ?? {
      kind: 'peer-closed',
    };
    closeListeners.forEach((cb) => cb(reason));
    closeListeners.clear();
    dataListeners.clear();
  });

  return {
    mode: 'socket',

    send(bytes: Uint8Array): void {
      if (!writable) {
        throw new Error('engine socket transport is closed');
      }
      socket.write(bytes);
    },

    onData(cb): Unsubscribe {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },

    onClose(cb): Unsubscribe {
      closeListeners.add(cb);
      return () => {
        closeListeners.delete(cb);
      };
    },

    close(): void {
      // Idempotent: a second close() must neither re-end the socket nor
      // start a second grace timer.
      if (firstCause?.kind === 'closed-by-us') return;
      writable = false;
      firstCause ??= { kind: 'closed-by-us' };
      if (socket.destroyed) return;
      socket.end();
      // See END_GRACE_MS: a peer that never answers our FIN must not keep
      // onClose from firing. unref() so this timer alone never holds the
      // main process open past app quit.
      const fallback = setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, END_GRACE_MS);
      fallback.unref();
      socket.once('close', () => clearTimeout(fallback));
    },
  };
}

/**
 * Connects to a serving daemon's Unix domain socket and resolves with a
 * ready transport once the connection is established. Rejects, with a
 * message that says which of the two common failures it was, if it is not.
 *
 * The returned transport's `onClose` fires exactly once, with the first
 * cause observed:
 * - `closed-by-us` when our `close()` came first,
 * - `error` (with the socket's own message) when a socket error came first,
 * - `peer-closed` when the daemon ended the connection without either.
 * "First" matters: a daemon that dies while we are mid-`close()` is still
 * reported as our close, and a socket that errors and is then closed by us
 * is still reported as the error — the reason names what actually happened
 * to the connection, not the last thing anyone did to it.
 */
export function connectSocketTransport(
  socketPath: string,
): Promise<EngineTransport> {
  return new Promise<EngineTransport>((resolve, reject) => {
    const socket = net.connect(socketPath);

    const onConnectError = (err: ErrnoLike) => {
      socket.destroy();
      reject(new Error(describeConnectError(socketPath, err)));
    };
    socket.once('error', onConnectError);
    socket.once('connect', () => {
      socket.off('error', onConnectError);
      resolve(attach(socket));
    });
  });
}
