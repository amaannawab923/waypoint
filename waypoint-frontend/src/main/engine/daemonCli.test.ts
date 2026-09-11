/**
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDaemonCommand } from './daemonCli';

// runDaemonCommand against a fake launcher: a `sh` script that execs node
// on a script, the same shape as the real archive's launcher (emdash
// `apps/workspace-server/scripts/package-helpers.ts:293-303`). The fake
// prints the exact lines the real CLI prints — each scenario below is
// transcribed from a format string in emdash
// `apps/workspace-server/src/index.ts`, cited inline — and exits with the
// code that path produces, so what is under test is daemonCli.ts's parsing
// of the real output shapes, not of made-up ones. The fake also records its
// argv and a marker env var to a capture file so the command line and env
// pass-through can be asserted.

const FAKE_CLI_JS = `
const fs = require('fs');
const [command, flag, socketPath] = process.argv.slice(2);
if (process.env.FAKE_CAPTURE) {
  fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    marker: process.env.FAKE_MARKER,
    home: process.env.HOME,
    cwd: process.cwd(),
  }));
}
const sock = socketPath;
switch (process.env.FAKE_SCENARIO) {
  // index.ts:102-104
  case 'start-started':
    process.stdout.write('workspace-server daemon started at ' + sock + '\\n');
    break;
  case 'start-already-running':
    process.stdout.write('workspace-server daemon already-running at ' + sock + '\\n');
    break;
  // index.ts:101 -> index.ts:147-152, message from lock.ts:35
  case 'start-failed':
    process.stderr.write('workspace-server failed: Timed out acquiring workspace daemon lock: ' + sock + '.lock\\n');
    process.exit(1);
  // index.ts:111-115
  case 'stop-stopped':
    process.stdout.write('workspace-server daemon stopped at ' + sock + '\\n');
    break;
  case 'stop-not-running':
    process.stdout.write('workspace-server daemon not running at ' + sock + '\\n');
    break;
  // index.ts:128-131, with a logger line on stderr first (index.ts:25)
  case 'status-running':
    process.stderr.write('{"level":"info","msg":"probing"}\\n');
    process.stdout.write('workspace-server daemon running at ' + sock + ' (version 0.1.0, uptime 1648ms)\\n');
    break;
  // index.ts:122-125
  case 'status-not-running':
    process.stderr.write('workspace-server daemon not-running at ' + sock + ': connect ENOENT ' + sock + '\\n');
    process.exitCode = 1;
    break;
  case 'status-unhealthy':
    process.stderr.write('workspace-server daemon unhealthy at ' + sock + ': Timed out after 1000ms\\n');
    process.exitCode = 1;
    break;
  // index.ts:26-29 -> index.ts:147-152
  case 'config-error':
    process.stderr.write('workspace-server failed: Invalid workspace-server config: status only supports socket mode\\n');
    process.exit(1);
  case 'wrong-socket-path':
    process.stdout.write('workspace-server daemon running at /somewhere/else.sock (version 0.1.0, uptime 5ms)\\n');
    break;
  case 'garbage':
    process.stdout.write('Usage: something-else [options]\\n');
    process.exit(64);
  case 'crash-silent':
    process.exit(70);
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write('fake: unknown scenario ' + process.env.FAKE_SCENARIO + '\\n');
    process.exit(99);
}
`;

let dir: string;
let launcherPath: string;
let socketPath: string;
let capturePath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cli-'));
  const scriptPath = path.join(dir, 'fake-cli.js');
  fs.writeFileSync(scriptPath, FAKE_CLI_JS);
  launcherPath = path.join(dir, 'fake-launcher');
  fs.writeFileSync(
    launcherPath,
    `#!/bin/sh\nset -eu\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    { mode: 0o755 },
  );
  // A path with regex metacharacters, so the literal-match escaping is
  // exercised rather than assumed.
  socketPath = path.join(dir, 'run (1)', 'engine+.sock');
  capturePath = path.join(dir, 'capture.json');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run<C extends 'start' | 'stop' | 'status'>(
  command: C,
  scenario: string,
  extra: {
    env?: Record<string, string>;
    timeoutMs?: number;
    cwd?: string;
  } = {},
) {
  return runDaemonCommand(launcherPath, command, {
    socketPath,
    env: { FAKE_SCENARIO: scenario, FAKE_CAPTURE: capturePath, ...extra.env },
    timeoutMs: extra.timeoutMs,
    cwd: extra.cwd,
  });
}

function readCapture(): {
  argv: string[];
  marker?: string;
  home?: string;
  cwd: string;
} {
  return JSON.parse(fs.readFileSync(capturePath, 'utf8'));
}

describe('runDaemonCommand', () => {
  it('invokes `<command> --socket <path>` with process.env plus the caller env', async () => {
    const result = await run('status', 'status-running', {
      env: { FAKE_MARKER: 'present' },
      cwd: dir,
    });
    expect(result.ok).toBe(true);

    const capture = readCapture();
    expect(capture.argv).toEqual(['status', '--socket', socketPath]);
    expect(capture.marker).toBe('present');
    // process.env came through untouched — HOME is the canary, being the
    // one variable a "scrubbed" env would most plausibly drop and the one
    // the daemon most needs.
    expect(capture.home).toBe(process.env.HOME);
    // realpath both: macOS's tmpdir is under /var, a symlink to /private/var,
    // and process.cwd() reports the resolved form.
    expect(fs.realpathSync(capture.cwd)).toBe(fs.realpathSync(dir));
  });

  describe('start', () => {
    it('parses started', async () => {
      const result = await run('start', 'start-started');
      expect(result).toMatchObject({ ok: true, value: { status: 'started' } });
    });

    it('parses already-running as success', async () => {
      const result = await run('start', 'start-already-running');
      expect(result).toMatchObject({
        ok: true,
        value: { status: 'already-running' },
      });
    });

    it('reports the CLI failure line as daemon-error with its message', async () => {
      const result = await run('start', 'start-failed');
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: 'daemon-error',
          message: `Timed out acquiring workspace daemon lock: ${socketPath}.lock`,
          code: 1,
          signal: null,
        },
      });
    });
  });

  describe('stop', () => {
    it('parses stopped', async () => {
      const result = await run('stop', 'stop-stopped');
      expect(result).toMatchObject({ ok: true, value: { status: 'stopped' } });
    });

    it('parses "not running" as a successful not-running outcome, not a failure', async () => {
      const result = await run('stop', 'stop-not-running');
      expect(result).toMatchObject({
        ok: true,
        value: { status: 'not-running' },
      });
    });
  });

  describe('status', () => {
    it('parses running with version and uptime, ignoring logger lines on stderr', async () => {
      const result = await run('status', 'status-running');
      expect(result).toMatchObject({
        ok: true,
        value: { running: true, version: '0.1.0', uptimeMs: 1648 },
        // The logger line was there — and did not derail the parse.
        stderr: expect.stringContaining('"msg":"probing"'),
      });
    });

    it('parses not-running (exit 1) as an outcome with the probe message', async () => {
      const result = await run('status', 'status-not-running');
      expect(result).toMatchObject({
        ok: true,
        value: {
          running: false,
          reason: 'not-running',
          message: `connect ENOENT ${socketPath}`,
        },
      });
    });

    it('parses unhealthy (exit 1) as a distinct outcome', async () => {
      const result = await run('status', 'status-unhealthy');
      expect(result).toMatchObject({
        ok: true,
        value: {
          running: false,
          reason: 'unhealthy',
          message: 'Timed out after 1000ms',
        },
      });
    });

    it('treats a running line for a different socket path as unrecognized', async () => {
      const result = await run('status', 'wrong-socket-path');
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'unrecognized-output', code: 0, signal: null },
      });
    });
  });

  describe('failures', () => {
    it('reports a config error printed via the failure line as daemon-error', async () => {
      const result = await run('status', 'config-error');
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: 'daemon-error',
          message:
            'Invalid workspace-server config: status only supports socket mode',
          code: 1,
        },
      });
    });

    it('reports unrecognized output with the exit code and raw streams', async () => {
      const result = await run('start', 'garbage');
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'unrecognized-output', code: 64, signal: null },
      });
      expect(result.stdout).toContain('Usage: something-else');
    });

    it('reports a silent non-zero exit as unrecognized output', async () => {
      const result = await run('stop', 'crash-silent');
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'unrecognized-output', code: 70, signal: null },
        stdout: '',
        stderr: '',
      });
    });

    it('kills a hung command at timeoutMs and reports timeout', async () => {
      const before = Date.now();
      const result = await run('status', 'hang', { timeoutMs: 200 });
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'timeout', timeoutMs: 200 },
      });
      expect(Date.now() - before).toBeLessThan(2000);
    });

    it('reports a missing launcher as a launcher failure', async () => {
      const missing = path.join(dir, 'no-such-launcher');
      const result = await runDaemonCommand(missing, 'status', { socketPath });
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: 'launcher',
          message: expect.stringContaining(
            `could not run engine launcher ${missing}: `,
          ),
        },
      });
      expect(result).toMatchObject({
        failure: { message: expect.stringContaining('ENOENT') },
      });
    });
  });
});
