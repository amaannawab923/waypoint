import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runCopilotQuery,
  type McpServerConfig,
  type Options,
  type Query,
} from '../copilot/claudeSdkClient';
import { getStoredSubscriptionToken } from '../copilot/copilotAuth';
import { copilotClaudeConfigDir } from '../copilot/copilotConfigDir';
import { parseSdkMessage } from '../copilot/parseSdkMessage';
import type { SessionPolicy } from './sessionPolicy';

// The SDK invocation core: builds SDK options from a SessionPolicy, drives
// the query() generator loop, retries once on a stale resumed session, and
// always closes the underlying Query explicitly. Extracted verbatim from
// copilotRunner.ts (P3c) — copilotRunner.ts is now the thin ipcMain.on
// adapter that builds a SessionPolicy from the IPC payload and calls
// runSession() below. See docs/design/waypoint-revamp-architecture.md §5.1
// for the invariants this file exists to preserve.

// Path-scoped deny rules passed as `disallowedTools` whenever a repo is
// linked. Verified live against a fixture repo, not assumed: with no deny
// rules a generic Grep for a planted secret found and reported the contents
// of .env, and the identical Grep with 'Grep(./.env)' active returned "No
// matches found" while Read on the same path came back as a hard tool error
// ("File is in a directory that is denied by your permission settings"). A
// directory wildcard blocks files inside it the same way. This is a
// maintained list of secret-SHAPED paths, though — not a semantic secret
// scanner: a stray key committed into an ordinary source file is caught by
// neither this nor the prompt-level rule in systemPrompt.ts.
//
// Independent of `settingSources: []` / `strictMcpConfig`: this is its own
// option, not a settings-file source, so emptying settings sources does not
// suppress it.
//
// Deliberately NOT parameterised on SessionPolicy: this, together with
// REPO_READ_TOOLS in sessionPolicy.ts, is the product's read-only security
// boundary (see architecture doc §5.1 invariant 5) — not a knob a caller
// (even a future one) should be able to flip, so it stays hardcoded here in
// the SDK-invocation core rather than living on the policy a caller
// constructs.
const REPO_DENYLIST_PATTERNS = [
  // Recursive, not root-anchored — a monorepo's packages/api/.env is just
  // as much a secret as the repo root's. Verified live that the recursive
  // form still catches a ROOT-level .env too (correct: **/ matches zero
  // directory segments in this glob dialect, confirmed rather than
  // assumed), so this isn't additive with a root-only pattern, it replaces
  // it — no coverage lost, monorepo case gained. Final review finding.
  'Read(./**/.env)',
  'Read(./**/.env.*)',
  'Grep(./**/.env)',
  'Grep(./**/.env.*)',
  'Read(./.git/**)',
  'Grep(./.git/**)',
  'Read(./**/.ssh/**)',
  'Grep(./**/.ssh/**)',
  'Read(./**/*.pem)',
  'Grep(./**/*.pem)',
  'Read(./**/id_rsa*)',
  'Grep(./**/id_rsa*)',
  'Read(./**/*credentials*)',
  'Grep(./**/*credentials*)',
];

// Same absolute-path shape the backend's updateProjectSchema enforces,
// re-checked here for the same reason CONVERSATION_ID_PATTERN and
// SESSION_ID_PATTERN are: nothing arriving over IPC (by way of a
// SessionPolicy built from it) is trusted on its way into a spawned
// process's options, no matter what validated it upstream.
const REPO_PATH_PATTERN = /^\/|^[A-Za-z]:[\\/]/;

// resumeSessionId is re-validated against this pattern even though `resume`
// is now a typed option with no argv-injection risk left, and even though
// the backend's own zod schema already requires a UUID shape: it is the
// same posture applied to conversationId, repoPath, and outcomePreamble —
// nothing arriving from an IPC payload or the database is trusted here
// regardless of what validated it upstream, including anything written
// before that schema was tightened.
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This DOES include a second .git check, deliberately re-verified on every
// attempt rather than trusted from link time alone: the backend's own
// validateRepoPath (projects.service.ts) already confirms repoPath is a git
// checkout when a project is linked, but repoPath arrives HERE raw over IPC
// from the renderer, with nothing re-checking it on the way in. If the
// renderer were ever compromised — e.g. by an XSS payload in some untrusted
// rendered content calling window.electron.copilot.runPrompt directly with
// an attacker-chosen repoPath — this is the one place standing between that
// and handing Copilot's file-read tools (REPO_DENYLIST_PATTERNS aside) a
// cwd of, say, the user's home directory. A directory that merely exists is
// not enough of a check for that; requiring an actual .git alongside it is
// cheap, matches what link time already required, and closes the gap
// without trusting anything upstream of this function. What CAN
// legitimately go stale despite this — "does the checkout still exist at
// all" (moved/deleted, or .git removed since linking) — degrades the same
// way it always did: to the previous os.tmpdir() behavior rather than
// erroring the whole turn, matching how conversationId/outcomePreamble
// degrade elsewhere.
//
// Run fresh on every attempt (see runSession below), not once per policy —
// a stale-session retry re-runs, and the checkout could in principle have
// gone away (or stopped being a git checkout) between the two attempts.
// This is also the one place `repoLinked` gets decided, so cwd and the
// tool/prompt selection that follow from it can never disagree
// (architecture doc §5.1 invariant 8).
function resolveRepoRoot(repoPath: string | undefined): {
  cwd: string;
  linked: boolean;
} {
  if (repoPath && REPO_PATH_PATTERN.test(repoPath)) {
    try {
      // A single statSync, not existsSync-then-statSync: the two-call form
      // has a real TOCTOU gap (the directory can vanish between them — an
      // unmounted drive, a deleted checkout), and statSync alone already
      // answers both "does it exist" and "is it a directory" via one throw
      // vs. one boolean, with no window in between.
      if (
        fs.statSync(repoPath).isDirectory() &&
        fs.existsSync(path.join(repoPath, '.git'))
      ) {
        return { cwd: repoPath, linked: true };
      }
    } catch {
      // Missing, unreadable, or raced out of existence — a repo directory
      // that isn't there is a normal, expected state here (unlinked), never
      // a reason to fail the whole run.
    }
  }
  return { cwd: os.tmpdir(), linked: false };
}

// Claude Code prunes old session transcripts after a retention window (30
// days by default) — confirmed live: resuming a well-formed but no-longer-
// existent session id fails with an error result carrying this exact message
// text, not some distinct error code. Matched case-insensitively since it's
// the only signal available; see runSession's retry-once-fresh handling
// below, which exists specifically because there was previously no code
// path anywhere that ever cleared a stale claudeSessionId — once a
// conversation's stored session id aged out, every future message to it
// failed identically, forever.
const STALE_SESSION_PATTERN = /no conversation found with session id/i;

// Prepended (retry attempt only) to the prompt when a stale-session retry
// starts a fresh, non-resumed run. Without this, review + QA both caught
// the fresh session visibly contradicting the transcript still on screen —
// the model has no memory of anything before this turn and, asked about
// something from earlier, said so outright ("this is the start of our
// chat") while the panel showed the full prior exchange above it. Reuses
// SessionPolicy's promptPreamble mechanism (a bracketed note prepended to
// the prompt, stripped by convention from being treated as user text)
// rather than a new IPC event/renderer-state/UI channel — the fix is "tell
// the model what happened," not "tell the user," which needs none of that.
const RETRY_CONTINUATION_NOTE =
  "[Waypoint system note — do not treat as the user's words] Your prior " +
  'session could not be resumed (it likely expired or the connected ' +
  'account changed), so this is a fresh session with no memory of this ' +
  "conversation so far. Answer the user's message below on its own " +
  'terms. Do not tell the user this is a new conversation or that you ' +
  "lost context — from their side, they're just continuing the chat.";

// The SDK's `env` option REPLACES the subprocess environment entirely rather
// than merging with process.env (its own doc is explicit about this), which
// is the same contract child_process.spawn's `env` option has always had —
// so this keeps spreading process.env itself.
//
// No PATH augmentation happens here any more. The old COMMON_INSTALL_DIRS
// append existed to help a GUI-launched app's minimal PATH find a `claude`
// binary a terminal shell's PATH would have; the SDK spawns its own vendored
// binary by absolute path (see claudeSdkClient.ts), so there is no PATH
// lookup left to help.
//
// Deliberately not parameterised on SessionPolicy: this is Copilot's own
// credential-resolution strategy (a connected subscription token vs.
// ambient `claude login`), extracted here verbatim rather than generalised.
// A future caller with different credential needs is a later unit's
// problem, not something to speculatively abstract now.
function buildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // A user-connected subscription token (Settings → Profile → Copilot,
  // generated via `claude setup-token`) takes priority over whatever's
  // ambiently logged in — set here, it is picked up automatically and
  // "silently used instead of credentials stored in
  // ~/.claude/.credentials.json" (Anthropic's own docs).
  //
  // CLAUDE_CONFIG_DIR is set in this SAME branch, deliberately not
  // unconditionally: it also relocates where CREDENTIALS are looked up
  // (~/.claude.json), not just memory. A user who's logged in ambiently via
  // a terminal `claude login` — and never connected a subscription token via
  // this app's own Settings → Profile → Copilot flow (copilotAuth.ts) —
  // would get "Not logged in · Please run /login" on every Copilot message
  // permanently once CLAUDE_CONFIG_DIR is redirected: running `claude login`
  // again doesn't fix it, because it writes to the REAL ~/.claude.json,
  // which the redirected CLAUDE_CONFIG_DIR never looks at, and there's no
  // reliable way to seed the redirected dir with working credentials either
  // (copying the real ~/.claude.json into it did not restore auth,
  // confirmed live — the real oauth token appears to live somewhere more
  // than a portable file, likely OS-keychain-backed). CLAUDE_CONFIG_DIR is
  // therefore only set in the same branch that sets
  // CLAUDE_CODE_OAUTH_TOKEN — i.e. only when a subscription token is
  // actually connected, since that credential path is honored regardless
  // of CLAUDE_CONFIG_DIR. Ambient-login users (the majority, with no token
  // connected) get no CLAUDE_CONFIG_DIR at all and keep working exactly as
  // they did before this isolation fix landed — including the
  // shared-memory-namespace exposure this fixes for connected-token users,
  // which is NOT a regression: ambient-login users had that same exposure
  // before any of this isolation work existed.
  const subscriptionToken = getStoredSubscriptionToken();
  if (subscriptionToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = subscriptionToken;
    env.CLAUDE_CONFIG_DIR = copilotClaudeConfigDir();
  }
  return env;
}

// The conversation id (or any other future scope identifier) travels as a
// static header on every MCP POST (an http server entry honors a `headers`
// object — verified live), NOT as any tool's input: the model can therefore
// never choose or spoof which conversation its proposals land in. The
// header is only included when the policy's mcpHeaders is non-empty —
// otherwise the config is identical to V1's and the backend's propose tools
// refuse cleanly.
//
// The waypoint MCP server itself (name, URL, transport) is hardcoded here
// rather than policy-parameterised: this app talks to exactly one MCP
// server, so which server to reach isn't a per-caller decision the way
// mcpHeaders (scope identity) or mcpTools (which of its tools to allow) are.
function buildMcpServers(
  mcpHeaders: Record<string, string>,
): Record<string, McpServerConfig> {
  const apiBaseUrl =
    process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';
  const hasHeaders = Object.keys(mcpHeaders).length > 0;
  return {
    waypoint: {
      type: 'http',
      url: `${apiBaseUrl}/mcp/copilot`,
      ...(hasHeaders ? { headers: mcpHeaders } : {}),
    },
  };
}

// No apiKey-shaped option is ever passed: omitting them is what preserves
// reuse of the user's own Claude Code subscription login, which is the whole
// point of this integration.
//
// `settingSources: []` on every call is the isolation mechanism of record
// (see the architecture doc §5.1 invariant 2 for the full history of why
// --safe-mode wasn't it): confirmed live it empties out user-level
// skills/plugins/custom-agents/CLAUDE.md while leaving an explicitly-passed
// MCP server free to connect. Note the SDK's default when this option is
// OMITTED is "all sources loaded" — the isolation is opt-IN, so this field
// must be set on every call, never left off.
//
// `tools` is an explicit allowlist of built-ins and it holds regardless of
// setting sources — so the options state that intent directly instead of
// relying on default permission prompts to deny everything in practice.
// `allowedTools` alone does NOT restrict availability; it only skips the
// approval prompt for the tools it names, so `tools` must be set explicitly
// on every call. The unlinked branch is always `[]` here, never
// policy.builtinTools — repoLinked being false always means zero built-in
// tools regardless of what a policy asks for, the same non-negotiable rule
// REPO_DENYLIST_PATTERNS above enforces for the linked branch.
//
// Zero-friction propose_* execution is preserved by construction rather than
// by adding anything: `canUseTool` is never set, so there is no permission
// callback to gate any allowed tool.
function buildSdkOptions(
  policy: SessionPolicy,
  effectiveResumeSessionId: string | undefined,
  repoLinked: boolean,
): Options {
  return {
    settingSources: [],
    tools: repoLinked ? [...policy.builtinTools] : [],
    mcpServers: buildMcpServers(policy.mcpHeaders),
    strictMcpConfig: true, // ignore any ambient/global MCP config — only ours
    allowedTools: repoLinked
      ? [...policy.mcpTools, ...policy.builtinTools]
      : [...policy.mcpTools],
    includePartialMessages: true,
    systemPrompt: policy.buildSystemPrompt(repoLinked),
    ...(repoLinked ? { disallowedTools: REPO_DENYLIST_PATTERNS } : {}),
    ...(effectiveResumeSessionId &&
    SESSION_ID_PATTERN.test(effectiveResumeSessionId)
      ? { resume: effectiveResumeSessionId }
      : {}),
  };
}

export type CopilotErrorKind = 'binary_not_found' | 'auth_failed' | 'generic';

// 'binary_not_found' means the query never started at all: the SDK module
// failed to load, or its own startup validation threw before a single
// message was yielded — not "the `claude` executable wasn't on PATH"
// (nothing looks a binary up on PATH any more). The copy matches: "go
// install the CLI yourself" is not a recovery action a user has in this
// failure mode.
function describeSdkStartupError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Couldn't start Claude Code's runtime — ${detail}. If this persists, try reinstalling Waypoint.`;
}

// Capped so a runaway/looping runtime can't grow this without bound; only
// the tail is useful for a diagnostic message anyway.
const STDERR_TAIL_LIMIT = 4000;

export type SessionResult =
  | {
      kind: 'done';
      fullText: string;
      sessionId: string | null;
      needsRepoLink: boolean;
    }
  | { kind: 'error'; errorKind: CopilotErrorKind; message: string };

export interface SessionHooks {
  /** Fired synchronously, in stream order, for every text delta. */
  onChunk: (text: string) => void;
  /** Fired synchronously, exactly once, when the session finishes with a
   * reply. Mirrors the resolved SessionResult but delivered eagerly (not
   * via the returned promise) so callers see it in the same synchronous
   * position the pre-extraction code sent it from — no microtask reordering
   * relative to onChunk. */
  onDone: (result: {
    fullText: string;
    sessionId: string | null;
    needsRepoLink: boolean;
  }) => void;
  /** Fired synchronously, exactly once, when the session ends in failure
   * (and onDone is not also called). */
  onError: (error: { errorKind: CopilotErrorKind; message: string }) => void;
  /** Fired whenever a new underlying Query starts (including the
   * stale-session retry's replacement Query), so a caller can track it for
   * out-of-band teardown (e.g. app-quit). */
  onQueryStarted: (query: Query) => void;
  /** Fired whenever a Query this caller was told about via onQueryStarted
   * stops being the live one for this session — either it ended (normally
   * or via error) or a retry replaced it. Callers should only untrack a
   * query if it's still the one they have on record, the same
   * compare-before-delete a naive requestId-keyed map needs. */
  onQueryEnded: (query: Query) => void;
}

// The SDK invocation core. Builds options from `policy`, resolves cwd/repo
// linkage fresh on every attempt, drives the query() generator loop,
// retries once (transparently) on a stale resumed session, and always calls
// Query.close() explicitly — `for await` exiting via `break`/`return`
// closes only the inner iterator Query's own [Symbol.asyncIterator] hands
// back, not Query itself, which is what actually tears down the transport
// and the CLI subprocess (architecture doc §5.1 invariant 6).
export function runSession(
  policy: SessionPolicy,
  prompt: string,
  hooks: SessionHooks,
): Promise<SessionResult> {
  return new Promise<SessionResult>((resolve) => {
    // A failure can be reported by more than one path for the same run (a
    // result_error already sent, then the generator throwing on its way
    // out) — settled makes finishing idempotent so a second, less useful
    // outcome can never override the first. Chunks aren't gated by this:
    // any number of them can legitimately precede the one terminal event.
    let settled = false;
    const finish = (result: SessionResult) => {
      if (settled) return;
      settled = true;
      if (result.kind === 'done') {
        hooks.onDone({
          fullText: result.fullText,
          sessionId: result.sessionId,
          needsRepoLink: result.needsRepoLink,
        });
      } else {
        hooks.onError({ errorKind: result.errorKind, message: result.message });
      }
      resolve(result);
    };

    function attempt(
      effectiveResumeSessionId: string | undefined,
      allowRetryOnStaleSession: boolean,
      // Set only by the stale-session retry call below — never on the
      // first attempt, and never combined with a real promptPreamble in
      // practice (a retry starts a fresh session with no proposals of its
      // own yet to report on).
      retryContinuationNote?: string,
    ) {
      // Resolved per attempt, not once per session: a stale-session retry
      // re-runs, and the checkout could in principle have gone away between
      // the two attempts.
      const repoRoot = resolveRepoRoot(policy.repoPath ?? undefined);
      // cwd is deliberately the caller's own linked checkout when there is
      // one, and os.tmpdir() otherwise — never this main process's
      // inherited cwd, which could be an arbitrary directory nobody chose.
      // The project-level .claude/settings.json + CLAUDE.md leak that the
      // old neutral-directory default happened to prevent is carried
      // instead by `settingSources: []`, already unconditional in
      // buildSdkOptions: confirmed live that it isolates a real repo's own
      // project-local config even when cwd IS that repo.
      const preamble = retryContinuationNote ?? policy.promptPreamble;
      const fullPrompt = preamble ? `${preamble}\n\n${prompt}` : prompt;

      // Consumed (not just ignored) for the same diagnostic value the old
      // stderr tail had: a thrown generator error alone doesn't always say
      // what the runtime actually complained about.
      let stderrTail = '';

      (async () => {
        let query: Query;
        try {
          query = await runCopilotQuery({
            prompt: fullPrompt,
            options: {
              ...buildSdkOptions(
                policy,
                effectiveResumeSessionId,
                repoRoot.linked,
              ),
              cwd: repoRoot.cwd,
              env: buildEnv(),
              stderr: (data: string) => {
                stderrTail = (stderrTail + data).slice(-STDERR_TAIL_LIMIT);
              },
            },
          });
        } catch (err) {
          // Nothing ever started — no process, no generator, nothing to
          // clean up.
          finish({
            kind: 'error',
            errorKind: 'binary_not_found',
            message: describeSdkStartupError(err),
          });
          return;
        }

        hooks.onQueryStarted(query);
        let sawResult = false;
        let sessionIdFromInit: string | null = null;

        try {
          // eslint-disable-next-line no-restricted-syntax
          for await (const message of query) {
            const parsed = parseSdkMessage(message);
            switch (parsed.kind) {
              case 'session':
                sessionIdFromInit = parsed.sessionId;
                break;
              case 'text_delta':
                hooks.onChunk(parsed.text);
                break;
              case 'result':
                sawResult = true;
                finish({
                  kind: 'done',
                  fullText: parsed.fullText,
                  sessionId: parsed.sessionId ?? sessionIdFromInit,
                  needsRepoLink: parsed.needsRepoLink,
                });
                break;
              case 'result_error': {
                sawResult = true;
                // Resuming a session id that's aged out (or was otherwise
                // removed) fails deterministically and identically on every
                // retry with the SAME id — there was previously no code path
                // anywhere that ever cleared it, so this permanently bricked
                // the conversation. Retrying once, transparently, as a fresh
                // (non-resumed) session avoids that: the fresh run's own
                // result carries a new session id, which the renderer
                // persists over the stale one — self-healing it for every
                // message after this one.
                //
                // NOT invisible in the UI: the chat transcript still shows
                // full history while the model itself has none — asked
                // about something from earlier, it would say outright "this
                // is the start of our chat," visibly contradicting the
                // panel above it. RETRY_CONTINUATION_NOTE fixes the actual
                // symptom by telling the MODEL what happened, reusing the
                // promptPreamble mechanism rather than a new IPC
                // event/renderer-state/UI channel.
                if (
                  allowRetryOnStaleSession &&
                  effectiveResumeSessionId &&
                  STALE_SESSION_PATTERN.test(parsed.message)
                ) {
                  // Explicit, not left to for-await's implicit iterator
                  // close on the way out: Query's [Symbol.asyncIterator]
                  // returns an INNER generator, not itself, so breaking or
                  // returning out of this loop only closes that inner
                  // iterator — Query's own close() (which is what actually
                  // tears down the transport and kills the subprocess) is
                  // bypassed unless called directly.
                  query.close();
                  hooks.onQueryEnded(query);
                  attempt(undefined, false, RETRY_CONTINUATION_NOTE);
                  return;
                }
                finish({
                  kind: 'error',
                  errorKind: 'generic',
                  message:
                    parsed.message ||
                    'Claude Code reported an error while responding.',
                });
                break;
              }
              case 'auth_error':
                finish({
                  kind: 'error',
                  errorKind: 'auth_failed',
                  message: parsed.message,
                });
                break;
              case 'ignored':
              default:
                break;
            }
          }
        } catch (err) {
          // The generator threw mid-iteration — the equivalent of an
          // unexpected child-process crash. close() here is a no-op if the
          // crash already tore the process down; it's the safety net for a
          // throw that didn't (e.g. a parse failure unrelated to the
          // child's own lifecycle).
          query.close();
          hooks.onQueryEnded(query);
          if (!sawResult) {
            const detail = err instanceof Error ? err.message : String(err);
            const tail = stderrTail.trim();
            finish({
              kind: 'error',
              errorKind: 'generic',
              message: tail
                ? `Claude Code exited without responding — ${detail}: ${tail}`
                : `Claude Code exited without responding — ${detail}.`,
            });
          }
          return;
        }

        hooks.onQueryEnded(query);
        // sawResult covers 'result' and 'result_error' (including one that
        // triggered a retry above, which returns before reaching here at
        // all). It does NOT cover 'auth_error' — that branch already called
        // finish() itself, so this check would try to finish a second time;
        // what actually makes that harmless is finish's own settled guard,
        // not this flag. A generator that simply ends without ever yielding
        // a result OR an auth error is the one real gap: an unreported
        // failure the caller would otherwise hang waiting on.
        if (!sawResult) {
          const tail = stderrTail.trim();
          finish({
            kind: 'error',
            errorKind: 'generic',
            message: tail
              ? `Claude Code exited without responding: ${tail}`
              : 'Claude Code exited without responding.',
          });
        }
      })();
    }

    attempt(policy.resumeSessionId, true);
  });
}

export type { Query };
