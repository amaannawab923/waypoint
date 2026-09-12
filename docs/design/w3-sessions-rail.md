# W3 · My sessions — layout decision and build plan

Status: approved by the founder on 2026-09-12 ("Go with A"). Branch:
`feat/road-58-w3-panel`. Tickets: ROAD-58 (W3) and its sub-tickets
ROAD-61 (list), ROAD-62 (transcript), ROAD-63 (permissions), ROAD-64
(diff), ROAD-65 (nav + drawer).

Three layouts were drawn against one brief after the first proposal's two
side-by-side columns (250 px sidebar + 310 px list) left the transcript
~700 px at a 1280 px window. The founder picked **Option A, "Rail"**:

- A · Rail (chosen) — https://claude.ai/code/artifact/407780a9-3129-47c3-972d-8fb21b1fa4ad
- B · Stage — https://claude.ai/code/artifact/d4ddc299-bdfb-48e4-b93e-30625939aa26
- C · Takeover — https://claude.ai/code/artifact/7cd51456-255e-4a25-9627-6b5b3a72b8b8
- v1 (superseded) — https://claude.ai/code/artifact/ded14885-d112-48b4-a313-a3b19ef737f7

Everything the three options shared — status vocabulary, grouping rule,
composer-docked permission band, diff as a tab, the dispatched-run
treatment — is carried over from v1 unchanged. Only the geometry is new.

## 1. The layout, as rules

1. **Placement.** A "My sessions" entry in the sidebar's top nav, directly
   under "My work", with an alert badge = number of the user's runs
   waiting on them (blocked + needs-review). Routes: `/sessions` (list,
   nothing selected) and `/sessions/:runId`.
2. **The rail.** While a `/sessions*` route is open, the app sidebar
   collapses to a **56 px icon rail**: logo, expand affordance, Home, My
   work, My sessions (badge), Review, Projects (one icon; hover opens a
   flyout listing the projects, max 6 then "All projects & tickets"),
   Settings, and the Local status dot. Nothing else — Notifications,
   Drafts, Scratchpad, Archive, Analytics, My Jira are reachable through
   the expanded sidebar only. Leaving `/sessions*` restores the full
   sidebar. This is a shell-level behaviour (`Sidebar` + `AppShell`), not
   a Sessions-local one.
3. **Peek and pin.** Hovering the expand affordance (≥200 ms) overlays the
   full sidebar without resizing the workspace; clicking it, or ⌘B, pins
   it open (the workspace resizes). The pin is remembered per device
   (`localStorage`) and only applies inside focus workspaces; there is no
   preference for the automatic collapse itself.
4. **Session list.** Fixed **300 px**, right of the rail. Groups, in fixed
   order and system-computed (never user-sorted): *Waiting on you*
   (blocked, needs-review), *Active* (queued, provisioning, running,
   finishing), *Done* (done, failed, cancelled, interrupted). Each row:
   status dot, title, provider chip / age, branch line, and — for waiting
   rows — a third line with the reason ("Wants to run `pnpm test`",
   "2 proposals need review").
5. **Detail pane.** Everything right of the list: header (title, status
   pill, provider, branch ← base, turn count / age, Stop, open worktree,
   ticket link, ⋯), tabs **Transcript | Diff · N files**, then the
   `@emdash/chat-ui` transcript, the composer-docked permission band when
   a permission is pending, the composer, and a usage strip.
6. **Pixel budget.** Transcript = window − 56 − 300 (− borders):
   **≥ 924 px at 1280**, **≥ 1084 px at 1440**.
7. **Narrow (< 1100 px).** The rail never disappears. The list becomes
   conditional: with nothing selected it fills the width; opening a
   session hides it and the detail takes over with a back chevron in the
   header; `Esc` returns to the list. The same list⇄detail flip a mail
   client does.
8. **Diff.** A tab that replaces the transcript in place — file list
   (status glyph, path, +/−) + unified diff — never a side inspector.
9. **Keyboard.** `⌘B` toggle rail/pinned sidebar; `↑`/`↓` move the list
   selection, `Enter` opens; `Esc` (narrow, session open) back to list;
   `⌘Enter` sends; `n` new session; `g s` jumps to `/sessions`.
10. **Motion.** The collapse/expand is a 150 ms width tween; instant under
    `prefers-reduced-motion`.

## 2. What "New session" does in W3

The list header's "+" and the empty state's "New session" button exist in
W3 but open nothing yet: starting a session from the panel is W4 (ROAD-66,
provider → repo → base branch → first message). Until W4 lands the button
is disabled with the sentence "Starting a session from here arrives with
W4." — present so the layout is honest about where the action lives, not a
placeholder that pretends to work. The panel itself is exercised in W3 via
runs created by the ledger + daemon directly (the W2 QA path).

## 3. Sources of truth

- **Ledger** (`waypoint-backend` `/agent-runs`) — the durable record: which
  runs exist, whose they are, their ticket, branch, worktree, status.
  The list is read from here (`ownerMemberId = CURRENT_USER_ID`).
- **Daemon** (`acp.sessions.list`, `acp.session.*|{conversationId}`) — the
  live truth: is the agent generating, is a permission pending, the
  transcript. The conversation id is the run id (ROAD-55).
- **Displayed status** = ledger status. The daemon's live facts are used
  for the *reason* line and for the badge/grouping overlay only when the
  ledger already says `running`/`blocked` — and main keeps those two in
  step (see §4.3), so the overlay is a latency hider, not a second truth.
- **Engine state** — `EngineStatus` from the supervisor. An empty list
  with the engine stopped says so ("The agent engine isn't running") —
  a different claim from "No sessions yet".

## 4. Build plan — file by file

Feature flag: `WAYPOINT_FEATURE_SESSIONS` (build-time, default off, on in
`start:qa`), gating the nav entry and the routes the way `MY_JIRA_ENABLED`
does. The engine section on Machine stays unflagged as today.

### 4.1 Main — allowlist (`engine/types.ts`)

`ALLOWED_PROCEDURES` gains `acp.sendPrompt` (`{conversationId, prompt:
{text}}` — text only, no attachments in W3), `acp.resolvePermission`
(`{conversationId, requestId, optionId}`), `acp.cancelTurn`
(`{conversationId}`). Every input check requires the run-id-shaped
conversation id, as `acp.getHistory` already does.

### 4.2 Main — run control IPC (`engine/runsIpc.ts`, new)

Channels under `RUNS_IPC`, request/response like ENGINE_IPC:

- `runs:stop` (runId) — `acp.cancelTurn` then `acp.kill` on the daemon,
  ledger `PATCH status: cancelled` (reason "stopped from the panel") for a
  live run; a run the daemon no longer has is only patched. Never throws
  for a run that is already terminal — returns the run.
- `runs:diff` (runId) — `git diff <baseRef>...HEAD` + `git diff` + `git
  status --porcelain` executed in the run's `worktreePath`, after asserting
  the path is under `EnginePaths.worktreesDir` (the same containment rule
  `worktrees.ts` applies) and the run is one of ours. Answers
  `{ files: [{path, status, additions, deletions}], patch: string }`,
  clipped like `worktrees.ts` clips daemon output.
- `runs:revealWorktree` (runId) — `shell.showItemInFolder(worktreePath)`
  after the same containment check.

The renderer never names a path; it names a run.

### 4.3 Main — live ledger follower (`engine/runs/liveFollower.ts`, new)

Registered beside `registerBootReconcile`: while the engine is running,
follows `acp.sessions.list` and, for each of our runs in a live status,
mirrors the daemon into the ledger: `pendingPermissionCount > 0` →
`blocked` with `blockedReason` = the tool call's title, and a
`permission_requested` event; back to 0 while still live → `running` and a
`permission_answered` event; `lifecycle: closed` for a run still `running`
→ `interrupted`. Turn counting stays with W4/W5's orchestrator. Idempotent
against what the ledger already says, so a restart re-follows without
writing duplicate events.

### 4.4 Renderer — data

- `data/api.ts`: `listMyAgentRuns()`, `getAgentRun(id)`,
  `listTicketAgentRuns(ticketId)`; the `AgentRun` type mirrored into
  `types/agentRuns.ts` from main's `ledgerClient.ts` (type-only reach, as
  `types/engine.ts` does).
- `data/engineApi.ts`: `stopRun`, `getRunDiff`, `revealRunWorktree`,
  `sendPrompt`, `resolvePermission`, `cancelTurn` — thin wrappers.
- `lib/sessionsStore.ts`: one store for the panel and the badge — ledger
  runs (refetched on mount, on every run-control action, and every 30 s
  while the panel is open), the `acp.sessions.list` follower (via
  `createLiveFollower`), engine status. Exposes `useMySessions()` →
  `{ groups, waitingCount, engine, loading, error }` and
  `useWaitingCount()` for the sidebar badge.

### 4.5 Renderer — shell (ROAD-65)

- `layouts/Sidebar.tsx`: a `mode: 'full' | 'rail'` prop; the rail branch
  renders `SidebarRail` (new file `layouts/SidebarRail.tsx`: icons, badge,
  projects flyout, expand affordance with peek + pin). The "My sessions"
  `NavLink` lives in the full sidebar's top nav, under My work, behind the
  flag.
- `layouts/AppShell.tsx`: derives `focusWorkspace` from the route
  (`/sessions*`), owns `sidebarPinned` (persisted under
  `waypoint:sidebarPinned`), passes `mode` to `Sidebar`, handles ⌘B.
- `lib/useGlobalKeyboardShortcuts.ts`: `g s` → `/sessions`.

### 4.6 Renderer — the page (ROAD-61)

- `pages/sessions/SessionsPage.tsx` (route `/sessions` and
  `/sessions/:runId`): the 300 px `SessionList` + the detail outlet;
  narrow-mode flip via a `useMediaQuery('(max-width: 1100px)')`; empty
  states (engine stopped / no runs / select a session); New session
  button (disabled, W4 sentence).
- `components/sessions/SessionList.tsx`, `SessionRow.tsx`,
  `SessionStatusPill.tsx` (the ten `agent_run_status` values → label,
  colour, sentence — one table, used by the row, the header and the
  drawer).

### 4.7 Renderer — detail (ROAD-62, 63, 64)

- `components/sessions/SessionDetail.tsx`: header, tabs, and the three
  bodies. Mounts one `ChatContext` per app (`lib/chatContext.ts`) and one
  `ChatState` + `SessionSource` per selected run (`useSessionTranscript`
  hook: seed history via `acp.getHistory`, `connectSession`, re-seed on
  `onTurnCommitted`, dispose on run change).
- `components/sessions/SessionComposer.tsx`: textarea + send
  (`acp.sendPrompt`), disabled with a sentence when the run is terminal
  or the engine is down; `⌘Enter` sends.
- `components/sessions/PermissionBand.tsx`: composer-docked; shows the
  first pending request's tool title and "1 of N"; a split button whose
  main action is the first `allow_once` option and whose menu lists every
  option the agent offered; `resolvePermission` on click.
- `components/sessions/UsageStrip.tsx`: turn count from the ledger,
  context used / size and cost from `acp.session.usage`.
- `components/sessions/DiffPane.tsx`: file list + unified diff from
  `runs:diff`; refetches on tab open and after every committed turn.

### 4.8 Renderer — drawer (ROAD-65)

`TicketDetailPage`/drawer and `JiraTicketDrawer` gain a "Runs" section
(via `listTicketAgentRuns`) with status pill + "Open session →"; the
session header's ticket key links back to the ticket.

### 4.9 Tests and QA

Unit tests beside every new module (fake bridge for followers; fake
`window.electron` for engineApi; RTL for list/rail/band/composer;
`runsIpc` and `liveFollower` with fake daemon/ledger). Manual cases go in
`docs/qa/manual-test-cases.md` under a new SESS section, executed against
the running app with a real daemon session before the branch merges back
to `feat/road-44-agent-sessions`.
