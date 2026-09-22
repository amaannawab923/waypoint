# Ultrafast browser tasks

## What this is

An integration of [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
(MIT, pinned commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`) so a coding
session's verify-in-browser step can hand a multi-step browser walk —
"open localhost:5199, type Ada into Your name, press Submit, screenshot the
greeting" — to a fast decision-model agent (TypeSafe's `jev`) in one MCP
tool call, instead of driving the page one Claude tool call at a time
through `waypoint-browser`'s `navigate_page` / `click` / `fill` /
`take_screenshot`.

A standalone demo proved the mechanism before this was built: Jev booked a
Google Flights search in 10 steps / 17 seconds, every individual Jev
decision 320–390ms, with Claude (through the Claude Agent SDK) writing the
two typed values along the way.

## Why

Every one of `waypoint-browser`'s fine-grained tools is a full model round
trip — Claude reads the page, decides an action, calls a tool, waits for
the result, repeats. For a ten-step walk that's ten round trips through a
general-purpose coding model. `browser_task` collapses that into one MCP
call: a small, purpose-built decision model (`jev`) makes every click/fill/
navigate choice at ~350ms each, and the session only re-enters the loop
once, to read the returned transcript and screenshots and judge whether
the outcome actually matches what was asked. It is a *faster tool for a
narrow job*, not a replacement for the fine-grained tools — the brief still
offers both, and still tells the agent to prefer fine-grained tools when a
step needs judgment `jev` can't apply.

## Data flow

```
Session (Claude, via ACP)
  │  MCP tool call: browser_task({ url, goal, maxSteps })
  ▼
waypoint-ultrafast MCP server (scripts/ultrafast-mcp.js)
  │
  ├─ starts (once, lazily) an in-process Claude-Agent-SDK text-model shim
  │    — a loopback HTTP server jev-ultrafast's TEXT_MODEL_BASE_URL points
  │    at; answers "what do I type in this field" using the founder's own
  │    Claude login, never a second API key
  │
  ├─ launches a fresh, headless, single-use Chromium
  │    (never the person's real browser, never waypoint-browser's own one)
  │
  └─ spawns the pinned venv's runner.py, with BU_CDP_URL pointed at that
       Chromium and TEXT_MODEL_BASE_URL at the shim
       │
       ▼
     runner.py → jev_ultrafast.Agent.run()
       │  each step: jev (TypeSafe) decides the action;
       │             the Agent SDK shim writes field text when the
       │             action is a fill
       ▼
     one JSON line per step to stdout, then one JSON "result" line
       (status, steps, history, screenshot paths — the final screenshot is
       taken by runner.py itself, after jev's own loop ends, since jev's
       own record_dir never holds a frame of the finished page)

  ▼
waypoint-ultrafast MCP server returns:
  - a text summary (status, step count, elapsed time, one line per action)
  - the final honesty line: "`done` is Jev's claim — check the
    screenshots before saying the behaviour matches."
  - every screenshot as MCP image content, final page last — so they land
    inline in the session's own transcript, the same way take_screenshot's
    results already do
```

## What leaves this machine

- **To TypeSafe**: the page's DOM text and its interactive controls (what
  `jev` needs to decide an action), for the duration of the `browser_task`
  call only. Nothing leaves while no session is running a browser task.
- **To Anthropic, on the founder's own Claude subscription**: for every
  field `jev` decides to type into, `jev_ultrafast.model.field_context`
  (the pinned package's own code) sends the goal, the field itself
  (label/role/value), the page's title, **up to 6,000 characters of the
  page's own text**, and the session's **last six actions** — not just
  the one value that comes back. F22 (tech-lead review, 2026-09-22): this
  paragraph used to say only "the goal and field context for a value jev
  decided to type", which reads as a small, per-value exchange; the actual
  per-field payload is most of a page's visible text plus recent history,
  sent once per field on a multi-field form. Still the same trust
  boundary every other Claude prompt in this app already crosses — the
  founder's own subscription, nothing routed anywhere else — just larger
  and more frequent per task than "the goal and field context" implied,
  and reached through an in-process SDK session instead of the CLI.
- **Nowhere else.** `browser-harness` (the CDP client jev-ultrafast is
  built on) is told to disable its own telemetry and update checks at
  provisioning time (`browser-harness telemetry disable`, `BH_UPDATE_CHECK=0`),
  the same posture `waypoint-browser`'s vendored chrome-devtools-mcp holds.

MachinePage's "What leaves this machine" table states this as a
conditional row — "Browser tasks in a session" — the same shape as the
existing "Agent prompts" row, not folded into "Always" or "Never".

## Where the key lives

The founder's TypeSafe API key is the one secret this feature holds at
rest. It is stored the same way this app stores every other main-process
secret (`copilotAuth.ts`, `accountAuth.ts`): `safeStorage`-encrypted,
written to a `0o600` file under `app.getPath('userData')`
(`src/main/engine/runs/ultrafast/auth.ts`), with a hard refusal — never a
plaintext fallback — when OS-level encryption is unavailable. The renderer
only ever learns `{ configured: boolean, tail: string | null }`; the key
itself never crosses IPC.

Getting the key (and, when Copilot is connected, its OAuth token — see
below) to the MCP server process is a second hop, and an earlier version
of this feature got it wrong: `registerUltrafastBrowser` hands its env
object to the daemon's own `agentConfig.saveMcpServer`
(`src/main/engine/runs/ultrafast/registration.ts`), the same call
`waypoint-browser`'s `sessionBrowser.ts` uses — and the daemon persists
whatever it's given into the person's REAL `~/.claude.json` at `0o644`,
readable by every session this app spawns for that provider, not just
this one. A raw key or token in that env object would have landed there
in the clear, which is exactly what shipped briefly and is what this
section used to (incorrectly) describe as never happening.

The fix: `buildServerEnv` never puts the key or the OAuth token in that
env object. Instead it writes each to its own `0o600` plaintext file
under `<userData>/ultrafast/` — `runtime-key` and `runtime-oauth-token`
(`pythonEnv.ts`'s `UltrafastPaths.runtimeKeyFile` /
`runtimeOauthTokenFile`) — rewritten on every registration attempt (so a
new key from the settings page reaches a rewritten file, not a stale
one) and removed when there's nothing to write (the key cleared, Copilot
disconnected). The env object carries only each file's *path*
(`ULTRAFAST_KEY_FILE`, `ULTRAFAST_OAUTH_TOKEN_FILE`) — not a secret, safe
to sit in `~/.claude.json` at `0o644` the same as any other path this app
already registers there. `scripts/ultrafast-mcp.js` reads the real values
from those files once, at its own process startup — plaintext, not
`safeStorage`-encrypted like the at-rest store above, because the MCP
server runs as a plain Node process under `ELECTRON_RUN_AS_NODE=1`, where
`require('electron')` resolves to the electron binary's own path rather
than the app's API surface, so `safeStorage` is unreachable there. `0o600`
is the whole defense for these two files — the same posture any other
per-user secret file outside `safeStorage`'s reach holds to.

The key never rides on the command line either way (visible to `ps`), and
now genuinely never sits in a config file on disk in the clear — only its
file's path does.

## Host requirements

- **[`uv`](https://docs.astral.sh/uv/)** must be on the machine — the one
  host dependency this feature cannot provision for itself. Checked on
  PATH, then at Homebrew's Apple Silicon prefix
  (`/opt/homebrew/bin/uv`) and `~/.local/bin/uv`. Absent, the feature
  reports "uv isn't available" and registers nothing; it does not attempt
  to install `uv` itself.
- **Python 3.12** — `uv venv --python 3.12` fetches it into a private venv
  under `<userData>/ultrafast/venv`; nothing is installed system-wide.
- **A Chromium binary** — reused from whatever chrome-devtools-mcp
  (`waypoint-browser`) already downloaded (`~/.cache/puppeteer/chrome/…`),
  falling back to the person's installed Google Chrome. A separate,
  isolated instance is launched per task — headless, a fresh throwaway
  profile, killed and the profile deleted when the task ends (including on
  error or timeout), on its own ephemeral port.

## The honesty rule

jev-ultrafast reports `done` when it believes the goal is met — that is a
claim, not proof. Every layer of this integration repeats the same rule
rather than trusting that claim at face value:

- the MCP tool's own description says so;
- the tool's text response ends with the line, always;
- the brief (`briefs.ts`'s `verificationTask`) tells the agent to judge the
  screenshots itself before saying the behaviour matches, exactly as it
  already does for the fine-grained `waypoint-browser` tools.

## Upstream gaps (jev-ultrafast / browser-harness, as of the pinned commit)

Not something this integration works around — named here so a session (or
a person reading a failed test) knows what a `browser_task` call cannot
currently drive:

- shadow DOM content is not observed;
- content inside `<iframe>`s is not observed;
- `<canvas>`-rendered UI (no real DOM to read) is invisible to it;
- file uploads are not supported;
- a pop-up/new-tab flow is not followed.

A task that needs any of these should fall back to the fine-grained
`waypoint-browser` tools instead.

## How to test by hand

1. Open **Settings → Agents** and paste a TypeSafe API key into the
   "Ultrafast browser tasks" section, then **Save** — or put
   `TYPESAFE_API_KEY=…` in `waypoint-frontend/.env` (gitignored;
   `.env.example` has the placeholder). A saved key wins over `.env`; the
   section says which one is in use.
2. Press **Test**. This provisions the Python environment if it hasn't
   been already (can take a minute or two on first run — `uv venv`, then
   `uv pip install` of `jev-ultrafast` and `browser-harness`), runs
   `runner.py --selftest`, then drives a small local page (a "Your name"
   field and a "Continue" button) end to end through the real
   `waypoint-ultrafast` MCP server. The result — steps, elapsed time,
   status, and the final screenshot — appears inline.
3. Dispatch a **Fix** with *verify in browser* switched on. Once the tool
   is registered (gated on the key, `uv`, and a provisioned environment —
   see `registerUltrafastBrowser`, `src/main/engine/runs/ultrafast/registration.ts`),
   the brief mentions `browser_task` alongside the fine-grained tools; the
   agent may call it for a multi-step walk and will still narrate what the
   screenshots show before claiming the fix works.

Every task's frames land under
`<userData>/ultrafast/run-evidence/<taskId>/` — `NNNNNN.jpg` per step
(taken before the action, as jev-ultrafast records them) and
`999999-final.jpg`, the runner's own screenshot of the page after Jev
said `done`. That last one is the proof; Jev's `done` is only its claim.

### First live run (2026-09-22)

Three things only a real key could show, each fixed the same day:

- The MCP server needs `HOME`, `USER` and a `PATH` (and Copilot's
  subscription token when one is connected): the Claude Code CLI the
  shim's Agent SDK spawns reads the login from the macOS keychain, and
  with only the `ULTRAFAST_*` values it answered "Not logged in" — which
  surfaced as "Text helper returned no valid field value".
- browser-harness binds an AF_UNIX socket in `BH_RUNTIME_DIR`; macOS caps
  that path at 104 bytes, and the per-user tmpdir plus a UUID dir was
  longer ("fatal: AF_UNIX path too long"). The runtime dir is
  `/tmp/wpuf-XXXXXX` per task.
- With both fixed: the settings Test ran the "Your name → Continue →
  Hello, Ada!" page in 2 steps / 6.8 s, final screenshot showing the
  greeting.

## Implementation map

| Piece | File |
| --- | --- |
| Python env pin + provisioning | `src/main/engine/runs/ultrafast/pythonEnv.ts` |
| Isolated Chromium launcher (TS, for tests/future in-process use) | `src/main/engine/runs/ultrafast/browser.ts` |
| Script path resolution (dev/packaged) | `src/main/engine/runs/ultrafast/scriptPaths.ts` |
| TypeSafe key storage | `src/main/engine/runs/ultrafast/auth.ts` |
| The runner (spawned per task) | `scripts/ultrafast/runner.py` |
| The MCP server (`browser_task`, the text-model shim, the real Chromium launch) | `scripts/ultrafast-mcp.js` |
| Daemon registration, gated on key + uv + provisioning | `src/main/engine/runs/ultrafast/registration.ts` |
| Settings-page IPC (status/save/clear/test) | `src/main/engine/runs/ultrafast/ipc.ts`, `ipcTypes.ts` |
| The `ultrafast:test` MCP client | `src/main/engine/runs/ultrafast/mcpClient.ts` |
| The test page `ultrafast:test` drives | `src/main/engine/runs/ultrafast/testPage.ts` |
| Settings UI | `src/renderer/components/sessions/UltrafastBrowserTasksSetting.tsx` |
| This machine disclosure row | `src/renderer/pages/MachinePage.tsx` |
| Brief mention of `browser_task` | `src/main/engine/runs/briefs.ts` (`verificationTask`) |
