import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  callBrowserTask,
  lastScreenshotDataUrl,
  parseSummaryLine,
  summaryText,
} from './mcpClient';

// Drives the REAL ultrafast-mcp.js (scripts/ultrafast-mcp.js) against the
// same fake runner/chromium fixtures ultrafast-mcp.test.js uses, proving
// this client's own framing (initialize then one tools/call, matching
// responses by id, the timeout/kill path) against the real server rather
// than a mock of it.
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SERVER_ENTRY = path.join(FRONTEND_ROOT, 'scripts', 'ultrafast-mcp.js');
const FAKE_RUNNER = path.join(
  FRONTEND_ROOT,
  'scripts',
  'ultrafast',
  'testFixtures',
  'fakeRunner.js',
);
const FAKE_CHROMIUM = path.join(
  FRONTEND_ROOT,
  'scripts',
  'ultrafast',
  'testFixtures',
  'fakeChromium.js',
);
const HANGING_RUNNER = path.join(
  FRONTEND_ROOT,
  'scripts',
  'ultrafast',
  'testFixtures',
  'hangingRunner.js',
);

/** F1: a fresh 0600-ish temp file holding `value` — stands in for the
 *  runtime key/OAuth-token file registration.ts's buildServerEnv writes
 *  for real, so tests can point ULTRAFAST_KEY_FILE at something real
 *  without touching this app's own userData. */
function writeTempSecretFile(value: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultrafast-mcpclient-key-'),
  );
  const filePath = path.join(dir, 'secret');
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  return filePath;
}

beforeAll(() => {
  // A plain assertion, not expect(): jest/no-standalone-expect forbids
  // expect() outside a test block, and a missing fixture here should fail
  // every test in this file with one clear message, not run them all
  // first and let each one fail confusingly against a nonexistent server.
  (
    [
      ['ultrafast-mcp.js', SERVER_ENTRY],
      ['fakeRunner.js', FAKE_RUNNER],
      ['fakeChromium.js', FAKE_CHROMIUM],
    ] as const
  ).forEach(([label, fixturePath]) => {
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Fixture missing: ${label} (${fixturePath})`);
    }
  });
});

function baseEnv(): Record<string, string> {
  return {
    // The real ultrafast-mcp.js launches Chromium with no explicit `env`
    // of its own (it inherits whatever it was spawned with — a real
    // Chrome/Chromium binary needs no PATH at all, spawned by absolute
    // path), but the fake-chromium fixture is a `#!/usr/bin/env node`
    // script: the kernel's shebang handling runs `/usr/bin/env node …`,
    // and `env` itself needs PATH to find `node`. Without it the fixture
    // fails to start and this test would instead exercise (and pass
    // through, misleadingly) the CDP-never-answered failure path. PATH is
    // a test-fixture concern only — production's real Chrome is exec'd
    // directly, no shebang involved.
    PATH: process.env.PATH ?? '',
    // F1: the real registration.ts writes the key to a 0600 file and
    // hands the server only its path (ULTRAFAST_KEY_FILE) — never the
    // value itself in the env — so this test drives the server the same
    // way rather than the raw env var the server no longer reads.
    ULTRAFAST_KEY_FILE: writeTempSecretFile('test-key'),
    ULTRAFAST_VENV_PYTHON: process.execPath,
    ULTRAFAST_RUNNER_PATH: FAKE_RUNNER,
    ULTRAFAST_CHROMIUM_BINARY: FAKE_CHROMIUM,
    ULTRAFAST_EVIDENCE_ROOT: fs.mkdtempSync(
      path.join(os.tmpdir(), 'ultrafast-mcpclient-test-'),
    ),
    ULTRAFAST_BH_HOME: fs.mkdtempSync(
      path.join(os.tmpdir(), 'ultrafast-mcpclient-bh-'),
    ),
    ULTRAFAST_TEXT_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
  };
}

describe('callBrowserTask', () => {
  jest.setTimeout(20_000);

  it('returns the tool result from a real server round trip', async () => {
    const result = await callBrowserTask({
      entry: SERVER_ENTRY,
      execPath: process.execPath,
      env: baseEnv(),
      url: 'http://localhost:5199',
      goal: 'type Ada into Your name, press Continue',
      maxSteps: 6,
    });
    expect(result.isError).toBe(false);
    expect(parseSummaryLine(result)).toEqual({ status: 'done', steps: 2 });
    expect(summaryText(result)).toContain("done` is Jev's claim");
    const dataUrl = lastScreenshotDataUrl(result);
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects when the server never answers within the timeout', async () => {
    await expect(
      callBrowserTask({
        entry: SERVER_ENTRY,
        execPath: process.execPath,
        env: { ...baseEnv(), ULTRAFAST_RUNNER_PATH: HANGING_RUNNER },
        url: 'http://localhost:5199',
        goal: 'do something',
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe('parseSummaryLine', () => {
  it('returns nulls for content with no recognizable summary line', () => {
    expect(
      parseSummaryLine({
        content: [{ type: 'text', text: 'nothing to see here' }],
      }),
    ).toEqual({
      status: null,
      steps: null,
    });
  });
});

describe('lastScreenshotDataUrl', () => {
  it('returns null when there are no image blocks', () => {
    expect(
      lastScreenshotDataUrl({ content: [{ type: 'text', text: 'x' }] }),
    ).toBeNull();
  });

  it('picks the LAST image block, not the first', () => {
    const url = lastScreenshotDataUrl({
      content: [
        { type: 'image', data: 'first', mimeType: 'image/jpeg' },
        { type: 'image', data: 'final', mimeType: 'image/jpeg' },
      ],
    });
    expect(url).toBe('data:image/jpeg;base64,final');
  });
});
