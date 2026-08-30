import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, ipcMain, safeStorage } from 'electron';

// Lets a user connect their own Claude subscription without ever opening a
// terminal to run `claude login` — the thing this exists to fix (issue: the
// "not logged in" error message had no in-app recovery path at all).
//
// This is NOT the app performing OAuth or touching Claude.ai credentials —
// that's explicitly against Anthropic's terms for third-party apps. What it
// stores instead is a token the user generates themselves, once, via
// Anthropic's own `claude setup-token` command (a real, documented CLI
// command: https://code.claude.com/docs/en/authentication — "a long-lived
// authentication token", scoped to inference only, tied to the user's own
// Pro/Max/Team/Enterprise subscription). The user still has to run that one
// command in a terminal once; this only removes the need to ever do so
// again, and removes needing a terminal for every *other* login lapse
// (token expiry, a new machine, etc.) after that.
//
// Verified this exact pattern is what real, shipped multi-agent tooling
// does for this same problem (preset-io/agor's check-auth service) before
// building it here — same env var, same token prefix, same
// isolated-probe-env approach for live validation.

const TOKEN_FILE_NAME = 'copilot-auth.json';
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';
const PROBE_TIMEOUT_MS = 20_000;

function tokenFilePath(): string {
  return path.join(app.getPath('userData'), TOKEN_FILE_NAME);
}

function isSubscriptionTokenShape(token: string): boolean {
  return token.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX);
}

/**
 * A minimal, isolated env for validating a candidate token — deliberately
 * NOT copilotRunner.ts's buildEnv(). The whole point of this probe is "does
 * THIS token work", which an ambient already-logged-in CLI session would
 * mask if the candidate token were merged into the full process env instead
 * of replacing it.
 */
function buildProbeEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: token.trim(),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ].forEach((key) => {
    const value = process.env[key];
    if (value) env[key] = value;
  });
  return env;
}

type ProbeResult = { ok: true } | { ok: false; message: string };

/**
 * Spawns a single, minimal, non-streaming request with the candidate token
 * as the *only* credential available — a real API round trip, not just a
 * format check, so a saved token is proven to actually work before this app
 * ever depends on it. --tools '' matches copilotRunner.ts's own posture
 * (this app doesn't grant Copilot tool access); --output-format json (not
 * stream-json) because a one-shot probe has no reason to consume it
 * incrementally.
 */
function probeToken(token: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const binary = process.env.CLAUDE_CLI_PATH || 'claude';
    const child = spawn(
      binary,
      ['-p', '--safe-mode', '--tools', '', '--output-format', 'json'],
      { cwd: os.tmpdir(), env: buildProbeEnv(token) },
    );

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: 'Timed out validating the token.' });
    }, PROBE_TIMEOUT_MS);

    child.stdin.on('error', () => {});
    child.stdin.write('Reply with exactly: OK', 'utf8');
    child.stdin.end();

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Drained, not read — the probe only needs stdout, but an unread stderr
    // pipe can still fill its OS buffer and stall the process, exactly the
    // failure mode copilotRunner.ts's own stderr handling exists to avoid.
    child.stderr.resume();

    child.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      finish({
        ok: false,
        message:
          err.code === 'ENOENT'
            ? "Claude Code isn't installed (or not on PATH)."
            : err.message,
      });
    });

    child.on('close', () => {
      clearTimeout(timer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        finish({
          ok: false,
          message: "Couldn't validate the token — try again.",
        });
        return;
      }
      const result = parsed as Record<string, unknown>;
      if (result.is_error === true) {
        finish({
          ok: false,
          message:
            typeof result.result === 'string'
              ? result.result
              : 'The token was rejected.',
        });
        return;
      }
      finish({ ok: true });
    });
  });
}

function readStoredToken(): string | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { encrypted?: string };
    if (!parsed.encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64'));
  } catch {
    return null;
  }
}

function writeStoredToken(token: string): void {
  const encrypted = safeStorage.encryptString(token).toString('base64');
  fs.writeFileSync(tokenFilePath(), JSON.stringify({ encrypted }), {
    mode: 0o600,
  });
}

function deleteStoredToken(): void {
  try {
    fs.unlinkSync(tokenFilePath());
  } catch {
    // Already gone — clearing an already-cleared token is a no-op, not an error.
  }
}

/**
 * The token to feed into a real Copilot run's env, or null if none is
 * stored (or storage is unavailable) — copilotRunner.ts falls back to
 * whatever's ambiently logged in via the CLI's own credentials when this
 * is null, exactly as it did before this feature existed.
 */
export function getStoredSubscriptionToken(): string | null {
  return readStoredToken();
}

export function registerCopilotAuthIpc(): void {
  ipcMain.handle('copilot:auth:status', () => {
    const token = readStoredToken();
    return {
      connected: token !== null,
      last4: token ? token.slice(-4) : null,
    };
  });

  ipcMain.handle('copilot:auth:save', async (_event, rawToken: unknown) => {
    if (typeof rawToken !== 'string' || !rawToken.trim()) {
      return { ok: false, message: 'Paste a token first.' };
    }
    const token = rawToken.trim();
    if (!isSubscriptionTokenShape(token)) {
      return {
        ok: false,
        message:
          "That doesn't look like a Claude subscription token — it should start with " +
          `"${SUBSCRIPTION_TOKEN_PREFIX}". Generate one with \`claude setup-token\`.`,
      };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        message:
          "Secure storage isn't available on this system, so tokens can't be saved safely here.",
      };
    }

    const probe = await probeToken(token);
    if (!probe.ok) {
      return { ok: false, message: probe.message };
    }

    writeStoredToken(token);
    return { ok: true, last4: token.slice(-4) };
  });

  ipcMain.handle('copilot:auth:clear', () => {
    deleteStoredToken();
    return { ok: true };
  });
}
