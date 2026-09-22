import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// F9 (tech-lead review, 2026-09-22): drives the REAL runner.py — its real
// `run()`, including the `with Agent(...) as agent:` block and the
// `finally: restart_daemon()` cleanup around it — as a subprocess, with
// PYTHONPATH pointed at testFixtures/pyFakes so `import
// jev_ultrafast.agent` and `import browser_harness.admin` resolve to this
// repo's own fakes instead of the pinned venv's real packages. No real
// Browser Use decision model, Chromium, or browser-harness daemon
// involved — the fake Agent stands in for a completed (or, with
// FAKE_AGENT_RAISE=1, a failed) walk, and the fake restart_daemon()
// records every call it receives to a marker file instead of actually
// shutting anything down.
//
// This is the one behavioral test for runner.py in this repo (its only
// other coverage, runner.pycompile.test.ts, is a syntax check); needs
// nothing beyond python3 stdlib, so it runs wherever that test does.

const RUNNER_PATH = path.join(__dirname, 'runner.py');
const FAKES_DIR = path.join(__dirname, 'testFixtures', 'pyFakes');

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs runner.py against the fake Agent/restart_daemon, returns its
 *  parsed "result" line and the calls the fake restart_daemon recorded. */
function runAgainstFakes(
  request: Record<string, unknown>,
  raiseMidWalk: boolean,
) {
  const marker = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ultrafast-runner-test-')),
    'restart-daemon-calls.json',
  );
  const stdout = execFileSync('python3', [RUNNER_PATH], {
    input: `${JSON.stringify(request)}\n`,
    env: {
      ...process.env,
      PYTHONPATH: FAKES_DIR,
      FAKE_RESTART_DAEMON_MARKER: marker,
      ...(raiseMidWalk ? { FAKE_AGENT_RAISE: '1' } : {}),
    },
    encoding: 'utf8',
  });
  const resultLine = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.type === 'result');
  const calls = fs.existsSync(marker)
    ? (JSON.parse(fs.readFileSync(marker, 'utf8')) as unknown[])
    : [];
  return { resultLine, calls };
}

describe('runner.py daemon cleanup (F9)', () => {
  // Same conditional-skip-inside-the-body pattern as
  // runner.pycompile.test.ts, for the same reason: an `it`/`it.skip`
  // alias would defeat eslint-plugin-jest's static expect-inside-a-test
  // check.
  it('shuts the browser-harness daemon down after a successful walk', () => {
    if (!hasPython3()) return;
    const { resultLine, calls } = runAgainstFakes(
      { url: 'http://localhost:5199', goal: 'click Go' },
      false,
    );
    expect(resultLine.status).toBe('done');
    // Exactly one call, with no BU_NAME set (this test doesn't set one),
    // targeting "default" the way ensure_daemon() would have — proving
    // runner.py's own `restart_daemon()` call ran, not some incidental
    // side effect.
    expect(calls).toEqual([{ name: null, requireClean: false }]);
  });

  it('still shuts the daemon down when the walk itself fails (a finally, not a success-only cleanup)', () => {
    if (!hasPython3()) return;
    const { resultLine, calls } = runAgainstFakes(
      { url: 'http://localhost:5199', goal: 'click Go' },
      true,
    );
    // main()'s own outer try/except turns the raised error into a
    // well-formed "failed" result — unrelated to this fix, but confirms
    // the fake actually raised rather than silently no-opping.
    expect(resultLine.status).toBe('failed');
    expect(calls).toEqual([{ name: null, requireClean: false }]);
  });
});
