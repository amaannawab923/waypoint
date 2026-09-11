/**
 * @jest-environment node
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { EngineTransportCloseReason } from '../types';
import { connectSocketTransport } from './socket';

// The socket transport against a real Unix domain socket served by
// net.createServer — no daemon, no Wire, just the bytes-and-close contract
// socket.ts promises. Each test gets its own socket path under a fresh
// temp dir; macOS caps Unix socket paths at 104 bytes, so the dir name is
// kept short and the tmpdir is os.tmpdir() (already short there), not the
// repo.

let dir: string;
let servers: net.Server[] = [];

function socketPathIn(name: string): string {
  return path.join(dir, `${name}.sock`);
}

function listen(
  socketPath: string,
  onConnection?: (socket: net.Socket) => void,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      onConnection?.(socket);
    });
    server.once('error', reject);
    server.listen(socketPath, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Resolves with the next onClose reason the transport reports. */
function nextClose(transport: {
  onClose: (cb: (r: EngineTransportCloseReason) => void) => () => void;
}): Promise<EngineTransportCloseReason> {
  return new Promise((resolve) => {
    transport.onClose(resolve);
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sock-'));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map(closeServer));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('connectSocketTransport', () => {
  it('resolves once connected and reports mode socket', async () => {
    const socketPath = socketPathIn('a');
    await listen(socketPath);

    const transport = await connectSocketTransport(socketPath);
    expect(transport.mode).toBe('socket');
    transport.close();
  });

  it('rejects with "no daemon at" when the socket file does not exist', async () => {
    const socketPath = socketPathIn('missing');
    await expect(connectSocketTransport(socketPath)).rejects.toThrow(
      `no daemon at ${socketPath} (socket file does not exist)`,
    );
  });

  it('rejects with "refused" when the socket file exists but nothing accepts', async () => {
    const socketPath = socketPathIn('stale');
    // The real stale-socket shape: a socket inode left on disk by a
    // listener that died without cleaning up. Node's own server.close()
    // unlinks the path, and a plain file at the path gives ENOTSOCK rather
    // than ECONNREFUSED — so the only faithful way to make one is to have
    // a separate process listen and then SIGKILL it, exactly what happens
    // to a daemon that is killed instead of stopped.
    const listener = spawn(
      process.execPath,
      [
        '-e',
        'require("net").createServer().listen(process.argv[1], () => process.stdout.write("listening"))',
        socketPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => {
      listener.stdout.once('data', () => resolve());
    });
    const exited = new Promise<void>((resolve) => {
      listener.once('exit', () => resolve());
    });
    listener.kill('SIGKILL');
    await exited;
    expect(fs.existsSync(socketPath)).toBe(true);

    await expect(connectSocketTransport(socketPath)).rejects.toThrow(
      `daemon socket exists at ${socketPath} but refused the connection`,
    );
  });

  it('send writes bytes the server receives, and onData forwards server bytes', async () => {
    const socketPath = socketPathIn('echo');
    const received: Buffer[] = [];
    await listen(socketPath, (socket) => {
      // Echo, upper-cased, so the test can tell "my bytes came back" from
      // "the server sent something".
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        socket.write(Buffer.from(chunk.toString('utf8').toUpperCase()));
      });
    });

    const transport = await connectSocketTransport(socketPath);
    const chunks: Uint8Array[] = [];
    const gotReply = new Promise<void>((resolve) => {
      transport.onData((chunk) => {
        chunks.push(chunk);
        resolve();
      });
    });

    transport.send(new TextEncoder().encode('hello'));
    await gotReply;

    expect(Buffer.concat(received).toString('utf8')).toBe('hello');
    expect(chunks).toHaveLength(1);
    // The contract promises a Uint8Array. A Buffer is one; asserting the
    // base class rather than Buffer is what keeps the Wire client honest
    // about not depending on Buffer-only methods.
    expect(chunks[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(chunks[0]).toString('utf8')).toBe('HELLO');
    transport.close();
  });

  it('onData unsubscribe stops delivery', async () => {
    const socketPath = socketPathIn('unsub');
    let serverSide: net.Socket | undefined;
    await listen(socketPath, (socket) => {
      serverSide = socket;
    });
    const transport = await connectSocketTransport(socketPath);
    // Wait for the server to have its end of the socket.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const seen: number[] = [];
    const unsubscribe = transport.onData((chunk) => seen.push(chunk.length));
    unsubscribe();
    serverSide!.write('ignored');
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(seen).toEqual([]);
    transport.close();
  });

  it('reports closed-by-us exactly once after close()', async () => {
    const socketPath = socketPathIn('bye');
    await listen(socketPath);
    const transport = await connectSocketTransport(socketPath);

    const reasons: EngineTransportCloseReason[] = [];
    transport.onClose((r) => reasons.push(r));
    const closed = nextClose(transport);

    transport.close();
    // Second close() must be a no-op, not a second reason.
    transport.close();
    await closed;
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(reasons).toEqual([{ kind: 'closed-by-us' }]);
  });

  it('reports peer-closed when the server ends the connection', async () => {
    const socketPath = socketPathIn('peer');
    let serverSide: net.Socket | undefined;
    await listen(socketPath, (socket) => {
      serverSide = socket;
    });
    const transport = await connectSocketTransport(socketPath);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const closed = nextClose(transport);
    serverSide!.end();

    expect(await closed).toEqual({ kind: 'peer-closed' });
  });

  it('reports peer-closed when the server destroys the connection', async () => {
    const socketPath = socketPathIn('destroy');
    let serverSide: net.Socket | undefined;
    await listen(socketPath, (socket) => {
      serverSide = socket;
    });
    const transport = await connectSocketTransport(socketPath);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const closed = nextClose(transport);
    serverSide!.destroy();

    // An abrupt destroy from the peer arrives as end/close (a clean FIN on
    // a Unix socket), not as an error — so it is the peer going away, not
    // a fault on our side.
    expect(await closed).toEqual({ kind: 'peer-closed' });
  });

  it('reports error (not peer-closed) when the socket itself fails', async () => {
    const socketPath = socketPathIn('epipe');
    await listen(socketPath, (socket) => {
      // Never read, then drop the connection while the client still has
      // bytes queued: the client's next flush hits a closed pipe and Node
      // raises EPIPE on the socket — a daemon dying mid-upload, seen from
      // our side. This is a socket 'error' with no preceding 'end', so
      // the transport must report the fault, not a polite peer close.
      socket.pause();
      setTimeout(() => socket.destroy(), 30);
    });
    const transport = await connectSocketTransport(socketPath);
    const closed = nextClose(transport);
    transport.send(new Uint8Array(8 * 1024 * 1024));

    expect(await closed).toEqual({
      kind: 'error',
      message: expect.stringContaining('EPIPE'),
    });
  });

  it('send throws once the transport is closed', async () => {
    const socketPath = socketPathIn('sendclosed');
    await listen(socketPath);
    const transport = await connectSocketTransport(socketPath);

    transport.close();
    expect(() => transport.send(new Uint8Array([1]))).toThrow(
      'engine socket transport is closed',
    );
  });

  it('send throws after the peer has gone', async () => {
    const socketPath = socketPathIn('sendpeer');
    let serverSide: net.Socket | undefined;
    await listen(socketPath, (socket) => {
      serverSide = socket;
    });
    const transport = await connectSocketTransport(socketPath);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const closed = nextClose(transport);
    serverSide!.end();
    await closed;

    expect(() => transport.send(new Uint8Array([1]))).toThrow(
      'engine socket transport is closed',
    );
  });

  it('onClose unsubscribe prevents delivery', async () => {
    const socketPath = socketPathIn('unsubclose');
    await listen(socketPath);
    const transport = await connectSocketTransport(socketPath);

    const seen: EngineTransportCloseReason[] = [];
    const unsubscribe = transport.onClose((r) => seen.push(r));
    const closed = nextClose(transport);
    unsubscribe();
    transport.close();
    await closed;

    expect(seen).toEqual([]);
  });
});
