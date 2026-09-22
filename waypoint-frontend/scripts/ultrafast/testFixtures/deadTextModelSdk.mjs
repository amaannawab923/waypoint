// F11 (tech-lead review, 2026-09-22) test fixture: stands in for
// @anthropic-ai/claude-agent-sdk via the ULTRAFAST_SDK_ENTRY escape hatch
// (ultrafast-mcp.js's loadSdk() tries this path first when the env var is
// set — the same seam a packaged build would use to point at the SDK's
// resolved entry file). Real ESM (not CommonJS with a .mjs extension
// slapped on): loadSdk() does a genuine dynamic `import()`, and the real
// SDK package is itself pure ESM, so this needs to be importable the same
// way to stand in for it convincingly.
//
// Its query() returns an async iterable whose very first `next()` call
// rejects — simulating a Claude Agent SDK session that never signs in
// (an expired keychain login, no Copilot token, offline) — the exact
// failure mode the bug this fixture proves fixed did not recover from:
// ultrafast-mcp.js kept handing out the same dead, already-resolved
// shim forever instead of rebuilding on the next browser_task call.
export function query() {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(new Error('not signed in (fixture)'));
        },
      };
    },
  };
}
