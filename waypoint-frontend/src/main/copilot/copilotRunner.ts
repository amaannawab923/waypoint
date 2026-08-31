import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { ipcMain, type BrowserWindow } from 'electron';
import { getStoredSubscriptionToken } from './copilotAuth';
import { copilotClaudeConfigDir } from './copilotConfigDir';
import { parseStreamEventLine } from './parseStreamEvent';

// Copilot's persona (issue #7). Layered on top of Claude Code's own default
// system prompt via --append-system-prompt, not a full replacement. Issue
// #9's read-only MCP tools (see V1_MCP_TOOLS below) have landed — #10's
// write actions haven't, so the prompt is explicit that ticket lookup works
// but acting on the user's behalf still doesn't, matching the self-
// disclosure convention this app already uses elsewhere (see
// waypoint-frontend's mockSessions.ts) for whenever that capability lands.
const COPILOT_SYSTEM_PROMPT = [
  'You are Copilot, a personal AI assistant inside Waypoint, a project',
  "management tool. You're having a private conversation with the user about",
  'their tickets and work. Be concise and direct. You have read-only access',
  'to the user’s tickets via tools — you can look up, list, and search work',
  'items, along with their comments and activity history. You still cannot',
  "make changes on the user's behalf yet — if asked to update something, say",
  "that's coming soon rather than guessing. When a future capability lets you",
  'act on the user’s behalf (e.g. posting a comment), you must always',
  'self-disclose clearly, e.g. "Hi, this is Copilot — <name>’s agent —',
  'commenting on his behalf: ...", matching Waypoint\'s existing convention.',
].join(' ');

// Read-only work-item lookup tools (issue #9) served by waypoint-backend's
// MCP endpoint (see waypoint-backend/src/routes/mcp.routes.ts and
// src/mcp/workItemTools.ts) — the "mcp__waypoint__*" naming is Claude Code's
// own convention for a tool sourced from an MCP server named "waypoint" in
// --mcp-config below. Write actions (issue #10) aren't listed here on
// purpose: headless `-p` mode has no TTY, so Claude Code's own interactive
// tool-approval prompt can never fire — a write tool would execute with
// nothing to gate it, which is why none exists yet.
const V1_MCP_TOOLS = [
  'mcp__waypoint__list_work_items',
  'mcp__waypoint__get_work_item',
  'mcp__waypoint__get_work_item_by_identifier',
  'mcp__waypoint__search_work_items',
  'mcp__waypoint__list_comments',
  'mcp__waypoint__list_activity',
  'mcp__waypoint__list_states',
  'mcp__waypoint__list_members',
];

// Same env var name waypoint-frontend's renderer (src/renderer/mock/
// httpClient.ts) uses to reach the backend — but NOT the same mechanism:
// the renderer's value is a build-time webpack DefinePlugin constant, not a
// runtime env read, since renderer code can't see process.env at all. This
// is a genuine runtime `process.env` read because copilotRunner.ts is
// main-process code, so there's no shared plumbing between the two, just a
// coincidentally-matching name chosen for that reason.
function mcpConfigArg(): string {
  const apiBaseUrl =
    process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';
  return JSON.stringify({
    mcpServers: {
      waypoint: { type: 'http', url: `${apiBaseUrl}/mcp/copilot` },
    },
  });
}

// --bare would force API-key-only auth and skip the user's own Claude Code
// subscription login entirely — the whole point of this integration is
// reusing that login, so --bare is never passed.
//
// Isolation from the user's own global Claude Code config used to be
// --safe-mode, but --safe-mode's own --help text is explicit that it
// disables "CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands
// and agents, ..." — MCP SERVERS INCLUDED, with no override, confirmed live:
// --safe-mode plus a --mcp-config pointing at a real, independently-verified-
// reachable server still comes back with an empty `mcp_servers`/`tools` list
// in the init event. That's silent, not an error — the model then has zero
// tools despite the system prompt telling it otherwise, so it just narrates
// what it would do ("Let me look that up.") and ends its turn immediately.
// --setting-sources '' is the replacement: confirmed live it still empties
// out user-level skills/plugins/custom-agents/CLAUDE.md (the actual leak
// --safe-mode existed to prevent) while leaving an explicitly-passed
// --mcp-config server free to connect — `mcp_servers` comes back
// `connected` and the full tool list is present. Same auth behavior as
// --safe-mode (this only touches config sources, not credentials).
//
// --setting-sources '' does NOT, however, isolate the CLI's *memory/config
// namespace* the way --safe-mode did — confirmed live: with only
// --setting-sources '' set, the init event's `memory_paths.auto` still
// resolves under the real ~/.claude (keyed off cwd's hash). Combined with
// this file's own cwd: os.tmpdir() below, every Copilot conversation on the
// machine — and any other /tmp-cwd Claude Code session — would share ONE
// memory namespace, leaking conversation content across unrelated Copilot
// sessions. CLAUDE_CONFIG_DIR (set conditionally in buildEnv() below) is
// what actually fixes that: pointed at an app-owned directory, confirmed
// live it relocates memory_paths.auto (and the rest of the CLI's config
// home) under that directory instead of the user's real one.
//
// It is NOT, however, safe to set unconditionally. Confirmed live:
// CLAUDE_CONFIG_DIR also relocates where the CLI looks for CREDENTIALS
// (~/.claude.json), not just memory. A user who's logged in ambiently via
// a terminal `claude login` — and never connected a subscription token via
// this app's own Settings → Profile → Copilot flow (copilotAuth.ts) — would
// get "Not logged in · Please run /login" on every Copilot message
// permanently once CLAUDE_CONFIG_DIR is redirected: running `claude login`
// again doesn't fix it, because it writes to the REAL ~/.claude.json, which
// the redirected CLAUDE_CONFIG_DIR never looks at, and there's no reliable
// way to seed the redirected dir with working credentials either (copying
// the real ~/.claude.json into it did not restore auth, confirmed live —
// the real oauth token appears to live somewhere more than a portable file,
// likely OS-keychain-backed). buildEnv() below therefore only sets
// CLAUDE_CONFIG_DIR in the same branch that sets CLAUDE_CODE_OAUTH_TOKEN —
// i.e. only when a subscription token is actually connected, since that
// credential path is honored regardless of CLAUDE_CONFIG_DIR (confirmed
// live: a bogus token under a redirected CLAUDE_CONFIG_DIR was still read
// and sent to the server, which rejected it — proving the mechanism works
// independent of CLAUDE_CONFIG_DIR). Ambient-login users (the majority,
// with no token connected) get no CLAUDE_CONFIG_DIR at all and keep working
// exactly as they did before this isolation fix landed — including the
// shared-memory-namespace exposure described above, which is NOT a
// regression: ambient-login users had that same exposure before any of
// this PR's isolation work existed. So isolation here is two independent
// mechanisms with different reach: --setting-sources '' for
// skills/plugins/custom-agents/CLAUDE.md (applies unconditionally,
// credential-independent), and CLAUDE_CONFIG_DIR for the memory/config
// namespace (applies only when a connected subscription token makes it
// safe to redirect credential lookup too).
//
// --tools '' turns the built-in tool set (Bash/Edit/Write/Task/WebFetch/
// WebSearch/...) off entirely regardless of setting-sources or safe-mode
// (confirmed live: the init event's own `tools` list comes back empty of
// anything but the explicitly --allowedTools-listed MCP tools below) — so
// argv states that intent directly instead of relying on default permission
// prompts to deny everything in practice.
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
//
// resumeSessionId gets the same treatment via SESSION_ID_PATTERN below,
// even though the backend's own zod schema already requires a UUID shape:
// `--resume` takes an *optional* value, so a value starting with `-` isn't
// consumed as --resume's argument — it's parsed as its own separate flag
// (confirmed live: `claude -p --resume --help` prints help instead of
// erroring). Re-checking here means a bad value can never reach argv no
// matter how it got into the database — including anything already written
// before the schema itself was tightened.
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildArgs(resumeSessionId: string | undefined): string[] {
  const args = [
    '-p',
    '--setting-sources',
    '', // no user/project/local settings — global skills/plugins/custom agents stay out (--safe-mode's old job), without also disabling MCP the way --safe-mode does
    '--tools',
    '', // deny every built-in (Bash/Edit/Write/Task/WebFetch/WebSearch/...)
    '--mcp-config',
    mcpConfigArg(),
    '--strict-mcp-config', // ignore any ambient/global MCP config — only ours
    '--allowedTools',
    V1_MCP_TOOLS.join(' '),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    COPILOT_SYSTEM_PROMPT,
  ];
  if (resumeSessionId && SESSION_ID_PATTERN.test(resumeSessionId)) {
    args.push('--resume', resumeSessionId);
  }
  return args;
}

// Claude Code prunes old session transcripts after a retention window (30
// days by default) — confirmed live: `--resume <a well-formed but no-longer-
// existent id>` fails with is_error: true and this exact message text, not
// some distinct error code. Matched case-insensitively since it's the only
// signal the CLI gives; see registerCopilotIpc's retry-once-fresh handling
// below, which exists specifically because there was previously no code
// path anywhere that ever cleared a stale claudeSessionId — once a
// conversation's stored session id aged out, every future message to it
// failed identically, forever.
const STALE_SESSION_PATTERN = /no conversation found with session id/i;

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
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: [...existing, ...missing].join(path.delimiter),
  };
  // A user-connected subscription token (Settings → Profile → Copilot,
  // generated via `claude setup-token`) takes priority over whatever's
  // ambiently logged in via the CLI's own credentials — set here, the CLI
  // itself picks it up automatically and "silently uses it instead of
  // credentials stored in ~/.claude/.credentials.json" (Anthropic's own
  // docs).
  //
  // CLAUDE_CONFIG_DIR is set in this SAME branch, deliberately not
  // unconditionally — see the comment block above buildArgs for the full
  // story. Short version: CLAUDE_CONFIG_DIR also relocates where the CLI
  // looks up credentials, not just memory, so redirecting it is only safe
  // once a connected subscription token means credential lookup no longer
  // depends on the user's real ~/.claude.json. When no token is connected,
  // neither var is set here: Copilot falls through to ambient login exactly
  // as it did before this feature existed, with the memory-namespace
  // isolation gap left as-is for that path (a pre-existing exposure, not a
  // regression — see the comment block above).
  const subscriptionToken = getStoredSubscriptionToken();
  if (subscriptionToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = subscriptionToken;
    env.CLAUDE_CONFIG_DIR = copilotClaudeConfigDir();
  }
  return env;
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

      // A retry (see 'result_error' below) spawns a second child under the
      // same requestId — inFlight must end up tracking whichever one is
      // actually still running. Deleting unconditionally by key would let
      // the FIRST child's own 'close'/'error' handler (which can still fire
      // after the retry has already started) wipe out the SECOND child's
      // entry. Comparing by reference before deleting is what keeps
      // killAllCopilotProcesses targeting the live process either way.
      const forgetIfCurrent = (child: ReturnType<typeof spawn>) => {
        if (inFlight.get(requestId) === child) inFlight.delete(requestId);
      };

      function runAttempt(
        effectiveResumeSessionId: string | undefined,
        allowRetryOnStaleSession: boolean,
      ) {
        const binary = process.env.CLAUDE_CLI_PATH || 'claude';
        // No explicit cwd argument is passed to the CLI in this phase
        // (that's #9/#10's job), but the *subprocess's* cwd still defaults
        // to this main process's own cwd unless overridden — which could
        // be an arbitrary user project containing its own project-level
        // .claude/CLAUDE.md. --setting-sources '' above only suppresses
        // discovered settings sources (user/project/local), not what cwd
        // itself is used for elsewhere (e.g. memory namespacing — see
        // CLAUDE_CONFIG_DIR in buildEnv() for that). Running from a
        // neutral, contentless directory avoids a project-level CLAUDE.md
        // leak entirely regardless.
        const child = spawn(binary, buildArgs(effectiveResumeSessionId), {
          cwd: os.tmpdir(),
          env: buildEnv(),
        });
        inFlight.set(requestId, child);

        // Writing the prompt is the one thing that can make this process
        // ever finish — see buildArgs's comment on why it isn't passed as
        // an argv element instead. Ending stdin immediately after is what
        // lets the CLI treat "no more input" as "that was the whole
        // prompt" rather than waiting indefinitely for more.
        child.stdin.on('error', () => {
          // A write can fail if the process already exited (e.g. immediate
          // ENOENT) before this runs — the process's own 'error'/'close'
          // handlers below already report that; nothing further to do
          // here beyond not letting an unhandled EPIPE crash the main
          // process.
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
              // A --resume against a session id that's aged out (or was
              // otherwise removed from ~/.claude) fails deterministically
              // and identically on every retry with the SAME id — there
              // was previously no code path anywhere that ever cleared it,
              // so this permanently bricked the conversation. Retrying
              // once, transparently, as a fresh (non-resumed) session
              // avoids that: the fresh run's own `result` event carries a
              // new session id, which the renderer persists over the
              // stale one via postAssistantMessage — self-healing it for
              // every message after this one.
              if (
                allowRetryOnStaleSession &&
                effectiveResumeSessionId &&
                STALE_SESSION_PATTERN.test(parsed.message)
              ) {
                runAttempt(undefined, false);
                break;
              }
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
          forgetIfCurrent(child);
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
          forgetIfCurrent(child);
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
          // A clean result (including one that triggered a retry above,
          // or an already-reported auth error) means this run is fully
          // accounted for — nothing further to report. Anything else
          // (crashed, killed, exited non-zero with no result) is an
          // unreported failure the renderer would otherwise hang waiting
          // on.
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
      }

      runAttempt(resumeSessionId, true);
    },
  );
}
