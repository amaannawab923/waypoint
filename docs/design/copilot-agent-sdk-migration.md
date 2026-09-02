# Copilot Agent SDK migration — implementation design

Status: design proposal, not yet built. Branch: `feat/copilot-codebase-grounding-impl`.
Author: architecture pass, cut from this worktree's uncommitted V1+V2+V3 work.

This document specifies exactly what changes, file by file, to replace
`copilotRunner.ts`'s `spawn('claude', argv)` subprocess model with
`@anthropic-ai/claude-agent-sdk`'s `query()` function, folding V3's
codebase-grounding mechanics (already built against the old CLI in this
worktree) into the new runtime in the same pass. Read
`waypoint-frontend/src/main/copilot/copilotRunner.ts` and
`docs/design/copilot-v3-codebase-grounding.md` before implementing — this
design ports their reasoning, it does not replace it. Nothing in V1
(read tools), V2 (propose/approve), or V3 (grounding) changes from the
user's perspective; only the mechanism underneath changes.

## 0. The one architectural fact that reshapes this design

**`@anthropic-ai/claude-agent-sdk@0.3.258` is a pure-ESM package
(`"type": "module"`, `"main": "sdk.mjs"`, no CJS build) being consumed from
a main-process bundle that webpack emits as a `commonjs2`/`umd` library**
(`.erb/configs/webpack.config.main.prod.ts` merges
`webpack.config.base.ts`'s `output.library: { type: 'commonjs2' }` with its
own `library: { type: 'umd' }`; same shape in dev). A plain top-level
`import { query } from '@anthropic-ai/claude-agent-sdk'` in `copilotRunner.ts`
gets compiled by ts-loader (`module: 'nodenext'`, confirmed in
`webpack.config.base.ts`) into a `require('@anthropic-ai/claude-agent-sdk')`
call in the emitted `main.js` — and a synchronous CommonJS `require()` of an
ESM-only package throws `ERR_REQUIRE_ESM` unless the exact Node runtime
Electron 35 embeds happens to support Node's newer "require(esm)"
auto-interop (landed as a default-on feature only in fairly recent Node
22.12+/23.x builds) **and** webpack's own external-handling doesn't get in
the way first (see below). This is not safe to assume either way — it is
exactly the kind of thing §12 says must be spiked, not guessed.

**UPDATE — both risks below were spiked live against a real packaged build
(`npm run package`, launched directly with `PATH` stripped to bare
`/usr/bin:/bin:/usr/sbin:/sbin` — no Node, Bun, or Deno reachable at all) and
the original hypothesis for the second risk was WRONG in an important way.
The actual root cause and fix are documented in the corrected paragraph
below and in §2/§12; the original "auto-detects node/bun/deno on PATH"
framing is kept struck-through-in-spirit here only so the reasoning trail is
visible, not because it's the right mental model going forward.**

There's a second, sharper version of the same class of risk, or so it
seemed before this was actually spiked: ~~the SDK does not shell out to the
user's globally-installed `claude` CLI binary at all (unlike today's
`spawn('claude', ...)`). It spawns its own vendored CLI via a JS runtime it
auto-detects (`executable?: 'bun' | 'deno' | 'node'`, per `sdk.d.ts`). A
packaged Electron app ships to users who very often have no system Node,
Bun, or Deno installed at all.~~ **What actually happens (confirmed live):**
on a supported platform (darwin-arm64 confirmed; the SDK's `package.json`
lists sibling optional packages for other platforms, e.g.
`@anthropic-ai/claude-agent-sdk-darwin-x64`/`-linux-x64`/etc., presumed
symmetric though only darwin-arm64 was actually exercised here), the SDK
resolves `command` to an **absolute path to its own vendored, self-contained
native `claude` binary** shipped as one of those optional platform packages
— not to a bare `'node'`/`'bun'`/`'deno'` string requiring a system runtime
lookup at all. The `executable` option and its `'bun'|'deno'|'node'` union
apparently govern a different, narrower path (not exercised by this spike);
they are not the mechanism that fires for a normal `query()` call on a
supported platform.

That resolves the "no system JS runtime" fear — but it surfaces a real,
different, packaging-specific bug: this vendored binary lives inside
`node_modules`, which electron-builder seals into `app.asar` by default.
`app.asar` is a single file masquerading as a directory tree only to
Electron's own *patched* `fs` calls — `child_process.spawn` is a raw OS
syscall (`execve` underneath) that has no idea `app.asar` is anything but an
ordinary file, so a spawn attempt against a path running through it fails
outright (confirmed live: `spawn ENOTDIR`, thrown synchronously inside the
SDK's own `query()` construction, before a single `SDKMessage` is yielded).
This is Electron's own well-documented `asarUnpack` caveat, encountered here
for the first time in this codebase for a *spawned-as-a-separate-process*
binary rather than an in-process native addon (`node-pty`'s `.node` file is
the existing precedent for the addon case, already handled; this is the
sibling case for a standalone executable).

**The fix is two parts, both verified together to resolve it, neither
sufficient alone:**

1. **`package.json`'s `build.asarUnpack`** must be extended from its
   current native-addon-only pattern (`"**\*.{node,dll}"`) to also cover the
   SDK's vendored platform binaries, so a real, spawnable copy exists on
   disk outside the archive:
   ```json
   "asarUnpack": [
     "**\\*.{node,dll}",
     "**/node_modules/@anthropic-ai/claude-agent-sdk*/**"
   ]
   ```
   Confirmed live: `electron-builder` correctly places the real file at the
   parallel `app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/
   node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` path once
   this is set.
2. **This alone is not enough** — confirmed live, `spawn ENOTDIR` persisted
   even after step 1, because the SDK's own internal path resolution has no
   awareness that this app unpacks anything; it still computes and hands
   back the `.../app.asar/...` path, not the unpacked sibling.
   `spawnClaudeCodeProcess` (see §2) must translate `.asar` → `.asar.unpacked`
   in the resolved `command` path before actually calling `child_process.spawn`
   — the standard, documented Electron workaround for this exact class of
   problem, applied here for the first time in this codebase. Confirmed
   live: with both fixes in place, the packaged app — launched with `PATH`
   containing no Node/Bun/Deno at all — completed a real `query()` turn
   correctly.

**Founder-relevant framing:** the actual risk here was real and *did* block
the migration until fixed, but it was a different, more mundane bug than
originally hypothesized (an Electron packaging caveat, not a missing-runtime
product gap) — and it now has a verified, two-line fix rather than an
unverified mitigation. The ESM/CJS interop half of §0 (below) was also
confirmed live, unchanged from the original hypothesis: real, mechanical,
narrow, already fixed by the `webpackIgnore` pattern.

## 1. Dependency & build wiring

`@anthropic-ai/claude-agent-sdk` is already a `waypoint-frontend/package.json`
dependency (0.3.258) — that part is done. What's still needed:

**`waypoint-frontend/package.json`'s `build.asarUnpack`** — required, not
optional; see §0's corrected finding for why (a spawned-as-a-process vendored
binary, not an in-process addon, and it's the sibling case to `node-pty`'s
already-handled `.node` file). Confirmed live to be necessary — the packaged
app fails with `spawn ENOTDIR` without it:
```json
"asarUnpack": [
  "**\\*.{node,dll}",
  "**/node_modules/@anthropic-ai/claude-agent-sdk*/**"
]
```

**`waypoint-frontend/release/app/package.json`** — add the SDK here too, as
a second, independent `npm install` target:

```json
"dependencies": {
  "node-pty": "^1.1.0",
  "@anthropic-ai/claude-agent-sdk": "^0.3.258"
}
```

**Why:** `webpack.config.base.ts` computes its `externals` array directly
from this file's `dependencies` keys —
`import { dependencies as externals } from '../../release/app/package.json'`
— and everything in `release/app/node_modules` (populated by `npm install`
run inside `release/app/`, wired through `postinstall` →
`.erb/scripts/electron-rebuild.js` + `link-modules.ts`, then symlinked into
`src/node_modules`/`.erb/dll/node_modules` for dev resolution) is what
electron-builder actually packages (`build.files: ["dist", "node_modules",
"package.json"]` with `build.directories.app: "release/app"`, confirmed in
`package.json`'s `build` block). `node-pty` is already externalized this
exact way for the same underlying reason: a package whose behavior depends
on files/binaries resolved relative to its own installed location breaks if
webpack bundles its JS into `dist/main/main.js`, physically relocating it
away from those sibling files. The SDK's optional platform packages
(`@anthropic-ai/claude-agent-sdk-linux-x64` etc., visible in its
`package.json`) are exactly this shape — vendored CLI/runtime assets
resolved relative to the installed package — so it needs the same treatment,
not because it has a native `.node` addon like `node-pty` (it likely
doesn't — its `executable` option spawns a *separate* JS runtime process
rather than loading a native binding into the Electron process itself), but
because the risk of webpack corrupting its internal path resolution is the
same category of problem.

One difference from `node-pty`: `node-pty` needs `electron-rebuild`
(ABI-matching a native addon against Electron's bundled Node) because it
loads directly into the Electron process. The SDK's own subprocess is a
**separate OS process** with its own Node/Bun/Deno runtime — there is no
native addon loaded into Electron's process to rebuild. `postinstall`'s
`npm run rebuild` step should keep working unmodified (it doesn't touch the
new dependency), but confirm this rather than assume it — if `electron-rebuild`
walks all of `release/app/node_modules` looking for native bindings, it
should just find nothing to do for this package and no-op cleanly; verify
that's actually what happens rather than silently skipping a real native
component if one turns out to exist.

**Jest.** `package.json`'s `jest.moduleDirectories` already includes
`"release/app/node_modules"` (again, matching the `node-pty` precedent), so
once §1's `release/app/package.json` change lands, `ts-jest` *could*
resolve the package by path — but should never actually load it. `ts-jest`'s
default transform is CJS, and this is the exact ESM-interop trap
`CopilotPanel.tsx`'s own existing comment about avoiding the `uuid` package
already documents hitting once in this codebase (search `generateLocalId`'s
comment in `CopilotPanel.tsx`). §5's seam module exists precisely so tests
never need to load the real package at all — they `jest.mock('./claudeSdkClient')`
wholesale, the same shape `copilotRunner.test.ts` already uses for
`jest.mock('child_process')` today. No jest config change should be needed
if that discipline holds; flag it if it doesn't.

## 2. New file: `claudeSdkClient.ts` — the one SDK touch point

```ts
// waypoint-frontend/src/main/copilot/claudeSdkClient.ts
//
// The ONLY file in this app that imports @anthropic-ai/claude-agent-sdk.
// Two reasons this is split out rather than importing the SDK directly in
// copilotRunner.ts:
//
// 1. The SDK is pure ESM ("type": "module", no CJS build) and this app's
//    main process is compiled by webpack into a commonjs2/umd bundle. A
//    static `import` here would be lowered to `require(...)` by ts-loader
//    + webpack, which throws ERR_REQUIRE_ESM at runtime on Node versions
//    that don't (yet, or ever, depending on Electron's embedded Node) auto-
//    interop CJS-require-of-ESM. `/* webpackIgnore: true */` on the dynamic
//    import below tells webpack to leave the `import()` call untouched in
//    the emitted bundle, so it executes as a genuine ESM dynamic import at
//    runtime — which has always worked from CommonJS, on every Node version,
//    with no interop feature dependency at all.
// 2. Isolating the import to one file means every other file that needs the
//    SDK (copilotRunner.ts, copilotAuth.ts's probeToken) — and every test
//    for them — depends on THIS module's exported functions, not on the
//    real package. Tests jest.mock this file wholesale, the same shape
//    copilotRunner.test.ts already uses for jest.mock('child_process').
//    No test in this codebase ever loads the real ESM package.
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'child_process';
import type { Readable, Writable } from 'stream';

// Lazily imported once, cached — query() is called once per Copilot turn
// (this app makes no long-lived streaming-input session), so a fresh
// dynamic import per call would just be repeated, pointless module-resolve
// overhead; the module itself is stateless, so caching the resolved
// namespace object is safe to share across calls.
let sdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null;
function loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!sdkPromise) {
    sdkPromise = import(/* webpackIgnore: true */ '@anthropic-ai/claude-agent-sdk');
  }
  return sdkPromise;
}

// Wraps a real ChildProcess to satisfy the SDK's SpawnedProcess interface —
// only needed because we override spawnClaudeCodeProcess below (see its
// comment for why). ChildProcess already implements almost all of this
// shape natively; the adapter exists for the couple of fields whose types
// don't line up 1:1 (exitCode/signalCode are ChildProcess getters already,
// kill/on/once/off already match) — kept explicit and typed rather than
// cast, since this crosses an external SDK's own interface boundary.
function toSpawnedProcess(child: ChildProcess): {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on: ChildProcess['on'];
  once: ChildProcess['once'];
  off: ChildProcess['off'];
} {
  return {
    get stdin() {
      return child.stdin as Writable;
    },
    get stdout() {
      return child.stdout as Readable;
    },
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => child.kill(signal),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

// De-risks §0's second problem — CONFIRMED LIVE, not the originally-
// hypothesized "no system node/bun/deno" gap. On a supported platform, the
// SDK resolves `command` to an absolute path to its own vendored native
// `claude` binary (an optional platform package, e.g.
// @anthropic-ai/claude-agent-sdk-darwin-arm64) — not to a bare
// 'node'/'bun'/'deno' string. That path runs through node_modules, which
// electron-builder seals into app.asar. child_process.spawn is a raw OS
// syscall (execve underneath) with no idea app.asar is anything but an
// ordinary file — spawning a path that runs through it fails outright
// (confirmed live: `spawn ENOTDIR`, thrown synchronously during query()'s
// own construction, before any SDKMessage is yielded).
//
// package.json's build.asarUnpack (§1) is the first half of the fix — it
// makes electron-builder place a real, spawnable copy of this binary at the
// parallel app.asar.unpacked path. That alone is NOT enough (confirmed
// live: ENOTDIR persisted) — the SDK's own internal path resolution has no
// idea this app unpacks anything, so it still hands back the .asar path,
// not the unpacked sibling. This function's whole job is the second half:
// translate .asar -> .asar.unpacked in the resolved command path before
// actually spawning — the standard, documented Electron workaround for a
// spawned-as-a-separate-process binary living in an unpacked path (the
// sibling case to node-pty's already-handled in-process .node addon).
//
// Confirmed live end-to-end: a packaged build, launched with PATH stripped
// to bare /usr/bin:/bin:/usr/sbin:/sbin (no Node, Bun, or Deno reachable at
// all), completed a real query() turn correctly with both halves of this
// fix in place — and failed with the exact ENOTDIR above with either half
// missing. Neither half is optional.
function unpackAsarPath(commandPath: string): string {
  const asarSegment = `.asar${path.sep}`;
  return commandPath.includes(asarSegment)
    ? commandPath.replace(asarSegment, `.asar.unpacked${path.sep}`)
    : commandPath;
}

export interface RunCopilotQueryArgs {
  prompt: string;
  options: Options;
}

// The one exported entry point copilotRunner.ts (and copilotAuth.ts's
// probeToken) call. Returns the SDK's own Query (an AsyncGenerator<SDKMessage>
// with .close()/.interrupt() etc.) unmodified — callers iterate it exactly
// like any other async generator. Not wrapped further than necessary: the
// less this file reshapes the SDK's own surface, the less there is to keep
// in sync with future SDK versions.
export async function runCopilotQuery({
  prompt,
  options,
}: RunCopilotQueryArgs): Promise<Query> {
  const sdk = await loadSdk();
  return sdk.query({
    prompt,
    options: {
      ...options,
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = spawn(unpackAsarPath(spawnOptions.command), spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
        });
        return toSpawnedProcess(child);
      },
    },
  });
}

export type { SDKMessage };
```

Needs `import path from 'path';` alongside the existing `child_process`/`stream` imports at the top of this file.

**Why a function returning `Promise<Query>` rather than re-exporting `query`
directly:** `copilotRunner.test.ts`'s existing convention
(`jest.mock('child_process')`, asserting on captured `spawnCalls`) needs an
equivalent seam. `jest.mock('./claudeSdkClient')` replacing
`runCopilotQuery` with a function that returns a hand-built fake async
generator is the direct analog — see §9.

## 3. `copilotRunner.ts` — the rewrite

This file's shape stays the same (`registerCopilotIpc`, `runAttempt`,
`killAllCopilotProcesses`, the retry-on-stale-session logic, the
IPC-payload validation) — what changes is what `runAttempt` does with a
validated request: build an `Options` object instead of an argv array, call
`runCopilotQuery` instead of `spawn`, and iterate an async generator instead
of parsing stdout lines.

### 3.1 `buildOptions()` replaces `buildArgs()`

One-to-one mapping from today's CLI flags to `Options` fields — nothing here
is new syntax, only a different transport for the identical values already
verified live (see the migration brief's spike results):

```ts
import type { Options } from '@anthropic-ai/claude-agent-sdk';

function buildOptions(
  resumeSessionId: string | undefined,
  conversationId: string | undefined,
  repoLinked: boolean,
): Options {
  return {
    // --setting-sources '' → settingSources: [] (unconditional, exactly as
    // today — sdk.d.ts confirms the default when OMITTED is "all sources
    // loaded, matches CLI defaults" — i.e. the isolation this app depends on
    // is opt-IN, not the SDK's own default. Never omit this field.
    settingSources: [],
    // --tools '' / --tools Read,Glob,Grep → tools: [] / tools: REPO_READ_TOOLS.
    // Per sdk.d.ts: "tools" is the base set; "allowedTools" only skips the
    // approval prompt for named tools and does NOT restrict availability on
    // its own — the exact trap the migration brief's spike caught mid-
    // investigation. tools must be set explicitly on every call; never rely
    // on allowedTools alone.
    tools: repoLinked ? REPO_READ_TOOLS : [],
    mcpServers: mcpServersConfig(conversationId),
    strictMcpConfig: true, // --strict-mcp-config
    allowedTools: repoLinked ? [...MCP_TOOLS, ...REPO_READ_TOOLS] : MCP_TOOLS,
    includePartialMessages: true, // --include-partial-messages
    // Bare string, NOT { type: 'preset', preset: 'claude_code', append }
    // and NOT { type: 'custom', prompt, snapshot: true } — see §8 for why
    // both of those are wrong for this specific prompt.
    systemPrompt: buildSystemPrompt(repoLinked),
    ...(repoLinked ? { disallowedTools: REPO_DENYLIST_PATTERNS } : {}),
    ...(resumeSessionId && SESSION_ID_PATTERN.test(resumeSessionId)
      ? { resume: resumeSessionId }
      : {}),
  };
}
```

`--output-format stream-json` / `-p` / `--verbose` have no `Options`
equivalent because they were CLI-invocation-mode flags, not conversation
behavior — `query()` always streams typed `SDKMessage` objects (the SDK's
native mode), so there is nothing to opt into. `--bare` was never passed
before and still isn't: omitting `apiKey`-shaped options is what preserves
ambient-login reuse, confirmed by the migration brief's own spike (a bare
`query({prompt, options: {}})` reused the machine's `claude login` session
with zero extra config).

**`mcpServersConfig()` replaces `mcpConfigArg()`** — same validation, no
`JSON.stringify`, no `--strict-mcp-config` string flag (now the boolean
above):

```ts
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

function mcpServersConfig(
  conversationId: string | undefined,
): Record<string, McpServerConfig> {
  const apiBaseUrl = process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';
  const validConversationId =
    conversationId && CONVERSATION_ID_PATTERN.test(conversationId)
      ? conversationId
      : undefined;
  return {
    waypoint: {
      type: 'http',
      url: `${apiBaseUrl}/mcp/copilot`,
      ...(validConversationId
        ? { headers: { 'x-waypoint-conversation-id': validConversationId } }
        : {}),
    },
  };
}
```

Verified live against the real backend in the migration brief's spike — a
plain object, no config-file round trip, nothing to stringify.

`REPO_READ_TOOLS`, `MCP_TOOLS`, `REPO_DENYLIST_PATTERNS`,
`CONVERSATION_ID_PATTERN`, `SESSION_ID_PATTERN`, `REPO_PATH_PATTERN`,
`OUTCOME_PREAMBLE_MAX_LENGTH`, `resolveRepoRoot()`, `buildSystemPrompt()` —
**all port unchanged, verbatim**, including every comment explaining why
each one exists. None of that reasoning depended on CLI-argv mechanics; it
was always about which tools/paths/prompt-branch a given `repoLinked`
resolves to, which is transport-independent.

### 3.2 `buildEnv()` — ports unchanged

The SDK's `env` option doc is explicit ("this value REPLACES the subprocess
environment entirely — it is not merged with `process.env`. Spread
`process.env` yourself...") — this is **exactly** what `child_process.spawn`'s
own `env` option already does, and exactly what today's `buildEnv()` already
does (`{ ...process.env, PATH: [...] }`, conditionally adding
`CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR`). No behavior change, no code
change beyond the function's call site. One line becomes dead weight,
though — `COMMON_INSTALL_DIRS`'s PATH-append logic existed specifically to
help a GUI-launched app's minimal PATH find a `claude` binary a terminal
shell's PATH would have. **That binary is no longer being located at all**
— the SDK spawns its own vendored runtime via `spawnClaudeCodeProcess`
(§2), not a `claude` found on `PATH`. Delete `COMMON_INSTALL_DIRS` and its
PATH-append loop; keep the rest of `buildEnv()` (the subscription-token
branch, the `CLAUDE_CONFIG_DIR` conditional) untouched — that reasoning is
about *credential* resolution, which is unaffected by how the subprocess
itself gets found.

**`CLAUDE_CLI_PATH` becomes dead in `copilotRunner.ts`/`copilotAuth.ts`
specifically** — this file's own reference to it, and its `COMMON_INSTALL_DIRS`
lookup, are correctly deleted. **Correction, found during review: the
variable and the pattern are NOT dead app-wide.** `copilotConnect.ts` (the
`claude setup-token` connect-a-subscription-token flow) has its own,
completely independent copy of both `COMMON_INSTALL_DIRS` and
`CLAUDE_CLI_PATH`, and it is correctly, deliberately untouched by this
migration — see the new §5a below for why. An earlier draft of this section
claimed both were dead everywhere and that no `spawn('claude', ...)` call
site remained after this migration (repeated in §11); neither claim is
true. If `CLAUDE_CLI_PATH` is referenced in any user-facing docs or support
scripts outside this worktree, they should say it still governs the connect
flow specifically, not the general Copilot runtime.

### 3.3 Iterating the `Query` async generator

Replaces the `spawn` + `stdout`/`stderr` event-listener block. `Query`
extends `AsyncGenerator<SDKMessage, void>` (confirmed in `sdk.d.ts`), so a
`for await` loop replaces the line-buffering/`processLine` dispatch:

```ts
function runAttempt(
  effectiveResumeSessionId: string | undefined,
  allowRetryOnStaleSession: boolean,
) {
  const repoRoot = resolveRepoRoot(repoPath);
  const fullPrompt = outcomePreamble ? `${outcomePreamble}\n\n${prompt}` : prompt;

  (async () => {
    let query: Query;
    try {
      query = await runCopilotQuery({
        prompt: fullPrompt,
        options: {
          ...buildOptions(effectiveResumeSessionId, conversationId, repoRoot.linked),
          cwd: repoRoot.cwd,
          env: buildEnv(),
        },
      });
    } catch (err) {
      // A rejected runCopilotQuery (e.g. loadSdk()'s dynamic import itself
      // failed, or the SDK's own startup validation threw synchronously)
      // is this flow's equivalent of today's child.on('error', ENOENT) —
      // no process ever started, so there's no close()/kill() cleanup to
      // register, just a terminal error to report.
      finish({
        requestId,
        type: 'error',
        kind: 'binary_not_found', // see §3.5 for why this kind is kept despite no longer meaning "claude not on PATH"
        message: describeSdkStartupError(err),
      });
      return;
    }

    inFlight.set(requestId, query);
    let sawResult = false;
    let sessionIdFromInit: string | null = null;

    try {
      for await (const message of query) {
        const parsed = parseSdkMessage(message);
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
              needsRepoLink: parsed.needsRepoLink,
            });
            break;
          case 'result_error':
            sawResult = true;
            if (
              allowRetryOnStaleSession &&
              effectiveResumeSessionId &&
              STALE_SESSION_PATTERN.test(parsed.message)
            ) {
              forgetIfCurrent(query);
              runAttempt(undefined, false);
              return;
            }
            finish({
              requestId,
              type: 'error',
              kind: 'generic',
              message: parsed.message || 'Claude Code reported an error while responding.',
            });
            break;
          case 'auth_error':
            finish({ requestId, type: 'error', kind: 'auth_failed', message: parsed.message });
            break;
          case 'ignored':
          default:
            break;
        }
      }
    } catch (err) {
      // The generator itself threw mid-iteration — the SDK's equivalent of
      // an unexpected child process crash (today's child.on('error') after
      // spawn succeeded, or a non-zero exit with sawResult still false).
      forgetIfCurrent(query);
      if (!sawResult) {
        finish({
          requestId,
          type: 'error',
          kind: 'generic',
          message: `Claude Code exited without responding — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    forgetIfCurrent(query);
  })();
}
```

**What this drops, deliberately:** the manual `stdoutBuffer`/`split('\n')`
line-buffering, the multi-byte-UTF-8-boundary `setEncoding('utf8')`
reasoning, the `stderrTail` capture-for-diagnostics logic, and the
close/error-event double-fire de-duplication via `settled`/`finish` for the
process layer specifically (the `finish`/`settled` guard itself stays —
it's still needed for the `done`/`error` terminal-event idempotency at the
IPC layer, just no longer racing a process's own `'error'`/`'close'`
events). All of that existed to compensate for parsing raw bytes off a pipe;
`for await (const message of query)` yields already-parsed, already-typed
`SDKMessage` objects, so there is no boundary-splitting or encoding concern
left to manage. The `stderr` callback (`Options.stderr?: (data: string) =>
void`) is available if a diagnostic tail is still wanted for the generic
error message — worth wiring for parity with today's `stderrTail` in error
messages, but it's genuinely optional polish, not a correctness requirement,
since `err instanceof Error` on a thrown generator failure should already
carry a useful message.

### 3.4 `inFlight` map and `killAllCopilotProcesses`

```ts
const inFlight = new Map<string, Query>();

export function killAllCopilotProcesses(): void {
  Array.from(inFlight.values()).forEach((query) => query.close());
  inFlight.clear();
}
```

`Query.close()` ("forcefully ends the query, cleaning up all resources
including... the CLI subprocess") is the direct replacement for
`child.kill()` — same call sites (`main.ts`'s `before-quit` and
`window.on('closed')` equivalents), same semantics, no change needed
upstream of this file. `forgetIfCurrent` ports unchanged (compares by
reference, same reasoning as today: a stale-session retry starts a second
`Query` under the same `requestId`, and only the live one should be
tracked).

**`Options.abortController`** is available but not needed for this file's
own use — nothing in this app currently exposes a user-facing "stop
generating" control (today's CLI flow doesn't either; `killAllCopilotProcesses`
only fires on app teardown). Not wiring it now is consistent with "don't add
capability the product hasn't asked for" — noted here so it isn't
mistaken for an oversight if a future feature wants mid-stream cancellation.

### 3.5 `CopilotErrorKind` — one semantic note, no shape change

`'binary_not_found'` is kept as a `CopilotErrorKind` value (no change to
`preload.ts`'s type, no change to `CopilotPanel.tsx`'s handling) but its
**meaning changes**: it used to mean literally "the `claude` executable
wasn't found on `PATH`" (a `child.on('error')` with `err.code === 'ENOENT'`).
Under the SDK there is no `claude` binary lookup at all — the closest
equivalent failure is `runCopilotQuery` itself rejecting (the dynamic
import failing to resolve, or the SDK's own subprocess spawn failing for a
reason `unpackAsarPath` (§2) doesn't cover — e.g. the unpacked binary itself
missing or unexecutable on disk). The **kind**
name stays the same so `CopilotPanel.tsx`'s existing UI copy
("Claude Code isn't installed (or not on PATH) — install it and run `claude
login`...") keeps rendering — but that copy is now actively wrong for this
new failure mode and should be updated as part of this migration, in
`copilotRunner.ts`'s error message construction, not in the renderer (the
renderer only renders `message`, it doesn't hardcode this copy itself —
confirm this by re-checking `CopilotPanel.tsx`'s `binary_not_found` branch
at implementation time). A more accurate message here: something like
`"Couldn't start Claude Code's runtime — <details>. If this persists, try
reinstalling Waypoint."` — since there's no longer a "go install this CLI
yourself" recovery action available to a user in this failure mode.

## 4. `parseStreamEvent.ts` → `parseSdkMessage.ts`

Renamed (not just edited) because its whole premise changes: today's file
parses **one line of raw JSON text**; the replacement parses **one already-
typed `SDKMessage` object**. `JSON.parse`/try-catch/`typeof parsed !==
'object'` guards all disappear — there is no serialization boundary to
defend against malformed text, since the SDK itself is the producer of
these typed objects. The **discrimination logic itself ports almost 1:1** —
confirmed field-for-field against `sdk.d.ts`:

| Old (`stream-json` line shape) | New (`SDKMessage` variant) | Notes |
|---|---|---|
| `{type:'system', subtype:'init', session_id}` | `SDKSystemMessage` (`type:'system', subtype:'init'`) | same `session_id` field |
| `{type:'system', subtype:'api_retry', error:'authentication_failed'}` | `SDKAPIRetryMessage` (`type:'system', subtype:'api_retry', error: SDKAssistantMessageError`) | `error` is now a typed union (`'authentication_failed' \| 'oauth_org_not_allowed' \| ...`) instead of a bare string — the `=== 'authentication_failed'` check ports unchanged, but the type gives compile-time coverage of the other members if this file ever wants to branch on them |
| `{type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}` | `SDKPartialAssistantMessage` (`type:'stream_event', event: BetaRawMessageStreamEvent`) | identical nested shape — `event.delta.type === 'text_delta'` check ports unchanged |
| `{type:'result', is_error:false, result, session_id}` | `SDKResultSuccess` (`type:'result', subtype:'success', is_error, result, session_id`) | `result` is `string` (non-optional) on the typed success variant — the old `typeof event.result === 'string'` guard becomes unconditional access |
| `{type:'result', is_error:true, result? / errors?, session_id}` | `SDKResultError` (`type:'result', subtype:'error_during_execution' \| 'error_max_turns' \| ...`, `errors: string[]`, `session_id`) | `errors` is now non-optional `string[]` (not `result` OR `errors`) — `extractErrorMessage`'s two-field fallback simplifies to just reading `errors.join('; ')` |

```ts
// waypoint-frontend/src/main/copilot/parseSdkMessage.ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type ParsedStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'result'; fullText: string; sessionId: string | null; needsRepoLink: boolean }
  | { kind: 'result_error'; message: string; sessionId: string | null }
  | { kind: 'auth_error'; message: string }
  | { kind: 'ignored' };

// Unchanged from parseStreamEvent.ts, verbatim — the sentinel-stripping
// logic never depended on how the text arrived.
const NEEDS_REPO_SENTINEL = '[[NEEDS_REPO]]';
function stripNeedsRepoSentinel(fullText: string): { text: string; needsRepoLink: boolean } {
  /* ...unchanged... */
}

export function parseSdkMessage(message: SDKMessage): ParsedStreamEvent {
  if (message.type === 'system' && message.subtype === 'init') {
    return { kind: 'session', sessionId: message.session_id };
  }
  if (
    message.type === 'system' &&
    message.subtype === 'api_retry' &&
    message.error === 'authentication_failed'
  ) {
    return {
      kind: 'auth_error',
      message: 'Not logged in to Claude Code — run `claude login` in a terminal, then try again.',
    };
  }
  if (message.type === 'stream_event') {
    const inner = message.event;
    if (
      inner.type === 'content_block_delta' &&
      inner.delta.type === 'text_delta'
    ) {
      return { kind: 'text_delta', text: inner.delta.text };
    }
    return { kind: 'ignored' };
  }
  if (message.type === 'result') {
    if (message.subtype === 'success') {
      const { text, needsRepoLink } = stripNeedsRepoSentinel(message.result);
      return { kind: 'result', fullText: text, sessionId: message.session_id, needsRepoLink };
    }
    return {
      kind: 'result_error',
      message: message.errors.join('; ') || 'Claude Code reported an error while responding.',
      sessionId: message.session_id,
    };
  }
  return { kind: 'ignored' };
}
```

**One real behavior question, not a mechanical port:** the migration brief
notes new top-level `SDKMessage` variants this parser has never had to
consider (`rate_limit_event`/`SDKRateLimitEvent`, `system/status`, hook
events, `task_summary`, `thinking_tokens`, and — per the fuller union just
read from `sdk.d.ts` — many more: `SDKPermissionDeniedMessage`,
`SDKModelRefusalFallbackMessage`, `SDKCompactBoundaryMessage`, etc.). The
`if`-chain above with a final `return { kind: 'ignored' }` already handles
every one of these correctly **by construction** — anything not explicitly
matched falls through to `ignored`, exactly like today's `default:` case in
`copilotRunner.ts`'s `processLine` switch. No new code is needed to "handle"
them; the design decision is simply confirming that silent pass-through
remains correct for all of them for this app's current feature set (V1/V2/V3
only ever need session-id, text deltas, success/error results, and one auth-
failure signal) — worth a one-line comment in the file itself saying this is
deliberate, so a future reader doesn't mistake the missing branches for gaps.

`parseStreamEvent.test.ts` → `parseSdkMessage.test.ts`: same test cases,
rewritten to construct typed `SDKMessage` fixture objects directly instead
of JSON-stringifying-then-parsing lines. The `[[NEEDS_REPO]]`
stripping/`needsRepoLink` cases port with zero logic change since
`stripNeedsRepoSentinel` itself doesn't change.

## 5. `copilotAuth.ts` — `probeToken()` is in scope too

Not named in the migration brief's file list, but it's the same category of
code as `copilotRunner.ts`: a direct `spawn('claude', ['-p', '--safe-mode',
...])` call (lines ~98–103 today), independently spawning the CLI to
validate a candidate subscription token. Leaving this on the old CLI-argv
path while `copilotRunner.ts` moves to the SDK would mean the "clean
cutover, no old code path left behind" call in §11 isn't actually true —
there'd still be one `spawn('claude', ...)` call site alive in the codebase,
with its own independent `PATH`/binary-resolution assumptions that this
migration is otherwise removing. Recommend migrating it in the same PR.

```ts
// probeToken(), rewritten:
async function probeToken(token: string): Promise<ProbeResult> {
  try {
    const query = await runCopilotQuery({
      prompt: 'Reply with exactly: OK',
      options: {
        settingSources: [],
        tools: [],
        env: buildProbeEnv(token), // unchanged — already a full replacement object, matches the SDK's own env semantics
        cwd: os.tmpdir(),
      },
    });
    let sawText = false;
    for await (const message of query) {
      const parsed = parseSdkMessage(message);
      if (parsed.kind === 'result') {
        sawText = true;
        return { ok: true };
      }
      if (parsed.kind === 'result_error' || parsed.kind === 'auth_error') {
        return { ok: false, message: parsed.message };
      }
    }
    if (!sawText) return { ok: false, message: "Couldn't validate the token — try again." };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Failed to validate the token.',
    };
  }
}
```

`--safe-mode` was never the isolation mechanism of record even in
`copilotRunner.ts` (see that file's own extensive comment on why
`--safe-mode` was rejected there in favor of `--setting-sources ''` — it
silently empties MCP too, which happens not to matter for THIS probe since
it uses no MCP servers, but there's no reason to keep a different, weaker
isolation posture here than the main runner uses). Use `settingSources: []`
here too, for consistency, not because a live bug was found. `--tools ''`
maps directly to `tools: []`, matching the probe's existing intent (no tool
access needed for a "reply with OK" check). `--output-format json`
(non-streaming) has no equivalent to preserve — `query()` always streams;
the probe just consumes the generator until a `result`/`result_error`,
which is a few more lines but not a real behavior change (`PROBE_TIMEOUT_MS`'s
20s manual timeout should be kept, wrapping the whole probe in a
`Promise.race` against a timer, since `query()` has no built-in wall-clock
timeout of its own to lean on instead).

## 5a. `copilotConnect.ts` — deliberately unmigrated, added during review

**Not part of this migration, and correctly so — recorded here because an
earlier draft of §3.2/§11 incorrectly implied it was.** `copilotConnect.ts`
runs `claude setup-token` (the CLI's own long-lived-token command) inside a
real pseudo-terminal via `node-pty`, so a user can connect a subscription
token without opening a terminal themselves. This is confirmed, in the
file's own header comment, to genuinely require a real TTY — a plain piped
stdin produces no output and hangs. The Agent SDK exposes no equivalent to
an interactive TUI; there is nothing to migrate this onto. It keeps its own
independent `COMMON_INSTALL_DIRS`/`CLAUDE_CLI_PATH` (locating the real
`claude` binary on `PATH`, exactly as `copilotRunner.ts` used to) and its
own `pty.spawn('claude', ...)` call site.

**Product-copy consequence worth being deliberate about:** this migration's
whole headline is that using Copilot no longer requires a system Claude
Code install — true for every day-to-day Copilot turn. It is NOT true for
*connecting* a subscription token in the first place, which still needs the
real CLI on `PATH`. `copilotRunner.ts`'s `binary_not_found` failure message
was rewritten away from "Claude Code isn't installed (or not on PATH)"
specifically because that's now wrong for a normal run — but it is still
the correct, accurate message for a `copilotConnect.ts` failure. Checked directly (not assumed): `CopilotConnectModal.tsx` itself makes no
claim about CLI installation at all, and `copilotConnect.ts`'s "Claude Code
isn't installed (or not on PATH)" message (line ~114) only ever surfaces
from a connect-flow failure specifically — it never appears alongside
`copilotRunner.ts`'s general-run error copy in the same screen or context.
Each message is accurate for its own failure mode and a user never sees
both at once, so there's no actual contradiction to fix here, just the
now-corrected false claim above that the CLI dependency was removed
app-wide.

## 6. `preload.ts` / `main.ts` — no changes

Confirmed by construction, not assumed: `registerCopilotIpc`'s exported
signature (`(getWindow: () => BrowserWindow | null) => void`), the
`copilot:run` / `copilot:stream` channel names and payload shapes
(`StreamPayload`'s `chunk`/`done`/`error` union), and `killAllCopilotProcesses`'s
signature are all unchanged by this migration (§3.3/§3.4). `main.ts`'s
`registerCopilotIpc(() => mainWindow)` call site and `before-quit`/`closed`
hooks calling `killAllCopilotProcesses()` need zero edits. `preload.ts`'s
`electronHandler.copilot.runPrompt(args, handlers)` bridge — the
`requestId`-correlated subscribe/unsubscribe logic, the `done`/`error`
self-removing listener — is pure IPC plumbing with no CLI-vs-SDK awareness
at all; it stays byte-for-byte identical. See §7 for why this holds all the
way out to the renderer.

## 7. Everything else in this worktree's V3 diff — unchanged, reused as-is

Per the migration brief's framing ("figure out how much survives UNCHANGED
because it doesn't touch the runner at all"), confirmed by reading each:

- **`waypoint-backend/src/db/schema/projects.ts`, `validation/projects.schema.ts`,
  `services/projects.service.ts`** (the `repoPath` column, shape validation,
  `validateRepoPath`) — zero coupling to how the runner invokes Claude Code;
  these validate and persist a filesystem path, full stop. Unchanged.
- **`waypoint-backend/src/routes/mcp.routes.ts`, `src/mcp/*`** — the MCP
  server is a stateless HTTP endpoint the SDK's `mcpServers.waypoint` config
  points at exactly the way the CLI's `--mcp-config` did (§3.1's
  `mcpServersConfig()` posts to the identical `/mcp/copilot` URL with the
  identical header). The backend has no idea whether its caller is a CLI
  subprocess or an SDK-spawned one — verified live in the migration brief's
  own spike (`list_projects` through this exact config against the real
  running backend). Unchanged.
- **`waypoint-frontend/src/main/repoLink.ts`, `preload.ts`'s `repo.chooseFolder`,
  the `Codebase.tsx` settings page, `CopilotRepoLinkCard` in
  `CopilotPanel.tsx`, `useCurrentRouteProject.ts`** — the native folder
  dialog, project-settings picker, and in-chat link card all write through
  `updateProject(id, { repoPath })`, a REST call with no runner involvement.
  `useCurrentRouteProject.ts` resolves `repoPath` from the currently-open
  route and hands it to `runPrompt`'s `repoPath` argument — a plain string
  over the same unchanged IPC contract (§6). None of this needs to know
  what runs on the other side of that IPC call. Unchanged.
- **`CopilotPanel.tsx`'s `runAndPersist`, streaming/error/retry state
  machine, `needsRepoLink` handling, outcome-preamble building** — all
  consume `window.electron.copilot.runPrompt`'s existing
  `onChunk`/`onDone`/`onError` callback shape, which (§6) is byte-for-byte
  identical after this migration. Unchanged.
- **`CopilotProposalCard.tsx`, `useCopilotProposals.ts`, the backend
  `proposals.service.ts`/`proposals.routes.ts`** — V2's propose/approve
  flow is entirely mediated by the MCP server (above) and REST endpoints;
  it has no dependency on the runner's invocation mechanism at all beyond
  "the `propose_*` tools must be reachable and auto-approved," which §8
  confirms holds unchanged. Unchanged.

The practical shape of this PR is therefore small in file count despite
being a real architectural change: `copilotRunner.ts` (rewritten),
`copilotAuth.ts` (one function rewritten), a new `claudeSdkClient.ts`, a
rename of `parseStreamEvent.ts` → `parseSdkMessage.ts`, `buildEnv()`'s dead
`COMMON_INSTALL_DIRS` code removed, `release/app/package.json` + its lockfile,
and the corresponding test files. Nothing under `src/renderer/` or
`waypoint-backend/` changes at all.

## 8. Tool grants, denylist, and system prompt — ported mechanics, one real decision

**Tool grants (`tools`/`allowedTools`/`disallowedTools`) and the denylist
pattern list (`REPO_DENYLIST_PATTERNS`)** port with no semantic change —
§3.1 already shows the exact field mapping, and every pattern in
`REPO_DENYLIST_PATTERNS` (`Read(./.env)`, `Grep(./.git/**)`, etc.) is copied
verbatim, since `disallowedTools` accepts the identical pattern syntax the
CLI's `--disallowedTools` did (confirmed live in the migration brief's
spike against a real fixture repo with planted secrets — same hard
tool-level error, same silent-exclusion-from-Grep-results behavior).

**V2's zero-friction `propose_*` behavior is preserved by construction, not
by adding anything:** `allowedTools` already includes every `mcp__waypoint__propose_*`
name (ported unchanged in `MCP_TOOLS`), and `Options.canUseTool` is simply
never set. Per `sdk.d.ts`'s own doc comment on `allowedTools` — "List of
tool names that are auto-allowed without prompting for permission. These
tools will execute automatically without asking the user for approval" —
omitting `canUseTool` entirely means there is no permission callback to
gate anything; every allowed tool (the MCP tools, and `Read`/`Glob`/`Grep`
when linked) runs with zero interactive friction, exactly matching today's
headless-CLI behavior where no TTY meant no prompt could appear anyway. **Do
not add a `canUseTool` callback for this migration** — it's explicitly out
of scope per the brief, and it isn't needed to preserve current behavior;
adding one (even one that unconditionally approves) would only add a new
code path with no behavioral purpose and a real one (a stale/buggy future
edit accidentally gating something) it doesn't have today.

**The one real decision: `systemPrompt` as a bare string, not a preset, and
not `snapshot: true`.** `buildSystemPrompt(repoLinked)` ports verbatim
(§3's port list) and is passed as `systemPrompt: buildSystemPrompt(repoLinked)`
— a plain `string`, not `{ type: 'preset', preset: 'claude_code', append:
... }` and not `{ type: 'custom', prompt: ..., snapshot: true }`. Two
independent reasons:

1. **Product fit.** `{ preset: 'claude_code', append }` layers Copilot's
   prompt onto Claude Code's own full default system prompt — the same
   "you are Claude Code, an interactive CLI tool..." agentic-coding framing
   `--append-system-prompt` layered onto today, which `COPILOT_SYSTEM_PROMPT_BASE`
   already fully overrides the *persona* of ("You are Copilot, a personal
   AI assistant inside Waypoint...") while still technically inheriting
   whatever else that default prompt establishes about tool-use conventions,
   formatting, and coding-agent behavior not relevant to a ticket-focused
   assistant. The SDK gives a clean way to not carry any of that: a bare
   string **replaces** the system prompt entirely rather than appending to
   an existing one. This is a genuine, deliberate product improvement the
   migration enables, not something forced by the transport change — flagged
   in §12 as something the founder should sanity-check with a side-by-side
   manual comparison during implementation (tone/formatting could shift
   subtly even though the explicit instructions are unchanged), since it's
   a real behavior difference from today's CLI-era prompt, not a neutral
   port.
2. **Correctness, not just preference — `snapshot: true` would introduce a
   real bug for this specific prompt.** Per `sdk.d.ts`: "A bare string /
   string[] prompt is always [snapshot:] false; use `{ type: 'custom',
   prompt, snapshot: true }` to opt a custom prompt in" — recording is OFF
   by default for a bare string, which is required here, not incidental.
   V3's whole design (§0 of the V3 doc) is a repo that can become linked
   *mid-conversation*, resumed via the same `claudeSessionId` across many
   turns. If `snapshot: true` were used, the FIRST turn's rendered prompt
   (built while `repoLinked` was still `false`) would be recorded and
   replayed verbatim on every later `resume`, even after the repo gets
   linked — while `tools`/`disallowedTools` (which are NOT part of prompt
   recording, they're independent per-call `Options`) would correctly
   start granting `Read`/`Glob`/`Grep`. The model would then hold real tool
   access while its own system prompt kept insisting it has none and kept
   instructing it to emit `[[NEEDS_REPO]]` — the exact "two sources of
   truth that can disagree" failure mode the original CLI-era
   `resolveRepoRoot`/`buildArgs`/`buildSystemPrompt` design went out of its
   way to prevent by deriving both from one `repoLinked` boolean per call.
   A bare string's default `snapshot: false` (render fresh every request)
   is what actually preserves that invariant under the SDK — this isn't
   giving up a caching optimization, it's the only setting that's correct
   for a system prompt whose content is meant to change turn-to-turn.

## 9. Test plan

**`claudeSdkClient.test.ts` (new):** verify `unpackAsarPath` correctly
translates a `.asar`-containing path to its `.asar.unpacked` sibling, and
leaves a non-`.asar` path (and a filename that merely happens to contain
the substring `.asar` outside a real path-boundary position) untouched —
mock `child_process.spawn` the same way `copilotRunner.test.ts` already
does, asserting the actual command string `spawn` was called with. Also
worth covering: the `ChildProcess` → SDK `SpawnedProcess` adapter's
getters/methods forward correctly, and `runCopilotQuery` forwards its
`prompt`/`options` through to `sdk.query()` unchanged. `runCopilotQuery`'s
real interop behavior (does the dynamic import actually resolve, does a
real spawned process actually respond) belongs in §12's live verification,
already done — not a mocked unit test; mocking `loadSdk()`'s dynamic import
here would just test that a function calls another function, not real
interop behavior.

**`copilotRunner.test.ts` — same test cases, new mocking seam.** Replace
`jest.mock('child_process')` (the `spawnMock`/`FakeChild`
stdin/stdout/stderr `EventEmitter` scaffolding) with
`jest.mock('./claudeSdkClient')`, where the mock's `runCopilotQuery` returns
a hand-built fake async generator:

```ts
const runCopilotQueryMock = jest.fn();
jest.mock('./claudeSdkClient', () => ({
  runCopilotQuery: (...args: unknown[]) => runCopilotQueryMock(...args),
}));

function makeFakeQuery(messages: SDKMessage[]): Query {
  let i = 0;
  const closeMock = jest.fn();
  const gen: AsyncGenerator<SDKMessage, void> & { close: () => void } = {
    close: closeMock,
    async next() {
      if (i < messages.length) return { value: messages[i++], done: false };
      return { value: undefined, done: true };
    },
    async return() {
      return { value: undefined, done: true };
    },
    async throw(e) {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
  return gen;
}
```

Every existing assertion that inspected `spawnCalls[0].args` for a specific
CLI flag becomes an assertion on `runCopilotQueryMock.mock.calls[0][0].options`
for the equivalent `Options` field — e.g. today's `expect(spawnCalls[0].args).toContain('--tools')`
+ checking the next array element becomes `expect(runCopilotQueryMock.mock.calls[0][0].options.tools).toEqual(['Read','Glob','Grep'])`.
The **test names and scenarios themselves are unchanged** — repo-linked vs
unlinked tool grants, the `cwd`/`os.tmpdir()` fallback, resume-session-id
regex rejection, stale-session retry, conversationId header validation,
outcomePreamble prepending and its length cap — only the shape of what's
asserted against changes, from argv strings to typed option fields. This is
the single largest test-file rewrite in the migration, but it's a mechanical
one once the seam is in place, not a design risk.

**`parseSdkMessage.test.ts`** (renamed from `parseStreamEvent.test.ts`): same
cases, fixture objects instead of JSON-stringified lines (§4).

**`copilotAuth.test.ts`:** extend for the rewritten `probeToken` using the
same `jest.mock('./claudeSdkClient')` seam.

**No changes needed to `preload.test.ts` or `CopilotPanel.test.tsx`** — per
§6/§7, nothing in their subject files changes.

## 10. Manual QA — same convention as V3's own design doc

This repo's test suite has never shelled out to a real `claude` binary
(`copilotRunner.test.ts` fully mocks its spawn boundary; this design's §9
keeps that discipline with the new seam), so the following stay manual,
matching `docs/design/copilot-v3-codebase-grounding.md`'s own §8 convention:

- Ambient-login reuse — already verified live through the real Electron main
  process in dev mode (§12); re-confirm once more through the final
  `claudeSdkClient.ts` implementation, not the torn-down spike code.
- **A packaged, non-macOS build** (Windows/Linux, whichever this app ships)
  exercising the full `spawn ENOTDIR` → `asarUnpack` → path-translation
  sequence §12 verified on `darwin-arm64` — confirm the SDK's optional
  per-platform package naming and the `asarUnpack` glob actually match on
  that platform too; this is the one part of §12's finding not yet checked
  cross-platform.
- The connected-subscription-token path (`copilotAuth.ts`'s
  `CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR` branch) end to end through
  the rewritten `probeToken` and a real run.
- A real linked repo: `Read`/`Glob`/`Grep` actually working against it
  (repeat of the brief's own canary-constant check, through the shipped UI).
- The `[[NEEDS_REPO]]` sentinel firing correctly under the new bare-string
  `systemPrompt` (§8's product-fit change means this is worth re-checking,
  not assumed identical to the old `--append-system-prompt` behavior).
- Layer 2 of the denylist (`disallowedTools` blocking `.env`/`.git/config`
  reads) against a real fixture repo, matching V3's own spike.
- The stale-`--resume` self-healing retry, now via `STALE_SESSION_PATTERN`
  matched against `SDKResultError.errors` instead of a CLI's `result`/`errors`
  JSON fields — confirm the SDK's own error text for a resume against a
  pruned/nonexistent session id still matches this pattern (it may differ
  in exact wording from the CLI's; if so, `STALE_SESSION_PATTERN` needs
  updating, not the retry logic itself).
- A packaged `darwin-arm64` build — already verified live in §12 (this was
  the highest-priority check in the whole migration; it's done, not
  pending). Re-run once more against the final, non-spike `claudeSdkClient.ts`
  as a sanity check that nothing shifted between the spike and the real
  implementation.

## 11. Migration scope and sequencing: clean cutover, one PR, per-file commits

**Clean cutover, no feature flag.** The founder's framing ("pause V3, pivot
straight to this migration, fold V3 in") is already a decision against
running two parallel efforts; keeping the old `spawn('claude', argv)` path
alive behind a flag would mean maintaining two independent runner
implementations — double the test surface, double the places
`REPO_DENYLIST_PATTERNS`/`buildSystemPrompt`/tool-grant logic could drift
apart — for a transition period nothing in this brief asks for. This repo's
own conventions (`AGENTS.md`: "keep PRs small and focused"; no evidence of
long-lived feature-flag infrastructure anywhere in this codebase for
runtime-swap purposes) point the same direction. Delete
`copilotRunner.ts`'s `spawn`/argv code and `copilotAuth.ts`'s `spawn`-based
`probeToken` outright in this PR; there is no `CLAUDE_CLI_PATH`-shaped
escape hatch to preserve for "fall back to the old path" in either of those
two files specifically (§3.2). **This is scoped to the Copilot run/probe
paths only** — `copilotConnect.ts`'s own, entirely separate `spawn('claude',
...)` call (via `node-pty`, for the interactive `claude setup-token` flow)
is correctly, deliberately left in place; see §5a. "Clean cutover" describes
this migration's own two files, not a claim that no CLI subprocess exists
anywhere in the app.

**One PR, delivered as per-file commits, not one bundled commit** — matching
this project's own established convention for multi-phase work in this
repo. A reasonable commit sequence: (1) `release/app/package.json` +
lockfile; (2) `claudeSdkClient.ts` (new, with its own test); (3)
`parseStreamEvent.ts` → `parseSdkMessage.ts` rename + rewrite + test; (4)
`copilotRunner.ts` rewrite + test; (5) `copilotAuth.ts`'s `probeToken`
rewrite + test; (6) dead-code removal (`COMMON_INSTALL_DIRS`) folded into
whichever of (2)/(4) touches `buildEnv()`, not a separate commit, since it's
a few deleted lines inside a file already being edited for a real reason.
Merge via `gh pr merge --merge` once green, not squash — preserves that
per-file commit history rather than collapsing it.

## 12. Electron-compatibility risk — RESOLVED, spiked live against a real packaged build

**This section originally specified a mandatory pre-implementation spike.
That spike has now been run, live, to completion — not a standalone script,
the real thing: `@anthropic-ai/claude-agent-sdk` added to both
`waypoint-frontend/package.json` and `release/app/package.json`, `build.asarUnpack`
extended per §0/§1, a temporary `spawnClaudeCodeProcess` override added to
`main.ts`, then torn down once it answered its questions (working tree is
clean of spike code; only the two permanent fixes — `asarUnpack` and the
real `claudeSdkClient.ts` mechanism — remain, exactly as specified in §0/§1/§2
above, which already reflect what was actually verified, not the original
hypothesis).** What was run, and what it found:

1. **Dev mode** (`npm run start`, real electronmon + ts-loader + webpack
   pipeline, not a standalone script): a `webpackIgnore`-annotated dynamic
   `import()` plus a real `query()` call, from inside the actual Electron
   main process. Result: **no `ERR_REQUIRE_ESM`**, a real reply came back
   (`SDK_SPIKE_OK`, requested verbatim), ambient `claude login` auth reused
   with zero extra config. This confirms §0's ESM/CJS interop half
   completely — mechanical, exactly as hypothesized, no surprises.
2. **A full `npm run package` build**, launched by its own binary directly
   (`ElectronReact.app/Contents/MacOS/ElectronReact`, not via any npm
   script) with `PATH` replaced entirely by `/usr/bin:/bin:/usr/sbin:/sbin`
   — genuinely zero Node, Bun, or Deno reachable anywhere, the actual
   "no system JS runtime" scenario a standalone script structurally cannot
   exercise (it always runs under a real Node itself). **First attempt
   failed** with `spawn ENOTDIR`, thrown synchronously inside the SDK's own
   `query()` construction. Diagnosis (captured via the spike's own logging
   of the exact `spawnClaudeCodeProcess` arguments): the SDK resolved
   `command` to an absolute path to its own vendored native `claude` binary
   (an optional per-platform package, `@anthropic-ai/claude-agent-sdk-darwin-arm64`
   on this machine) — **not** to a bare `'node'`/`'bun'`/`'deno'` string as
   originally hypothesized — and that path ran through `app.asar`, which a
   raw `child_process.spawn` cannot execute into.
3. **Fix attempt 1** (`build.asarUnpack` extended per §0/§1 alone): still
   failed, same `ENOTDIR` — confirmed the real file now existed at
   `app.asar.unpacked/...`, but the SDK's own internal path resolution had
   no idea this app unpacks anything, so it kept handing back the `.asar`
   path.
4. **Fix attempt 2** (added the `.asar` → `.asar.unpacked` path translation
   in `spawnClaudeCodeProcess`, per §2's now-corrected `unpackAsarPath`):
   **succeeded** — the packaged app, still launched with the fully stripped
   `PATH`, completed a real `query()` turn correctly (`SDK_SPIKE_OK` came
   back again, this time through the packaged binary with no system runtime
   anywhere in reach).

**Both fixes are required together; neither alone is sufficient** — this was
proven by testing each fix in isolation, not assumed. §0/§1/§2 above already
specify the corrected mechanism; there is nothing left in this section to
build. The original "no system Node/Bun/Deno on PATH" fear that motivated
this spike turned out not to be the actual failure mode at all — the SDK's
own vendored per-platform binary sidesteps that concern entirely on a
supported platform. The real risk was a more mundane, well-precedented
Electron packaging caveat, now fixed with a verified, permanent two-part
change (`asarUnpack` config + one path-translation line), not a workaround
carrying residual risk forward.

**What remains genuinely unverified, worth calling out rather than
overclaiming:** only `darwin-arm64` was actually exercised. The SDK's
`package.json` lists sibling optional packages for other platforms
(presumed `-darwin-x64`, `-linux-x64`, `-win32-x64` or similar — not
individually confirmed), and this exact `spawn ENOTDIR` → `asarUnpack` →
still-fails → path-translation-fixes-it sequence should be re-run on at
least one non-macOS packaged build before this is treated as proven
cross-platform, not just cross-architecture. This is a manual-QA item (§10),
not a reason to hold implementation — the mechanism (unpack the vendored
binary, translate its path past `.asar`) generalizes across platforms by
construction; only the exact glob/package names might need adjusting per
platform if their layout differs.

## Summary

- **The core risk this design exists to de-risk (§0/§2/§12) — RESOLVED,
  verified live against a real packaged build, not just designed against
  documentation.** The SDK is pure ESM inside a commonjs2/umd Electron-main
  webpack bundle — fixed via a `webpackIgnore`'d dynamic import, confirmed
  live in dev mode, no surprises. Separately, and NOT as originally
  hypothesized ("no system Node/Bun/Deno on PATH"): the SDK spawns its own
  vendored **native per-platform `claude` binary**, which electron-builder
  seals into `app.asar` by default — a raw `child_process.spawn` can't
  execute into an asar archive. Verified live with a packaged build launched
  under a `PATH` containing zero Node/Bun/Deno: fails with `spawn ENOTDIR`
  until BOTH `build.asarUnpack` (unpacks the real binary to disk) AND a
  `.asar`→`.asar.unpacked` path translation in `spawnClaudeCodeProcess`
  (§2's `unpackAsarPath`) are in place — then succeeds, completely, with
  zero system JS runtime anywhere in reach. §0/§1/§2 already reflect this
  corrected, verified mechanism; §12 documents the full spike trail. Only
  `darwin-arm64` was exercised — other platforms are a manual-QA item, not
  a design gap.
- **`systemPrompt`: bare string, not the `claude_code` preset, and not
  `snapshot: true`** (§8). Preset+append would silently reintroduce Claude
  Code's own default agentic-coding framing under Copilot's ticket-focused
  persona — a real product-fit regression risk worth a manual side-by-side
  check. `snapshot: true` would be an actual correctness bug, not just a
  missed optimization: it would let a resumed conversation's system prompt
  go stale relative to `tools`/`disallowedTools` across a mid-conversation
  repo-link transition, since prompt recording and per-call tool grants are
  independent mechanisms in the SDK. A bare string's default
  `snapshot: false` is the one setting that keeps both in sync, which V3's
  own design already depends on via `repoLinked` driving both.
- **IPC contract: unchanged, confirmed by construction (§3.3/§6/§7).**
  `SDKMessage`'s variants map field-for-field onto today's `stream-json`
  line shapes closely enough that `parseSdkMessage.ts`'s discrimination
  logic is close to a 1:1 port of `parseStreamEvent.ts`'s, and `Query`
  being an `AsyncGenerator` slots directly into the same
  chunk/done/error `send()`/`finish()` IPC-push pattern `copilotRunner.ts`
  already uses. Nothing under `src/renderer/` changes.
- **Clean cutover, one PR, per-file commits (§11).** No flag; the old
  `spawn('claude', argv)` code in both `copilotRunner.ts` and (in scope,
  though not named in the brief) `copilotAuth.ts`'s `probeToken` is deleted
  outright, not kept alive behind a toggle.
- **Judgment calls flagged for founder sanity-check before implementation
  starts:**
  1. The `systemPrompt` bare-string decision (§8) is a genuine behavior
     change from today's CLI-era prompt (which inherited Claude Code's own
     default framing via `--append-system-prompt`), not a neutral port —
     recommend a manual side-by-side comparison during implementation.
  2. `spawnClaudeCodeProcess`'s `unpackAsarPath` override (§2) is now
     **verified, not hypothetical** — confirmed live against a packaged
     build under a stripped `PATH`, both required halves (`asarUnpack` +
     the path translation) tested in isolation to confirm neither alone is
     sufficient. Only `darwin-arm64` was exercised; re-verify on at least
     one non-macOS packaged build during manual QA (§10) before treating
     this as proven cross-platform.
  3. `copilotAuth.ts`'s `probeToken` migration (§5) is scope this design
     added beyond the brief's named files, for internal consistency — flagged
     explicitly since it wasn't asked for by name.
  4. `SESSION_ID_PATTERN` re-validation before `resume` is kept (§3.1)
     specifically as defense against a malformed/corrupted DB value reaching
     the SDK call cleanly, even though `resume` is now a typed field with no
     argv-injection risk — the same posture this file already applies to
     `conversationId`/`repoPath`/`outcomePreamble` from any IPC payload,
     regardless of what validated it upstream.
  5. `CopilotErrorKind: 'binary_not_found'`'s user-facing message needs
     rewriting (§3.5) — its old copy ("install Claude Code and run `claude
     login`") is now actively wrong, since there's no CLI binary being
     looked up in this failure mode at all.

## 13. Implementation notes — real deviations found during the build, verified correct

The migration has been implemented and live-verified (dev mode + a packaged
build under a stripped `PATH`, same method as §12, now against the real
permanent code rather than a throwaway spike). Test results: backend 224/224
unchanged; frontend 341/341 (up from the pre-migration 333, reflecting new
`claudeSdkClient.test.ts` coverage). Four small, deliberate deviations from
this doc's code sketches, each a correctness fix rather than a style choice:

1. **Import-attribute syntax for SDK types.** Not anticipated by this doc:
   under this repo's `module: node16` TypeScript config, a bare
   `import type {...} from '@anthropic-ai/claude-agent-sdk'` fails
   (TS1541/TS1542 — ESM types consumed from a CJS-configured file). Fixed
   with a `resolution-mode: 'import'` import attribute, confined to
   `claudeSdkClient.ts`, which re-exports `Options`/`Query`/`SDKMessage`/
   `McpServerConfig` so every other file imports the types from there rather
   than repeating the attribute — this is also exactly what §2's
   single-touch-point isolation rationale already intended.
2. **`parseSdkMessage` checks `is_error` before `subtype`.** §4's sketch
   keyed only on `subtype === 'success'`. That would have been a real
   regression: `copilotAuth.ts`'s own pre-existing test fixture proves an
   expired/401 token comes back as `subtype: 'success'` **with
   `is_error: true`** and the error text living in `result`, not `errors`.
   `extractErrorMessage` keeps the two-field fallback (`result`, then
   `errors.join('; ')`) rather than §4's "simplifies to just `errors`" —
   covered by a dedicated test.
3. **A post-loop `!sawResult` check in `runAttempt`.** §3.3's sketch handles
   a generator that throws mid-iteration but not one that ends cleanly
   (`done: true`) without ever yielding a `result` — which would otherwise
   hang the renderer waiting for a `done`/`error` that never comes. Restores
   the old spawn-based flow's `close`-handler-without-a-result semantics.
   The optional `Options.stderr` sink was also wired for parity with the old
   `stderrTail` in generic error messages.
4. **`toSpawnedProcess` returns the SDK's own `SpawnedProcess` type**
   directly rather than §2's hand-copied structural type — one less surface
   to keep in sync with future SDK versions, behaviorally identical.

§3.5's `binary_not_found` failure mode and §9's `claudeSdkClient.test.ts`
plan were updated in place above to reflect the corrected `unpackAsarPath`
mechanism (they still referenced the superseded `spawnViaElectronNode`
hypothesis as of the implementation pass — now fixed).
