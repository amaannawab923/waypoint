# QA agent playbook: live CDP testing with `electron-devtools`

This is an operating guide for an AI agent asked to do **manual, black-box QA**
against the real running Waypoint app via the `chrome-devtools-mcp` server
registered in this environment (tool names `mcp__electron-devtools__*`). For
background on *why* this setup exists and how it was built, see
[`docs/qa-electron.md`](./qa-electron.md) — this file is the "how to actually
run a QA session" procedure, written to be handed to a fresh agent with no
other context.

If you're an agent that was just asked to "QA this feature" or "test this in
the app," follow this document top to bottom.

## 0. Preconditions — check before doing anything else

The app must already be running in dev mode with its CDP debug port open
(started via `npm run start:qa` from `waypoint-frontend/`, which sets
`ELECTRON_QA_DEBUG_PORT=9222` and `WAYPOINT_FEATURE_COPILOT=true`). **Do not
start, stop, restart, rebuild, or otherwise touch the app process, the
backend, git, or npm/build commands unless the task explicitly asks you to.**
You are testing what's already running, not setting up the environment. If it
turns out nothing is running, say so clearly in your report and stop — don't
guess at how to launch it.

The `electron-devtools` tools are deferred (not pre-loaded). Before your first
call, load exactly the ones you need with `ToolSearch`, e.g.:

```
ToolSearch query: "select:mcp__electron-devtools__list_pages,mcp__electron-devtools__take_snapshot,mcp__electron-devtools__click,mcp__electron-devtools__fill,mcp__electron-devtools__take_screenshot,mcp__electron-devtools__list_console_messages,mcp__electron-devtools__list_network_requests,mcp__electron-devtools__press_key,mcp__electron-devtools__hover,mcp__electron-devtools__type_text"
```

Loading tools you don't end up needing is harmless; loading them one at a time
across multiple `ToolSearch` calls wastes round-trips — batch the select list.

Then call `list_pages`. It should return exactly one page named "Waypoint"
with a numeric `pageId`. **That `pageId` is required on every other call in
this MCP server** — every tool below takes it. If `list_pages` returns nothing
or errors, that's your precondition failure: stop and report it rather than
attempting to work around it.

## 1. How to explore and interact — snapshot first, screenshot last

- `take_snapshot` returns the page's accessibility tree with a stable `uid`
  on every interactive element. **This is how you find things to click or
  fill** — read the snapshot, locate the element by its role/name, use its
  `uid`. Don't try to guess CSS selectors or pixel coordinates.
- `click`, `fill`, `press_key`, `hover` all take a `uid` from the most recent
  snapshot. Take a fresh snapshot after any action that changes the page
  (a click that opens a menu or navigates a view) before trying to interact
  with what it revealed — a stale `uid` from before the change won't resolve.
- `take_screenshot` is for **visual evidence in your final report**, not for
  finding elements. Use its `filePath` option to save to disk (see §3) rather
  than only attaching it inline — a saved file is what you can hand back.
- `list_console_messages` and `list_network_requests` only capture activity
  **from the moment this MCP server attached onward**. If you need to see the
  network traffic behind a specific action, take the action first, then query
  — don't expect to see history from before you started this session.

## 2. Timing — this app talks to a real backend and a real LLM

Waypoint's Copilot panel streams real replies from the Claude Code CLI (not a
mock) and persists through a real Postgres-backed API. Concretely:

- A Claude Code reply typically takes **5–15 seconds** to stream and finish.
  Don't treat a still-streaming reply as broken — wait for the composer to
  re-enable (a disabled composer/textarea is exactly the "streaming in
  progress" signal) before deciding a step failed.
- Some UI updates depend on a second round-trip that follows the first
  (e.g. a conversation's title is derived server-side from its first message
  and only appears after a follow-up fetch) — a value that looks "wrong" for
  a second or two right after an action may just not have arrived yet. Wait
  and re-snapshot before concluding something is broken.
- If a wait genuinely seems stuck well past a normal duration (30s+ with no
  console/network activity explaining why), that itself is a real finding —
  report it, don't silently retry forever.

## 3. Screenshot evidence

Save screenshots via `take_screenshot`'s `filePath` option (don't rely on
inline-only attachments) into a scratch directory — use the working session's
own scratchpad if you have one, otherwise a clearly-named temp directory you
create with `mkdir -p` first. Name them in the order you take them with a
short description of what they show, e.g. `01-panel-opens.png`,
`02-session-created.png`, `03-reply-streamed.png` — a reviewer should be able
to follow your QA pass just from the filenames in order.

## 4. Scope discipline

You are doing **black-box UI testing through the CDP tools only**:

- Don't read or modify source code files.
- Don't run `git`, `npm`, or build commands.
- Don't assume what "should" happen from having read the implementation —
  verify it by actually driving the UI. If a task also gives you specific
  scenarios to check, treat those as the minimum, not the ceiling: note
  anything else that looks wrong even if it wasn't explicitly asked about
  (confusing copy, layout glitches, janky transitions, a console error that
  has nothing to do with the feature you were asked to test).

## 5. What a good report looks like

Whoever reads your report wasn't watching you work — write it so they don't
have to. Include:

- A numbered list of every screenshot's **full absolute file path**, each
  with a one-line caption.
- Pass/fail/partial for each scenario you were asked to check, with a
  one-sentence reason for anything that isn't a clean pass.
- Any console errors or non-2xx/3xx network responses you found, quoted
  verbatim — don't paraphrase an error message.
- Anything else you noticed, flagged honestly even if it makes the feature
  look worse than expected. A QA pass that only confirms what was asked and
  misses an obvious adjacent bug isn't a QA pass.

## Known gotchas (learned the hard way — see `docs/qa-electron.md` for detail)

- Page-scoped tools need a **numeric** `pageId`, not a string.
- `list_pages` can renumber pages across a browser reconnect — always call it
  fresh at the start of a session rather than reusing a `pageId` from a much
  earlier conversation.
- Google tests `chrome-devtools-mcp` against Chrome/Chrome-for-Testing, not
  Electron specifically — it works here because Electron's renderer is
  genuine Chromium, but treat any protocol-level oddity as worth a second
  look rather than assuming it's a bug in the app under test.
