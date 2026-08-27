import { spawn } from 'child_process';
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
function buildArgs(
  prompt: string,
  resumeSessionId: string | undefined,
): string[] {
  const args = [
    '-p',
    prompt,
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
      const { requestId, prompt, resumeSessionId } = args;

      const send = (payload: StreamPayload) => {
        getWindow()?.webContents.send('copilot:stream', payload);
      };

      const binary = process.env.CLAUDE_CLI_PATH || 'claude';
      const child = spawn(binary, buildArgs(prompt, resumeSessionId));
      inFlight.set(requestId, child);

      let stdoutBuffer = '';
      let sawResult = false;
      let sawAuthError = false;
      let sessionIdFromInit: string | null = null;

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        // The last element is either '' (the buffer ended exactly on a
        // newline) or a partial line still waiting on more data — either
        // way, it doesn't belong to this batch of complete lines.
        stdoutBuffer = lines.pop() ?? '';

        lines.forEach((line) => {
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
              send({
                requestId,
                type: 'done',
                fullText: parsed.fullText,
                sessionId: parsed.sessionId ?? sessionIdFromInit,
              });
              break;
            case 'auth_error':
              sawAuthError = true;
              send({
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
        });
      });

      child.on('error', (err: Error & { code?: string }) => {
        inFlight.delete(requestId);
        if (err.code === 'ENOENT') {
          send({
            requestId,
            type: 'error',
            kind: 'binary_not_found',
            message:
              "Claude Code isn't installed (or not on PATH) — install it and run `claude login`, then try again.",
          });
        } else {
          send({
            requestId,
            type: 'error',
            kind: 'generic',
            message: err.message,
          });
        }
      });

      child.on('close', (code) => {
        inFlight.delete(requestId);
        // A clean result (or an already-reported auth error) means this run
        // is fully accounted for — nothing further to report. Anything else
        // (crashed, killed, exited non-zero with no result) is an
        // unreported failure the renderer would otherwise hang waiting on.
        if (sawResult || sawAuthError) return;
        send({
          requestId,
          type: 'error',
          kind: 'generic',
          message: `Claude Code exited without responding (code ${code ?? 'unknown'}).`,
        });
      });
    },
  );
}
