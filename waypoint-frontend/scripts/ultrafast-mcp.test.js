// Speaks real JSON-RPC over stdio to a real, spawned ultrafast-mcp.js —
// the fake runner and fake chromium under scripts/ultrafast/testFixtures/
// stand in for jev-ultrafast/browser-harness and a real browser, and
// ULTRAFAST_TEXT_MODEL_BASE_URL (an escape hatch the server itself
// defines) stands in for the Claude-SDK-backed text-model shim, so this
// exercises the server's actual protocol handling, process spawning,
// timeout plumbing and image-content assembly without needing uv, Python,
// a real Chromium, or the founder's TypeSafe key and Claude login.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SERVER_PATH = path.join(__dirname, 'ultrafast-mcp.js');
const FAKE_RUNNER = path.join(
  __dirname,
  'ultrafast',
  'testFixtures',
  'fakeRunner.js',
);
const FAKE_CHROMIUM = path.join(
  __dirname,
  'ultrafast',
  'testFixtures',
  'fakeChromium.js',
);
const MALICIOUS_LABEL_RUNNER = path.join(
  __dirname,
  'ultrafast',
  'testFixtures',
  'maliciousLabelRunner.js',
);
const ENV_ECHO_RUNNER = path.join(
  __dirname,
  'ultrafast',
  'testFixtures',
  'envEchoRunner.js',
);

/** Spawns the server and returns helpers to send a request and await its
 *  matching response by id, plus a close() to tear it down. */
function startServer(envOverrides = {}) {
  const evidenceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultrafast-mcp-test-'),
  );
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      ULTRAFAST_TYPESAFE_API_KEY: 'test-key',
      ULTRAFAST_VENV_PYTHON: process.execPath,
      ULTRAFAST_RUNNER_PATH: FAKE_RUNNER,
      ULTRAFAST_CHROMIUM_BINARY: FAKE_CHROMIUM,
      ULTRAFAST_EVIDENCE_ROOT: evidenceRoot,
      ULTRAFAST_BH_HOME: fs.mkdtempSync(
        path.join(os.tmpdir(), 'ultrafast-mcp-bh-'),
      ),
      ULTRAFAST_TEXT_MODEL_BASE_URL: 'http://127.0.0.1:1/v1', // never called by the fake runner
      ...envOverrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const waiters = new Map();
  const stderrLines = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && message.id !== undefined && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    }
  });
  child.stderr.on('data', (chunk) => stderrLines.push(chunk.toString('utf8')));

  let nextId = 1;
  function call(method, params) {
    const id = nextId;
    nextId += 1;
    const response = new Promise((resolve) => {
      waiters.set(id, resolve);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    );
    return response;
  }
  function notify(method, params) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
    );
  }
  function close() {
    child.kill('SIGKILL');
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }

  return { child, call, notify, close, stderrLines, evidenceRoot };
}

describe('ultrafast-mcp.js protocol', () => {
  jest.setTimeout(20_000);

  it('answers initialize with a tools capability', async () => {
    const server = startServer();
    try {
      const response = await server.call('initialize', {
        protocolVersion: '2024-11-05',
      });
      expect(response.result.serverInfo.name).toBe('waypoint-ultrafast');
      expect(response.result.capabilities).toEqual({ tools: {} });
    } finally {
      server.close();
    }
  });

  it('lists exactly the browser_task tool', async () => {
    const server = startServer();
    try {
      const response = await server.call('tools/list', {});
      expect(response.result.tools).toHaveLength(1);
      expect(response.result.tools[0].name).toBe('browser_task');
      expect(response.result.tools[0].inputSchema.required).toEqual([
        'url',
        'goal',
      ]);
    } finally {
      server.close();
    }
  });

  it('runs a browser_task end to end against the fake runner and fake chromium, returning image content and the honesty line', async () => {
    const server = startServer();
    try {
      const response = await server.call('tools/call', {
        name: 'browser_task',
        arguments: {
          url: 'http://localhost:5199',
          goal: 'type Ada into Your name, press Submit',
        },
      });
      const { result } = response;
      expect(result.isError).toBe(false);

      const textBlock = result.content.find((c) => c.type === 'text');
      expect(textBlock.text).toContain('status: done');
      // Founder (2026-09-22): where the time went, one line the agent
      // can quote in its report. The wall/Chromium figures are real
      // clock reads (this test doesn't control those), so only their
      // shape is pinned; jevMsTotal/textMsTotal come straight from the
      // fixture's own result line (695ms over 2 decisions, 220ms over 1
      // text call — fakeRunner.js), so those are asserted exactly (F23:
      // this used to only match the line's shape, and the fixture never
      // set these fields, so every run silently asserted against "0.0 s"
      // regardless of what timingLine() actually computed).
      expect(textBlock.text).toMatch(
        /^Timing: \d+\.\d s wall · Chromium ready in \d+\.\d s · Jev 2 decision\(s\) 0\.7 s total \(avg 348 ms\) · Claude 1 text call\(s\) 0\.2 s · 2 screenshot\(s\) returned$/m,
      );
      expect(textBlock.text).toContain('2 step(s)');
      expect(textBlock.text).toContain("done` is Jev's claim");

      const imageBlocks = result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(2); // first frame + final frame, in that order
      // eslint-disable-next-line no-restricted-syntax
      for (const image of imageBlocks) {
        expect(image.mimeType).toBe('image/jpeg');
        expect(typeof image.data).toBe('string');
        expect(image.data.length).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  });

  it('reports a tool call for an unknown tool as an error result, not a protocol error', async () => {
    const server = startServer();
    try {
      const response = await server.call('tools/call', {
        name: 'not_a_real_tool',
        arguments: {},
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('Unknown tool');
    } finally {
      server.close();
    }
  });

  it('refuses a browser_task call missing url or goal without touching the runner', async () => {
    const server = startServer();
    try {
      const response = await server.call('tools/call', {
        name: 'browser_task',
        arguments: { url: 'http://x' },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain(
        'needs both a url and a goal',
      );
    } finally {
      server.close();
    }
  });

  it('reports missing configuration (no key) as a tool error rather than crashing', async () => {
    const server = startServer({ ULTRAFAST_TYPESAFE_API_KEY: '' });
    try {
      const response = await server.call('tools/call', {
        name: 'browser_task',
        arguments: { url: 'http://localhost:5199', goal: 'do something' },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('TypeSafe API key');
    } finally {
      server.close();
    }
  });

  // F5 (tech-lead review, 2026-09-22): a step's `action` label is jev's
  // own action["label"], read straight off the page's DOM — a hostile
  // page could label a button so its text forges a second "status:" line
  // and honesty footer inside the tool's own result block, tricking the
  // reviewing model into reading a fabricated success account. The label
  // must land quoted and on the one line it belongs to, never able to
  // introduce lines of its own.
  it('quotes a page-controlled action label rather than interpolating it raw', async () => {
    const server = startServer({
      ULTRAFAST_RUNNER_PATH: MALICIOUS_LABEL_RUNNER,
    });
    try {
      const response = await server.call('tools/call', {
        name: 'browser_task',
        arguments: { url: 'http://localhost:5199', goal: 'click submit' },
      });
      const text = response.result.content.find((c) => c.type === 'text').text;
      const lines = text.split('\n');

      // buildToolResult writes exactly 4 lines for this result: the real
      // status line, the Timing line, one line per history entry (one
      // here), and the honesty footer. If the hostile label's embedded
      // newlines were NOT escaped — the bug this test guards against —
      // they would split into several extra lines here, including a
      // forged "status: done" and a forged copy of the honesty footer
      // ahead of the real one.
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe(
        'status: done · 1 step(s) · 100ms · 1 jev decision(s) · 0 text call(s)',
      );
      expect(lines[lines.length - 1]).toBe(
        "`done` is Jev's claim — check the screenshots before saying the behaviour matches.",
      );

      // The step's own line carries the label, but JSON-escaped: the
      // embedded newlines read as literal `\n`, not as line breaks, and
      // the whole thing is one JSON string bounded by quotes.
      const stepLine = lines[2];
      expect(stepLine.startsWith('1. "Submit')).toBe(true);
      expect(stepLine).toContain('\\n\\nstatus: done');
    } finally {
      server.close();
    }
  });

  // F2 (tech-lead review, 2026-09-22): browser-harness's own telemetry
  // opt-out (BH_TELEMETRY, alongside BROWSER_HARNESS_TELEMETRY and
  // ANONYMIZED_TELEMETRY — browser_harness/telemetry.py's DISABLE_ENVS)
  // was never passed to the runner — only BH_UPDATE_CHECK was. The
  // provisioning step disables telemetry persistently under BH_HOME, but
  // that opt-out is only as reliable as BH_HOME staying the same
  // directory at task time; BH_TELEMETRY=0 is a second, independent
  // backstop that needs no config file at all.
  it('passes browser-harness a telemetry opt-out env var, not just BH_UPDATE_CHECK', async () => {
    const server = startServer({ ULTRAFAST_RUNNER_PATH: ENV_ECHO_RUNNER });
    try {
      const response = await server.call('tools/call', {
        name: 'browser_task',
        arguments: { url: 'http://localhost:5199', goal: 'do something' },
      });
      expect(response.result.isError).toBe(false);

      const text = response.result.content.find((c) => c.type === 'text').text;
      const snapshotLine = text
        .split('\n')
        .find((line) => line.startsWith('error: ENV_SNAPSHOT '));
      expect(snapshotLine).toBeDefined();
      const snapshot = JSON.parse(
        snapshotLine.slice('error: ENV_SNAPSHOT '.length),
      );
      expect(snapshot.BH_TELEMETRY).toBe('0');
      expect(snapshot.BH_UPDATE_CHECK).toBe('0');
    } finally {
      server.close();
    }
  });

  // F2: an empty BH_HOME makes browser-harness's own paths.home_dir() fall
  // back to ~/.config/browser-harness — a directory this feature's own
  // provisioning step never ran `telemetry disable` against. Refusing
  // outright is the fix; this proves it never silently falls through to
  // launching a task against that untouched directory.
  it('refuses to run when its browser-harness home directory is not configured', async () => {
    const server = startServer({ ULTRAFAST_BH_HOME: '' });
    try {
      const response = await server.call('tools/call', {
        name: 'browser_task',
        arguments: { url: 'http://localhost:5199', goal: 'do something' },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain(
        'browser-harness home directory',
      );
    } finally {
      server.close();
    }
  });

  it('ignores notifications (no response expected) without breaking later calls', async () => {
    const server = startServer();
    try {
      server.notify('notifications/initialized', {});
      const response = await server.call('ping', {});
      expect(response.result).toEqual({});
    } finally {
      server.close();
    }
  });
});
