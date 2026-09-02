import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, ipcMain, safeStorage } from 'electron';
import { runCopilotQuery, type Query } from './claudeSdkClient';
import { copilotClaudeConfigDir } from './copilotConfigDir';
import { parseSdkMessage } from './parseSdkMessage';

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
 * NOT copilotRunner.ts's full buildEnv() (no ambient process.env merged in
 * at all). The whole point of this probe is "does THIS token work", which
 * an ambient already-logged-in CLI session would mask if the candidate
 * token were merged into the full process env instead of replacing it.
 *
 * CLAUDE_CONFIG_DIR is included here too, though, via the same
 * copilotClaudeConfigDir() helper copilotRunner.ts uses — matching its own
 * gating: once this candidate token is actually connected and saved, every
 * real run WILL set CLAUDE_CONFIG_DIR alongside CLAUDE_CODE_OAUTH_TOKEN
 * (see copilotRunner.ts's buildEnv()), so the probe needs to validate the
 * token under that same redirected config/credential-lookup namespace,
 * not a different, more permissive one that could pass here and then
 * behave differently for real. This is still one more isolated, app-owned
 * value being added, not a route back to the user's ambient ~/.claude — it
 * doesn't un-isolate the probe's own design intent above.
 */
function buildProbeEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: token.trim(),
    CLAUDE_CONFIG_DIR: copilotClaudeConfigDir(),
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
 * Runs a single, minimal request with the candidate token as the *only*
 * credential available — a real API round trip, not just a format check, so a
 * saved token is proven to actually work before this app ever depends on it.
 * `tools: []` matches copilotRunner.ts's own posture (this app doesn't grant
 * Copilot tool access for a "reply with OK" check), and `settingSources: []`
 * matches its isolation posture too — the CLI-era `--safe-mode` this probe
 * used to pass was never the isolation mechanism of record (see
 * copilotRunner.ts on why it silently empties MCP as well), and there's no
 * reason for the probe to hold a weaker posture than the real runner.
 *
 * query() always streams, so this consumes the generator until a terminal
 * result rather than reading a one-shot JSON document. PROBE_TIMEOUT_MS is
 * still enforced by hand: query() has no wall-clock timeout of its own.
 */
async function probeToken(token: string): Promise<ProbeResult> {
  let query: Query | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<ProbeResult> => {
    try {
      query = await runCopilotQuery({
        prompt: 'Reply with exactly: OK',
        options: {
          settingSources: [],
          tools: [],
          // Already a full replacement object rather than a merge, which is
          // exactly the SDK's own `env` semantics.
          env: buildProbeEnv(token),
          cwd: os.tmpdir(),
        },
      });
      // eslint-disable-next-line no-restricted-syntax
      for await (const message of query) {
        const parsed = parseSdkMessage(message);
        // query.close() explicitly, not left to for-await's implicit
        // iterator close: Query's [Symbol.asyncIterator] returns an inner
        // generator, not itself, so returning out of this loop bypasses
        // Query's own close() — the thing that actually tears down the
        // subprocess — same reasoning as copilotRunner.ts's retry path.
        if (parsed.kind === 'result') {
          query.close();
          return { ok: true };
        }
        if (parsed.kind === 'result_error' || parsed.kind === 'auth_error') {
          query.close();
          return { ok: false, message: parsed.message };
        }
      }
      // The stream ended with no terminal result at all — nothing proved the
      // token works, so it must not be saved.
      return { ok: false, message: "Couldn't validate the token — try again." };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error ? err.message : 'Failed to validate the token.',
      };
    }
  };

  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      // Closes the underlying subprocess too, so a hung probe can't outlive
      // the answer this function already returned.
      query?.close();
      resolve({ ok: false, message: 'Timed out validating the token.' });
    }, PROBE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
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

    // Caught, not left to reject this invoke: a locked keychain or a full
    // disk here previously left every caller's `await ...save(...)`
    // permanently unresolved from the UI's perspective (the promise never
    // settles the way callers expect), stranding the modal on "Waiting for
    // sign-in…" or a manual-save button stuck on "Validating…" forever,
    // with a validated-but-unsaved token silently discarded either way.
    try {
      writeStoredToken(token);
    } catch {
      return {
        ok: false,
        message:
          "The token is valid, but it couldn't be saved securely on this device — try again.",
      };
    }
    return { ok: true, last4: token.slice(-4) };
  });

  ipcMain.handle('copilot:auth:clear', () => {
    deleteStoredToken();
    return { ok: true };
  });
}
