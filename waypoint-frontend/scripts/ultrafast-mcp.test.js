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
      // can quote in its report.
      expect(textBlock.text).toMatch(
        /Timing: \d+\.\d s wall · Chromium ready in \d+\.\d s · Jev \d+ decision\(s\) \d+\.\d s total.* · Claude \d+ text call\(s\) \d+\.\d s · \d+ screenshot\(s\) returned/,
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
