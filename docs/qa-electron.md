# Electron QA: automated tests and agent-driven debugging

Two complementary tools, for two different jobs. Both live under
`waypoint-frontend/`.

## 1. Playwright E2E suite — regression tests, CI

The real, repeatable test suite. Drives a genuine production build of the
app (`release/app/dist/main/main.js`, same as `npm run package` ships) via
Playwright's `_electron` module — real IPC handlers, real main-process code,
not just renderer DOM.

```bash
cd waypoint-frontend
npm run test:e2e
```

This builds the app with `WAYPOINT_FEATURE_COPILOT=true` baked in (the flag
is inlined into the renderer bundle at webpack build time, not read at
runtime — see `src/renderer/lib/featureFlags.ts`), then runs everything
under `tests/e2e/`.

**Tests currently assume the real dev backend is reachable**
(`http://localhost:4000` — see `scripts/dev.sh` at the repo root). The
Copilot panel tests hit the real `copilot/conversation` endpoints, so
message history persists across runs — assertions are written to tolerate
that (see the comments in `tests/e2e/copilot-panel.spec.ts`) rather than
assuming an empty conversation.

**Adding a test:** put a new `*.spec.ts` file under `tests/e2e/`, import
`launchApp` from `./fixtures`, and write it like any Playwright test —
`window` is a real `Page` for the renderer, `app.evaluate(...)` runs code in
the real main process. See
[Playwright's Electron docs](https://playwright.dev/docs/api/class-electron)
for the full API surface (native dialog stubbing, main-process state
inspection, etc.).

## 2. Chrome DevTools MCP — live interactive debugging (recommended)

The richest option, and the one to reach for when debugging rather than
just driving: Google's own
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp),
attached to the same `ELECTRON_QA_DEBUG_PORT` bridge described below.
Electron's renderer is genuine Chromium speaking the same CDP, so this
works against the app directly — verified live against Waypoint (it
reports `1: Waypoint (http://localhost:1212/)` and returns a full
accessibility snapshot).

It gives an AI agent (or you) the things a hand-rolled driver doesn't:
**console messages with source-mapped stack traces**, **network
request/response inspection**, an **accessibility-tree snapshot** where
every element has a stable `uid` (so interactions target semantic
elements instead of hand-written CSS selectors), plus performance
tracing, screenshots, and the usual click/fill/hover/press.

Register it once (already done on this machine, at user scope):

```bash
claude mcp add electron-devtools --scope user -- \
  npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222
```

Then just run `npm run start:qa` (below) and the tools are live. Note
that page-scoped tools take a numeric `pageId` (from `list_pages`), not a
string — page-id routing is on by default.

One caveat worth knowing: console and network tools only report what
happened *after* the MCP server attached, so start it (or re-run the
action) before the thing you want to observe.

Google officially tests this against Chrome and Chrome for Testing, not
Electron — it works here because Electron *is* Chromium, but that's our
finding, not a supported guarantee.

## 3. `qa:electron` — a minimal built-in driver

Predates the MCP option above and is kept because it's dependency-light
and needs no MCP client at all — useful from a plain shell script or CI
step. For interactive debugging, prefer the MCP server: this one has no
console or network visibility, which is exactly what turned out to matter
most when diagnosing a real failure (see the git history for
`tests/e2e/fixtures.ts`).

```bash
# One command: builds nothing, just launches the dev app with CDP wired up
# and the Copilot feature flag on.
npm run start:qa

# In another terminal, once it's up:
npm run qa:electron -- targets
npm run qa:electron -- text
npm run qa:electron -- click '[aria-label="Open Copilot"]'
npm run qa:electron -- type '[placeholder="Ask Copilot…"]' 'hello'
npm run qa:electron -- click '[aria-label="Send"]'
npm run qa:electron -- screenshot /tmp/out.png
npm run qa:electron -- eval 'document.title'
```

Each command connects fresh, runs, and disconnects — no persistent session
to manage. Round-trip time is well under a second per command.

### How it works, and why it's built this way

`npm run start:qa` sets two env vars: `WAYPOINT_FEATURE_COPILOT=true` (same
flag as above) and `ELECTRON_QA_DEBUG_PORT=9222`. `src/main/main.ts` reads
that second one and calls `app.commandLine.appendSwitch('remote-debugging-port',
port)` before `app.whenReady()` — the documented, correct way to enable
Chrome DevTools Protocol remote debugging
([electronjs.org](https://www.electronjs.org/docs/latest/api/command-line-switches)).

Passing `--remote-debugging-port` as a bare extra CLI arg through this
project's own `npm run start` → `concurrently` → `electronmon` chain does
**not** work — the flag lands in the app's own `process.argv` (visible to
JS) rather than ever reaching Chromium's native switch parser, with no
error at all. Confirmed live before landing on the `appendSwitch()`
approach above.

`main.ts` also skips `electron-debug`'s auto-opened native DevTools
inspector whenever `ELECTRON_QA_DEBUG_PORT` is set. A remote CDP client
(this driver, Playwright, an MCP server, anything) attaching to a target
that already has a native inspector attached fails immediately with
`Debugging connection was closed: WebSocket disconnected` — confirmed live.

`scripts/qa/electron-cdp.ts` is a small, dependency-light CDP client (just
the `ws` package) that talks directly to the renderer's
`webSocketDebuggerUrl` — not through Chrome's own DevTools frontend HTML
page, which is itself just another client competing for the same
attachment. Commands: `targets`, `text`, `eval`, `click`, `type`,
`screenshot`.

### Known rough edges

- **Electron's own binary can fail to fully extract** on some Node
  versions — `extract-zip`/`@electron/get` has a documented race condition
  on Node 24
  ([electron/electron#51619](https://github.com/electron/electron/issues/51619)).
  This repo pins `"overrides": { "yauzl": "^3.3.1" }` in
  `waypoint-frontend/package.json` to work around it. If `npm run start:qa`
  ever throws a `dyld: Library not loaded` error on macOS, check
  `node_modules/electron/dist/Electron.app/Contents/Frameworks/` actually
  exists and isn't a partial extraction — delete `node_modules/electron/dist`
  and `path.txt`, then re-run `node node_modules/electron/install.js`.
- **Node version matters.** `npm install` needs Node ≥22 (see `engines` in
  `waypoint-frontend/package.json`) — an older Node silently skips the
  platform-specific `@tailwindcss/oxide-*` optional dependency instead of
  erroring, breaking the CSS build with an opaque "Cannot find native
  binding" error much later. This repo pins
  `@tailwindcss/oxide-darwin-arm64` as an explicit `optionalDependencies`
  entry as a second line of defense.
