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

const COMMON_INSTALL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.local', 'bin'),
];

function buildEnv(): Record<string, string> {
  const existing = (process.env.PATH || '').split(path.delimiter);
  const missing = COMMON_INSTALL_DIRS.filter((dir) => !existing.includes(dir));
  return {
    ...(process.env as Record<string, string>),
    PATH: [...existing, ...missing].join(path.delimiter),
  };
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
  ipcMain.handle('copilot:auth:open-external', (_event, rawUrl: unknown) => {
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
    shell.openExternal(parsed.toString());
    return { ok: true };
  });
}
