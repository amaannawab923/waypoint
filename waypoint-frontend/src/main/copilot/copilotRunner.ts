import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { ipcMain, type BrowserWindow } from 'electron';
import { parseStreamEventLine } from './parseStreamEvent';

// Copilot's persona (issue #7). Layered on top of Claude Code's own default
// system prompt via --append-system-prompt, not a full replacement — no tool
// use to describe yet (that's issues #9/#10), just the identity and the
// self-disclosure convention this app already uses elsewhere (see
// waypoint-frontend's mockSessions.ts) for whenever that capability lands.
const COPILOT_SYSTEM_PROMPT = [
  'You are Copilot, a personal AI assistant inside Waypoint, a project',
  "management tool. You're having a private conversation with the user about",
  "their tickets and work. Be concise and direct. You don't yet have access",
  'to real ticket data or the ability to act on the user’s behalf — if',
  "asked to do something requiring that, say it's coming soon rather than",
  'guessing. When a future capability lets you act on the user’s behalf',
  '(e.g. posting a comment), you must always self-disclose clearly, e.g.',
  '"Hi, this is Copilot — <name>’s agent — commenting on his behalf: ...",',
  "matching Waypoint's existing convention.",
].join(' ');

// --bare would force API-key-only auth and skip the user's own Claude Code
// subscription login entirely — the whole point of this integration is
// reusing that login, so --bare is never passed. --safe-mode suppresses the
// user's global CLAUDE.md/hooks/plugins/skills/auto-memory (which would
// otherwise leak unrelated personal Claude Code config into Copilot's
// persona) while still allowing normal (subscription) authentication —
// verbatim from Anthropic's own docs, confirmed before this was built.
//
// The prompt is deliberately NOT one of these args (see registerCopilotIpc,
// which writes it to the child's stdin instead): a prompt starting with `-`
// would otherwise be parsed as a CLI flag rather than message text
// (confirmed against the real CLI), which both lets a user's own message
// tamper with how the process is invoked and, when the swallowed flag
// leaves no positional prompt at all, makes the CLI fall back to waiting on
// stdin for one — hanging forever if nothing is ever written there. Passing
// it on stdin sidesteps both, and as a side benefit keeps message content
// out of the OS process table (`ps aux` et al only shows argv).
function buildArgs(resumeSessionId: string | undefined): string[] {
  const args = [
    '-p',
    '--safe-mode',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    COPILOT_SYSTEM_PROMPT,
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

// GUI-launched apps on macOS/Linux inherit a minimal PATH (typically just
// /usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew or other
// common install locations a terminal shell's PATH would have — so a
// `claude` that resolves fine from Terminal can still ENOENT here in a
// packaged app. These are appended (not prepended, so an explicit
// CLAUDE_CLI_PATH or an already-correct PATH entry always wins) as a
// best-effort fallback, not a guarantee.
const COMMON_INSTALL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.local', 'bin'),
];

function buildEnv(): Record<string, string | undefined> {
  const existing = (process.env.PATH || '').split(path.delimiter);
  const missing = COMMON_INSTALL_DIRS.filter((dir) => !existing.includes(dir));
  return {
    ...process.env,
    PATH: [...existing, ...missing].join(path.delimiter),
  };
}

export type CopilotErrorKind = 'binary_not_found' | 'auth_failed' | 'generic';

type StreamPayload =
  | { requestId: string; type: 'chunk'; text: string }
  | {
      requestId: string;
      type: 'done';
      fullText: string;
      sessionId: string | null;
    }
  | {
      requestId: string;
      type: 'error';
      kind: CopilotErrorKind;
      message: string;
    };

// requestId -> the running process, so before-quit/window-close can clean up
// anything still in flight instead of orphaning it. electronmon restarts the
// main process on every src/main/** file change during dev, which would
// otherwise leave a live `claude` subprocess with no owner.
const inFlight = new Map<string, ReturnType<typeof spawn>>();

export function killAllCopilotProcesses(): void {
  Array.from(inFlight.values()).forEach((child) => child.kill());
  inFlight.clear();
}

export function registerCopilotIpc(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.on(
    'copilot:run',
    (
      _event,
      args: { requestId: string; prompt: string; resumeSessionId?: string },
    ) => {
      // Defensive only — the sole caller is this app's own preload bridge,
      // which always sends a well-formed payload. But ipcMain handlers run
      // in the main process with nothing else standing between a malformed
      // payload and a crash of the whole app, so it's cheap insurance
      // against a future caller (or a bug in preload) doing otherwise.
      if (
        !args ||
        typeof args.requestId !== 'string' ||
        !args.requestId ||
        typeof args.prompt !== 'string' ||
        !args.prompt.trim()
      ) {
        return;
      }
      const { requestId, prompt, resumeSessionId } = args;

      const send = (payload: StreamPayload) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send('copilot:stream', payload);
      };

      // error and close can both fire for the same failure (e.g. ENOENT
      // fires 'error' with the specific reason, then 'close' right after
      // with no useful reason at all) — settled makes the terminal send
      // idempotent so the second, less useful message can never overwrite
      // the first. Chunks aren't gated by this: any number of them can
      // legitimately precede the one terminal event.
      let settled = false;
      const finish = (payload: StreamPayload) => {
        if (settled) return;
        settled = true;
        send(payload);
      };

      const binary = process.env.CLAUDE_CLI_PATH || 'claude';
      // No explicit cwd argument is passed to the CLI in this phase (that's
      // #9/#10's job), but the *subprocess's* cwd still defaults to this
      // main process's own cwd unless overridden — which could be an
      // arbitrary user project containing its own project-level
      // .claude/CLAUDE.md. --safe-mode only suppresses the user's *global*
      // config, not project-level config discovered via cwd. Running from
      // a neutral, contentless directory avoids that leak entirely.
      const child = spawn(binary, buildArgs(resumeSessionId), {
        cwd: os.tmpdir(),
        env: buildEnv(),
      });
      inFlight.set(requestId, child);

      // Writing the prompt is the one thing that can make this process ever
      // finish — see buildArgs's comment on why it isn't passed as an argv
      // element instead. Ending stdin immediately after is what lets the
      // CLI treat "no more input" as "that was the whole prompt" rather
      // than waiting indefinitely for more.
      child.stdin.on('error', () => {
        // A write can fail if the process already exited (e.g. immediate
        // ENOENT) before this runs — the process's own 'error'/'close'
        // handlers below already report that; nothing further to do here
        // beyond not letting an unhandled EPIPE crash the main process.
      });
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();

      let stdoutBuffer = '';
      let sawResult = false;
      let sessionIdFromInit: string | null = null;

      // utf8 mode on the stream itself (not a per-chunk .toString('utf8'))
      // matters here: a multi-byte UTF-8 character split across two
      // separate 'data' chunks would otherwise decode each half
      // independently and corrupt the character — Node's own stream
      // decoder buffers an incomplete trailing sequence internally and
      // completes it once the rest arrives.
      child.stdout.setEncoding('utf8');

      const processLine = (line: string) => {
        const parsed = parseStreamEventLine(line);
        switch (parsed.kind) {
          case 'session':
            sessionIdFromInit = parsed.sessionId;
            break;
          case 'text_delta':
            send({ requestId, type: 'chunk', text: parsed.text });
            break;
          case 'result':
            sawResult = true;
            finish({
              requestId,
              type: 'done',
              fullText: parsed.fullText,
              sessionId: parsed.sessionId ?? sessionIdFromInit,
            });
            break;
          case 'result_error':
            sawResult = true;
            finish({
              requestId,
              type: 'error',
              kind: 'generic',
              message:
                parsed.message ||
                'Claude Code reported an error while responding.',
            });
            break;
          case 'auth_error':
            finish({
              requestId,
              type: 'error',
              kind: 'auth_failed',
              message: parsed.message,
            });
            break;
          case 'ignored':
          default:
            break;
        }
      };

      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        // The last element is either '' (the buffer ended exactly on a
        // newline) or a partial line still waiting on more data — either
        // way, it doesn't belong to this batch of complete lines.
        stdoutBuffer = lines.pop() ?? '';
        lines.forEach(processLine);
      });

      // Consumed (not just ignored) so a chatty CLI writing enough to
      // stderr can't fill its pipe buffer and block the process from
      // making further progress on stdout — an unread stream's backing
      // pipe has a fixed OS buffer size. Capped so a runaway/looping CLI
      // can't grow this without bound; only the tail is useful for a
      // diagnostic message anyway.
      let stderrTail = '';
      const STDERR_TAIL_LIMIT = 4000;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      child.on('error', (err: Error & { code?: string }) => {
        inFlight.delete(requestId);
        if (err.code === 'ENOENT') {
          finish({
            requestId,
            type: 'error',
            kind: 'binary_not_found',
            message:
              "Claude Code isn't installed (or not on PATH) — install it and run `claude login`, then try again.",
          });
        } else {
          finish({
            requestId,
            type: 'error',
            kind: 'generic',
            message: err.message,
          });
        }
      });

      child.on('close', (code) => {
        inFlight.delete(requestId);
        // Anything still sitting in the buffer at close time is a final
        // line that never got a trailing newline (the CLI's very last
        // stdout write commonly doesn't end in one) — without this, a
        // perfectly successful run's `result` event could be silently
        // dropped, reported as "exited without responding" instead.
        if (stdoutBuffer.trim()) {
          const remaining = stdoutBuffer;
          stdoutBuffer = '';
          processLine(remaining);
        }
        // A clean result (or an already-reported auth error) means this run
        // is fully accounted for — nothing further to report. Anything else
        // (crashed, killed, exited non-zero with no result) is an
        // unreported failure the renderer would otherwise hang waiting on.
        if (sawResult) return;
        const tail = stderrTail.trim();
        finish({
          requestId,
          type: 'error',
          kind: 'generic',
          message: tail
            ? `Claude Code exited without responding (code ${code ?? 'unknown'}): ${tail}`
            : `Claude Code exited without responding (code ${code ?? 'unknown'}).`,
        });
      });
    },
  );
}
