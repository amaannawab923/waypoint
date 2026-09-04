import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ipcMain } from 'electron';
import { buildEnv } from './copilotConnect';

// The Tier 0 fix for `detectLocalClaudeCode()` in
// waypoint-frontend/src/renderer/data/api.ts, which used to unconditionally
// resolve `{status:'connected', version:'2.4.1'}` regardless of the actual
// machine — a fabricated version number rendered next to the real signed-in
// user's email, on any machine including one with no Claude Code installed
// at all. See docs/design/waypoint-revamp-architecture.md §1.4, §7.2, and
// work breakdown unit W1.2.
//
// This runs a real, one-shot `claude --version` and reports only what that
// invocation actually produced. It reuses copilotConnect.ts's `buildEnv()`
// (which already folds in `COMMON_INSTALL_DIRS`) rather than re-deriving the
// PATH-augmentation logic — same reasoning copilotAuth.ts's probeToken
// already established for reusing an existing, reviewed pattern over a
// fresh one. Unlike copilotConnect.ts's PTY-based `setup-token` flow, this
// needs no terminal emulation: `--version` is a single line of plain
// stdout, so a plain `child_process.spawn` (the same primitive
// claudeSdkClient.ts uses for the real SDK subprocess) is enough.

const DETECT_TIMEOUT_MS = 5_000;

export type CopilotDetectResult =
  | { ok: true; version: string; path: string }
  // A clean "not found" — the OS itself couldn't locate the binary on the
  // (augmented) PATH. Distinct from `error` below: this is the expected,
  // well-understood outcome on a machine that simply doesn't have Claude
  // Code installed, not a failure of the probe itself.
  | { ok: false; reason: 'not-found'; message: string }
  // The spawn itself failed for some other reason, the process didn't exit
  // cleanly, its output didn't parse, or it ran past DETECT_TIMEOUT_MS.
  | { ok: false; reason: 'error'; message: string };

function parseVersion(stdout: string): string | null {
  // Deliberately permissive rather than pinned to one exact `claude
  // --version` output shape: this only has to find *a* version-looking
  // token in whatever the real CLI printed, not fully parse its format.
  const match = stdout.match(/(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)/);
  return match ? match[1] : null;
}

// Best-effort only, and never gates present/absent/error on its own — the
// actual `spawn` + exit-code + parsed-version result above is the sole
// source of truth for whether Claude Code is installed. This just resolves
// *where* the binary that already answered actually lives, for the `path`
// field on a `present` result, by walking the same PATH the spawn itself
// used. Falls back to the literal command string if the scan can't find it
// (e.g. a shell builtin/alias resolving it differently), which is still a
// true statement of what was run — never a fabricated path.
function resolveBinaryPath(
  binary: string,
  env: Record<string, string>,
): string {
  if (path.isAbsolute(binary)) return binary;

  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidateNames =
    process.platform === 'win32'
      ? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, binary]
      : [binary];

  // eslint-disable-next-line no-restricted-syntax
  for (const dir of dirs) {
    // eslint-disable-next-line no-restricted-syntax
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here — keep scanning the rest of PATH.
      }
    }
  }
  return binary;
}

/**
 * Runs `claude --version` once, with the augmented PATH, and reports
 * exactly what happened — see CopilotDetectResult's own cases. Mirrors
 * copilotAuth.ts's probeToken shape: a manual timeout raced against the
 * real attempt, with the child process explicitly killed on timeout so a
 * hung probe can't outlive the answer this function already returned.
 */
export async function detectClaudeCli(): Promise<CopilotDetectResult> {
  const binary = process.env.CLAUDE_CLI_PATH || 'claude';
  const env = buildEnv();

  return new Promise<CopilotDetectResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: CopilotDetectResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(binary, ['--version'], { env });
    } catch (err) {
      settle({
        ok: false,
        reason: 'error',
        message:
          err instanceof Error ? err.message : `Failed to spawn "${binary}".`,
      });
      return;
    }

    timer = setTimeout(() => {
      // Closes the underlying subprocess too, so a hung probe can't outlive
      // the answer this function already returned — same reasoning
      // copilotAuth.ts's probeToken timeout applies to query.close().
      child.kill();
      settle({
        ok: false,
        reason: 'error',
        message: `Timed out waiting for "${binary} --version" after ${DETECT_TIMEOUT_MS / 1000}s.`,
      });
    }, DETECT_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // A stream-level error (e.g. EPIPE) must not become an unhandled
    // 'error' event of its own — process failure is already reported via
    // the child's own 'error'/'exit' below, same defense
    // claudeSdkClient.ts's stderr handling already carries.
    child.stdout?.on('error', () => {});
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stderr?.on('error', () => {});

    child.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') {
        settle({
          ok: false,
          reason: 'not-found',
          message: `"${binary}" was not found on PATH.`,
        });
        return;
      }
      settle({
        ok: false,
        reason: 'error',
        message: err.message,
      });
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          reason: 'error',
          message:
            stderr.trim() || `"${binary} --version" exited with code ${code}.`,
        });
        return;
      }
      const version = parseVersion(stdout);
      if (!version) {
        settle({
          ok: false,
          reason: 'error',
          message: `Couldn't parse a version from "${binary} --version" output.`,
        });
        return;
      }
      settle({ ok: true, version, path: resolveBinaryPath(binary, env) });
    });
  });
}

export function registerCopilotDetectIpc(): void {
  ipcMain.handle('copilot:detect', () => detectClaudeCli());
}
