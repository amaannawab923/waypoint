// The ONLY file in this app that imports @anthropic-ai/claude-agent-sdk.
// Two reasons this is split out rather than importing the SDK directly in
// copilotRunner.ts:
//
// 1. The SDK is pure ESM ("type": "module", no CJS build) and this app's
//    main process is compiled by webpack into a commonjs2/umd bundle. A
//    static `import` here would be lowered to `require(...)` by ts-loader +
//    webpack, which throws ERR_REQUIRE_ESM at runtime on Node versions that
//    don't (yet, or ever, depending on Electron's embedded Node) auto-interop
//    CJS-require-of-ESM. `/* webpackIgnore: true */` on the dynamic import
//    below tells webpack to leave the `import()` call untouched in the
//    emitted bundle, so it executes as a genuine ESM dynamic import at
//    runtime — which has always worked from CommonJS, on every Node version,
//    with no interop feature dependency at all. Confirmed live in dev mode
//    through the real electronmon + ts-loader + webpack pipeline.
// 2. Isolating the import to one file means every other file that needs the
//    SDK (copilotRunner.ts, copilotAuth.ts's probeToken) — and every test for
//    them — depends on THIS module's exported functions, not on the real
//    package. Tests jest.mock this file wholesale, the same shape
//    copilotRunner.test.ts used to use for jest.mock('child_process'). No
//    test in this codebase ever loads the real ESM package.
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
// `resolution-mode: 'import'` is required on every type reference to this
// package: TypeScript's node16 resolver otherwise reports TS1541/TS1542 for a
// type-only import of an ESM-only package from a CommonJS file. It is a
// compile-time resolution hint only — nothing survives into the emitted
// bundle, and the runtime load is still the dynamic import() below.
import type {
  McpServerConfig,
  Options,
  Query,
  SDKMessage,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

// Lazily imported once, cached — query() is called once per Copilot turn
// (this app makes no long-lived streaming-input session), so a fresh dynamic
// import per call would just be repeated, pointless module-resolve overhead;
// the module itself is stateless, so caching the resolved namespace object is
// safe to share across calls.
type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk', {
  with: { 'resolution-mode': 'import' },
});

let sdkPromise: Promise<ClaudeAgentSdk> | null = null;

function loadSdk(): Promise<ClaudeAgentSdk> {
  if (!sdkPromise) {
    sdkPromise = import(
      /* webpackIgnore: true */ '@anthropic-ai/claude-agent-sdk'
    );
  }
  return sdkPromise;
}

// Wraps a real ChildProcess to satisfy the SDK's SpawnedProcess interface —
// only needed because spawnClaudeCodeProcess is overridden below (see
// unpackAsarPath for why). ChildProcess already implements almost all of this
// shape natively; the adapter exists for the couple of fields whose types
// don't line up 1:1, and is kept explicit and typed rather than cast, since
// it crosses an external SDK's own interface boundary.
function toSpawnedProcess(child: ChildProcess): SpawnedProcess {
  return {
    get stdin() {
      return child.stdin as NonNullable<ChildProcess['stdin']>;
    },
    get stdout() {
      return child.stdout as NonNullable<ChildProcess['stdout']>;
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

// On a supported platform the SDK resolves `command` to an absolute path to
// its own vendored native `claude` binary (an optional platform package, e.g.
// @anthropic-ai/claude-agent-sdk-darwin-arm64) — not to a bare
// 'node'/'bun'/'deno' string needing a system JS runtime. That path runs
// through node_modules, which electron-builder seals into app.asar.
// child_process.spawn is a raw OS syscall (execve underneath) with no idea
// app.asar is anything but an ordinary file, so spawning a path that runs
// through it fails outright — confirmed live: `spawn ENOTDIR`, thrown
// synchronously during query()'s own construction, before any SDKMessage is
// yielded.
//
// package.json's build.asarUnpack is the first half of the fix: it makes
// electron-builder place a real, spawnable copy of the binary at the parallel
// app.asar.unpacked path. That alone is NOT enough (confirmed live: ENOTDIR
// persisted) — the SDK's own path resolution has no idea this app unpacks
// anything, so it still hands back the .asar path. This function is the
// second half: translate .asar -> .asar.unpacked in the resolved command path
// before spawning. It is the sibling case to node-pty's already-handled
// in-process .node addon, for a spawned-as-a-separate-process binary.
//
// Confirmed live end to end: a packaged build launched with PATH stripped to
// bare /usr/bin:/bin:/usr/sbin:/sbin (no Node, Bun, or Deno reachable at all)
// completed a real query() turn with both halves in place, and failed with
// the exact ENOTDIR above with either half missing. Neither half is optional.
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
// less this file reshapes the SDK's own surface, the less there is to keep in
// sync with future SDK versions.
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
        const child = spawn(
          unpackAsarPath(spawnOptions.command),
          spawnOptions.args,
          {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            // Documented as safe to hand straight to Node's spawn({signal}):
            // this is a signal ProcessTransport forwards only after its own
            // stdin-EOF + grace window has run, not the caller's raw
            // AbortController.signal — passing the latter here would race
            // ahead of the CLI's graceful shutdown (see SpawnOptions.signal's
            // own doc comment in the SDK's types).
            signal: spawnOptions.signal,
          },
        );
        // child_process.spawn defaults every stdio stream to 'pipe'. The
        // SDK's SpawnedProcess interface has no stderr member, and its own
        // stderr consumption (the thing options.stderr above would otherwise
        // reach) lives entirely inside the built-in local-spawn path that
        // providing spawnClaudeCodeProcess bypasses — so with nothing
        // reading child.stderr here, the OS pipe buffer eventually fills and
        // the child blocks in write(2) forever: a silent hang mid-turn, no
        // error, no terminal IPC event. The pre-migration CLI-subprocess
        // probeToken carried this exact defense (`child.stderr.resume()`)
        // for the same reason; it has to be re-established here.
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => options.stderr?.(chunk));
        // A stream-level error (e.g. EPIPE) must not become an unhandled
        // 'error' event of its own — process failure is already reported via
        // the child's own 'error'/'exit', forwarded through toSpawnedProcess.
        child.stderr?.on('error', () => {});
        return toSpawnedProcess(child);
      },
    },
  });
}

// Re-exported so no other file in this app ever has to name the SDK package
// itself — including in a type position, which under TypeScript's node16
// resolver would otherwise need the same 'resolution-mode' attribute above at
// every single import site.
export type { McpServerConfig, Options, Query, SDKMessage };
