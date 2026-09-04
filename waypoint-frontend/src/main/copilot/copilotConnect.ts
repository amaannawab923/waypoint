import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { ipcMain, shell, type BrowserWindow } from 'electron';

// Runs `claude setup-token` — the real Anthropic CLI's own long-lived-token
// command (code.claude.com/docs/en/authentication) — inside an actual
// pseudo-terminal, entirely orchestrated from this app, so a user never
// opens a terminal themselves. Confirmed live before building this: with a
// plain piped stdin (no TTY), the command produces no output at all and
// just hangs — it genuinely requires a real PTY to run, which is what
// node-pty exists to provide.
//
// This file only spawns the process and streams its raw output to the
// renderer — it does NOT try to parse that output itself. TUI output is
// ANSI/cursor-positioning-coded, not plain text (confirmed live: a hand-
// written parser got a real captured token wrong on the first attempt,
// because "was that a wrapped continuation or a literal space" isn't
// answerable without real terminal-state emulation). The renderer resolves
// the stream correctly using @xterm/headless — the same core terminal-
// emulation engine VS Code's own integrated terminal runs on — and reads
// back its resolved screen buffer instead of the raw byte stream.

// Exported for copilotDetect.ts's `claude --version` probe, which needs the
// exact same PATH-augmentation shape this file already established — see
// its own comment for why that reuse matters (consistency with the one
// already-reviewed pattern, not a fresh reimplementation).
export const COMMON_INSTALL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.local', 'bin'),
];

export function buildEnv(): Record<string, string> {
  const existing = (process.env.PATH || '').split(path.delimiter);
  const missing = COMMON_INSTALL_DIRS.filter((dir) => !existing.includes(dir));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  // `setup-token` runs a fresh, real interactive OAuth handshake — an
  // inherited credential from a previous connect (or an ambient API key)
  // has no business influencing that, the same reasoning
  // copilotAuth.ts's buildProbeEnv() already applies for validating a
  // candidate token. Everything else about the ambient env is left intact
  // (unlike that isolated probe env): this spawns a real interactive TUI
  // under a PTY, which can depend on locale/config/XDG state in ways a
  // one-shot non-interactive probe call doesn't.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env.PATH = [...existing, ...missing].join(path.delimiter);
  return env;
}

const inFlight = new Map<string, pty.IPty>();

export function killAllCopilotConnectProcesses(): void {
  Array.from(inFlight.values()).forEach((child) => child.kill());
  inFlight.clear();
}

export function registerCopilotConnectIpc(
  getWindow: () => BrowserWindow | null,
): void {
  const send = (channel: string, payload: Record<string, unknown>) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  ipcMain.on(
    'copilot:auth:connect:start',
    (_event, args: { requestId: string }) => {
      if (!args || typeof args.requestId !== 'string' || !args.requestId)
        return;
      const { requestId } = args;

      // This flow is inherently one-at-a-time — the CLI drives a single
      // interactive OAuth handshake in the user's own browser, so two
      // concurrent attempts (two independent modal instances, a double
      // invocation, a stale duplicate requestId) would spawn two real PTYs
      // and could each open their own browser tab for their own OAuth
      // flow. Refuse rather than silently fork a second process — this
      // also prevents a repeat `start` with the SAME id from silently
      // overwriting the map entry and orphaning the first PTY beyond the
      // reach of both cancel and killAllCopilotConnectProcesses.
      if (inFlight.size > 0) {
        send('copilot:auth:connect:exit', {
          requestId,
          code: null,
          spawnError:
            'A sign-in is already in progress — finish or cancel that one first.',
        });
        return;
      }

      const binary = process.env.CLAUDE_CLI_PATH || 'claude';
      // A wide terminal minimizes line-wrapping in the CLI's own rendered
      // output — fewer wrap boundaries for the renderer's buffer scan to
      // reason about, though it isn't relied on for correctness (the real
      // terminal-emulation handles wraps correctly either way).
      let child: pty.IPty;
      try {
        child = pty.spawn(binary, ['setup-token'], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: os.tmpdir(),
          env: buildEnv(),
        });
      } catch (err) {
        send('copilot:auth:connect:exit', {
          requestId,
          code: null,
          spawnError:
            err instanceof Error
              ? err.message
              : "Claude Code isn't installed (or not on PATH).",
        });
        return;
      }
      inFlight.set(requestId, child);

      child.onData((chunk) => {
        send('copilot:auth:connect:data', { requestId, chunk });
      });

      child.onExit(({ exitCode }) => {
        inFlight.delete(requestId);
        send('copilot:auth:connect:exit', { requestId, code: exitCode });
      });
    },
  );

  ipcMain.on(
    'copilot:auth:connect:cancel',
    (_event, args: { requestId: string }) => {
      const child = args && inFlight.get(args.requestId);
      if (!child) return;
      child.kill();
      inFlight.delete(args.requestId);
    },
  );

  // A dedicated, narrowly-scoped opener — not a general "open any URL"
  // bridge. Only ever opens the specific Anthropic OAuth authorize URL the
  // renderer scans out of the CLI's own output, never an arbitrary
  // renderer-supplied string, so this can't become an open redirect for
  // whatever else might call it.
  ipcMain.handle(
    'copilot:auth:open-external',
    async (_event, rawUrl: unknown) => {
      if (typeof rawUrl !== 'string') return { ok: false };
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return { ok: false };
      }
      if (
        parsed.protocol !== 'https:' ||
        (parsed.hostname !== 'claude.com' &&
          parsed.hostname !== 'console.anthropic.com')
      ) {
        return { ok: false };
      }
      // Awaited and caught, not fire-and-forget: shell.openExternal's
      // promise rejects when the OS handler fails (no default browser
      // registered, a broken xdg-open, etc.) — previously that rejection
      // both went unnoticed here (an unconditional { ok: true } regardless
      // of outcome) and would otherwise surface as an unhandled rejection
      // in the main process.
      try {
        await shell.openExternal(parsed.toString());
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );
}
