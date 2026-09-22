import { execFileSync } from 'child_process';
import * as path from 'path';

// runner.py is the one file in this feature that never runs through
// TypeScript's own compiler, so nothing else in `pnpm run check` would
// ever catch a syntax error in it before it reached a real machine. This
// is the whole check: byte-compile it with whatever python3 the CI/dev
// machine has (jev-ultrafast itself needs 3.12, provisioned into its own
// venv by pythonEnv.ts, but a syntax check needs no particular version).
// Skipped, not failed, when no python3 is on PATH at all — the same
// "report, don't crash" posture pythonEnv.ts's own findUv takes toward an
// absent host dependency.

const RUNNER_PATH = path.join(__dirname, 'runner.py');

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('runner.py', () => {
  // A conditional `it`/`it.skip` alias defeats eslint-plugin-jest's static
  // check for expect-inside-a-test-block, so this calls `it` literally and
  // skips inside the body instead — reported as a pass, not a skip, on a
  // machine with no python3, which is an acceptable trade for real lint
  // cleanliness on a file this feature otherwise has no coverage for.
  it('byte-compiles cleanly (skipped without python3 on PATH)', () => {
    if (!hasPython3()) return;
    expect(() =>
      execFileSync('python3', ['-m', 'py_compile', RUNNER_PATH], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
