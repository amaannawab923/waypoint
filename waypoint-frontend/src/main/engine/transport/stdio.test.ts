/**
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EngineTransportCloseReason } from '../types';
import {
  spawnStdioTransport,
  STDIO_READY_LINE,
  type StdioEngineTransport,
} from './stdio';

// The stdio transport against a fake daemon: a `sh` launcher that execs
// node on a script, the same two-hop shape as the real archive's
// `bin/emdash-workspace-server` (emdash
// `apps/workspace-server/scripts/package-helpers.ts:293-303`). The script
// picks its behaviour from FAKE_MODE so one fixture covers every path the
// transport has to handle: a daemon that becomes ready and echoes, one that
// dies first, one that never becomes ready, and one that ignores SIGTERM.
// Real pipes, real signals, real exit codes — nothing about child_process
// is mocked.

const FAKE_DAEMON_JS = `
const mode = process.env.FAKE_MODE || 'ready-echo';
const args = process.argv.slice(2);
// The transport must spawn exactly \`serve --stdio\`; anything else and the
// real daemon would not be in stdio mode (config.ts:63-68).
if (args[0] !== 'serve' || args[1] !== '--stdio') {
  process.stderr.write('workspace-server failed: bad args ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}
process.stderr.write('FAKE_ARGS=' + JSON.stringify(args) + '\\n');

// The real daemon exits 143 on SIGTERM after disposing (index.ts:140).
const onTerm = () => process.exit(143);

switch (mode) {
  case 'exit-early':
    process.stderr.write('some log line\\n');
    process.stderr.write('workspace-server failed: boom');  // no trailing newline on purpose
    process.exit(1);
    break;
  case 'never-ready':
    process.on('SIGTERM', onTerm);
    if (process.env.FAKE_PID_FILE) require('fs').writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
    process.stderr.write('still refreshing shell env...\\n');
    setInterval(() => {}, 1000);
    break;
  case 'ignore-sigterm':
    process.on('SIGTERM', () => { process.stderr.write('ignoring SIGTERM\\n'); });
    process.stderr.write('${STDIO_READY_LINE}\\n');
    setInterval(() => {}, 1000);
    break;
  case 'ready-split': {
    // Readiness line split across two writes, with a delay between them,
    // and a further line in the same chunk as the second half.
    process.on('SIGTERM', onTerm);
    const line = '${STDIO_READY_LINE}';
    process.stderr.write(line.slice(0, 10));
    setTimeout(() => {
      process.stderr.write(line.slice(10) + '\\nlog right after ready\\n');
      setInterval(() => {}, 1000);
    }, 40);
    break;
  }
  case 'ready-echo':
  default:
    process.on('SIGTERM', onTerm);
    process.stderr.write('pre-ready log\\n');
    process.stderr.write('${STDIO_READY_LINE}\\n');
    process.stdin.on('data', (chunk) => {
      process.stdout.write(chunk);
      process.stderr.write('echoed ' + chunk.length + ' bytes\\n');
    });
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1000);
    break;
}
`;

let dir: string;
let launcherPath: string;
// Each opened transport with a promise for its (single) close, subscribed
// at open time — onClose fires exactly once and never for a late
// subscriber, so the backstop below cannot subscribe after the fact.
const opened: {
  transport: StdioEngineTransport;
  closed: Promise<EngineTransportCloseReason>;
}[] = [];

function env(mode: string): Record<string, string | undefined> {
  return { ...process.env, FAKE_MODE: mode };
}

function nextClose(
  transport: StdioEngineTransport,
): Promise<EngineTransportCloseReason> {
  return new Promise((resolve) => {
    transport.onClose(resolve);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-stdio-'));
  const scriptPath = path.join(dir, 'fake-daemon.js');
  fs.writeFileSync(scriptPath, FAKE_DAEMON_JS);
  launcherPath = path.join(dir, 'fake-launcher');
  fs.writeFileSync(
    launcherPath,
    `#!/bin/sh\nset -eu\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    { mode: 0o755 },
  );
});

afterEach(async () => {
  // Every test closes what it opened; this is the backstop so a failing
  // assertion cannot leave a fake daemon holding jest open. close() is a
  // no-op on an already-closed transport, and `closed` is already settled
  // for it.
  await Promise.all(
    opened.splice(0).map(({ transport, closed }) => {
      transport.close();
      return closed;
    }),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function open(mode: string, extra: Record<string, unknown> = {}) {
  const transport = await spawnStdioTransport(launcherPath, {
    env: env(mode),
    termGraceMs: 500,
    ...extra,
  });
  opened.push({ transport, closed: nextClose(transport) });
  return transport;
}

describe('spawnStdioTransport', () => {
  it('spawns `serve --stdio` and resolves only after the readiness line', async () => {
    const transport = await open('ready-echo');
    expect(transport.mode).toBe('stdio');
    expect(transport.pid).toBeGreaterThan(0);
    // Resolution happened on the readiness line, so everything the fake
    // wrote before it is already in the ring — including the argv echo
    // that proves the exact command line.
    expect(transport.recentStderr()).toEqual([
      'FAKE_ARGS=["serve","--stdio"]',
      'pre-ready log',
      STDIO_READY_LINE,
    ]);
  });

  it('appends extraArgs after `serve --stdio`', async () => {
    const transport = await open('ready-echo', { extraArgs: ['--x', '1'] });
    expect(transport.recentStderr()[0]).toBe(
      'FAKE_ARGS=["serve","--stdio","--x","1"]',
    );
  });

  it('send writes to the child stdin and onData delivers its stdout', async () => {
    const transport = await open('ready-echo');
    const chunks: Uint8Array[] = [];
    const got = new Promise<void>((resolve) => {
      transport.onData((chunk) => {
        chunks.push(chunk);
        resolve();
      });
    });

    transport.send(new TextEncoder().encode('ping'));
    await got;

    expect(chunks[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(chunks[0]).toString('utf8')).toBe('ping');
  });

  it('onStderr delivers lines the daemon logs after it is ready', async () => {
    const transport = await open('ready-echo');
    const lines: string[] = [];
    const got = new Promise<void>((resolve) => {
      transport.onStderr((line) => {
        lines.push(line);
        resolve();
      });
    });

    transport.send(new Uint8Array(3));
    await got;

    expect(lines).toEqual(['echoed 3 bytes']);
    expect(transport.recentStderr()).toContain('echoed 3 bytes');
  });

  it('assembles the readiness line across chunk boundaries', async () => {
    const transport = await open('ready-split');
    // The line after readiness arrived in the same chunk as the second
    // half of the readiness line, so it was dispatched before any live
    // subscriber could exist — which is exactly what recentStderr() is for.
    expect(transport.recentStderr()).toEqual([
      'FAKE_ARGS=["serve","--stdio"]',
      STDIO_READY_LINE,
      'log right after ready',
    ]);
  });

  it('close() sends SIGTERM and reports child-exited with the exit code', async () => {
    const transport = await open('ready-echo');
    const reasons: EngineTransportCloseReason[] = [];
    transport.onClose((r) => reasons.push(r));
    const closed = nextClose(transport);

    transport.close();
    transport.close();
    await closed;
    await sleep(30);

    // 143: the fake mimics the daemon's own SIGTERM handler (index.ts:140).
    // Exactly one report, even with close() called twice.
    expect(reasons).toEqual([
      { kind: 'child-exited', code: 143, signal: null },
    ]);
    expect(() => transport.send(new Uint8Array(1))).toThrow(
      'engine stdio transport is closed',
    );
  });

  it('close() escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const transport = await open('ignore-sigterm');
    const closed = nextClose(transport);
    const started = Date.now();

    transport.close();
    const reason = await closed;

    expect(reason).toEqual({
      kind: 'child-exited',
      code: null,
      signal: 'SIGKILL',
    });
    // The grace elapsed before the kill — i.e. SIGTERM really was tried
    // first and given its window (termGraceMs is 500 in these tests).
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(transport.recentStderr()).toContain('ignoring SIGTERM');
  });

  it('reports child-exited when the daemon dies on its own', async () => {
    const transport = await open('ready-echo');
    const closed = nextClose(transport);

    process.kill(transport.pid, 'SIGKILL');

    expect(await closed).toEqual({
      kind: 'child-exited',
      code: null,
      signal: 'SIGKILL',
    });
  });

  it('rejects, with the child stderr tail, when it exits before readiness', async () => {
    await expect(
      spawnStdioTransport(launcherPath, { env: env('exit-early') }),
    ).rejects.toThrow(
      /engine exited before it was listening \(code 1, signal null\); last stderr:\n(.*\n)*workspace-server failed: boom$/,
    );
  });

  it('rejects on readiness timeout and terminates the child', async () => {
    const pidFile = path.join(dir, 'never-ready.pid');
    const before = Date.now();
    await expect(
      spawnStdioTransport(launcherPath, {
        env: { ...env('never-ready'), FAKE_PID_FILE: pidFile },
        readyTimeoutMs: 200,
        termGraceMs: 500,
      }),
    ).rejects.toThrow(
      `engine did not report "${STDIO_READY_LINE}" within 200ms; last stderr:`,
    );
    expect(Date.now() - before).toBeLessThan(2000);

    // The rejection must not leave the child running. The fake recorded
    // its pid; signal 0 probes liveness without touching it. The fake
    // exits 143 on SIGTERM, so this should be quick, but poll rather than
    // assume — a child that survives is exactly the bug this guards.
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('rejects with a spawn error when the launcher does not exist', async () => {
    const missing = path.join(dir, 'no-such-launcher');
    await expect(
      spawnStdioTransport(missing, { env: env('ready-echo') }),
    ).rejects.toThrow(`could not spawn engine launcher ${missing}: `);
  });
});
