# W4 · Independent sessions — start, prompt, resume

Status: build plan, written before the code (the W3 way). Branch:
`feat/road-66-w4-start-session`. Tickets: ROAD-66 (W4) and its
sub-tickets ROAD-67 (start on a linked repo), ROAD-68 (prompt / cancel /
queue / drafts), ROAD-69 (resume an interrupted run). Also closes the first
half of ROAD-111 (`n` → New session).

W3 built the panel and exercised it on runs seeded by hand (a `POST
/agent-runs`, a `git worktree add`, an `acp.start` over the QA wire
client). W4 makes that sequence the product: the "New session" button the
W3 layout kept disabled now opens a small dialog, and one click later a run
is provisioning in the list and live in the detail pane. Nothing about the
panel's geometry changes.

## 1. What the user sees

1. **Entry points.** The list header's "+", the two empty states' "New
   session" button, and the `n` key while the sessions page is open (and
   nothing is being typed) all open the **New session** dialog. Codex
   arrives with W7; today the dialog's provider is Claude Code, shown as
   the one choice rather than hidden — the field is where it will be.
2. **The dialog** (`Modal`, 480 px): *Project* (only projects with a linked
   repository; the last used one preselected; none → the dialog says so and
   links to that project's settings), *Provider* (Claude Code), *Base
   branch* (the repository's local branches, read through the engine;
   default = the branch `origin/HEAD` points at when that is a local
   branch, else `main`, else `master`, else the first), *Title* (optional,
   ≤ 120 chars — the row's name; otherwise the branch is). One primary
   action, **Start session**, disabled until a project and a branch are
   chosen. Errors land inline under the field they concern; the engine not
   running is the one error that replaces the form (with the same "Open
   This machine" the empty state offers).
3. **After Start.** The dialog closes and the page navigates to
   `/sessions/<run id>` at once. The run is *Provisioning* in the Active
   group within the poll's debounce (main sends `runs:changed` for every
   status it writes); the detail's header shows the branch as soon as the
   worktree exists and the status pill goes *Running* when the daemon has
   answered `acp.start`. The composer is enabled from *Running* — the W3
   rule (`STATUS_VIEW.live`) unchanged. A failure is *Failed* with the
   sentence in the header (`errorMessage`), never a toast that vanishes.
4. **Prompting (ROAD-68).** As in W3: ⌘↵ sends, the prompt shows at once,
   `acp.sendPrompt` with placement `auto` — which the daemon delivers if the
   agent is idle and **queues** while a turn is active. What W4 adds: the
   composer keeps a **draft per run** (typed text survives switching runs
   and restarting Waypoint; cleared on send and when the run ends), and the
   usage strip says "1 queued" while the daemon holds a prompt for the
   agent's next turn. Turn-stop stays the transcript's own stop (cancels
   the turn, the session lives); run-stop stays the header's *Stop*
   (cancel, then kill). There is no automatic escalation from the first to
   the second — a person presses Stop. Attachments are not in W4.
5. **Resume (ROAD-69).** An *Interrupted* run's header gains **Resume**
   beside Stop. Resume asks the daemon to load the same provider session in
   the same worktree; the run goes *Provisioning* → *Running*. When the
   provider cannot restore the conversation the daemon starts a fresh
   session in the same worktree, and Waypoint says so twice: a toast, and
   the first message of the new transcript is Waypoint's own note with the
   branch state (`git log --oneline base..HEAD`, `git status --short`) so
   the agent knows where it is. A run whose worktree is gone cannot be
   resumed; Resume says why and stays disabled.

## 2. Decisions

- **Main starts the session, not the renderer.** The renderer sends
  `{projectId, ownerMemberId, providerId, baseRef, title}` and gets a run
  back. Main resolves the project's `repoPath` from the backend itself
  (`GET /projects/:id`), creates the ledger row, provisions the worktree
  (W2's `provisionWorktree`, unchanged), starts the ACP session and writes
  every step to the ledger. The renderer never names a path (the W3 rule)
  and never sequences ledger writes; there is one place a run is born.
- **The renderer gets the run before the worktree exists.** `runs:start`
  answers as soon as the row is `provisioning` — that is the "appears in
  the list within a second" of ROAD-67 — and the rest runs on in main. The
  panel follows `runs:changed`, as it already does for the follower.
- **The conversation id is the run id** (W2), so `acp.start` is
  `{conversationId: run.id, providerId, cwd: worktreePath, sessionId: null,
  model: null}` — no model or mode override; the provider's defaults are
  the user's own Claude configuration. `initialQueue` is not used for a
  normal start: the first prompt is the user's.
- **The provider's session id is kept in the ledger.** `acp.start` answers
  `{sessionId}` — Claude's own resume handle — and a resume must hand it
  back (`acp.start` with `sessionId` set makes the daemon `loadSession`).
  New column `agent_runs.provider_session_id` (migration 0013), written on
  start and on every resume; `daemon_session_id` keeps its W2 meaning (the
  ACP conversation id, i.e. the run id). The daemon's own conversation
  index could hold this too, but the ledger is what survives an engine
  reinstall — and it is where W6 will read it from.
- **A title column, not a hijacked field.** `agent_runs.title` (nullable,
  ≤ 120) in the same migration. `runTitle`: ticket label → title → branch →
  `Session <id>`. `summary` stays the agent's closing summary.
- **Only the providers main vouches for.** `SUPPORTED_PROVIDERS =
  ['claude']` in `engine/types.ts`; `runs:start` refuses any other id. The
  dialog reads the same list. W7 appends `codex`.
- **Cancel during provisioning is honoured.** Stop on a *provisioning* run
  (W3) writes `cancelled` first. The start sequence re-reads the run after
  the worktree and after `acp.start`; a run that is no longer
  `provisioning` is not started (or, if the session was just created, is
  killed) and the worktree is left as evidence, as W2 decided.
- **Resume is `acp.start` with the stored handle.** The daemon's own
  fallback (loadSession fails → new session in the same cwd) is used as is;
  Waypoint learns which happened by comparing the answered `sessionId` with
  the stored one. `session_resumed {outcome: 'loaded' | 'replaced-by-new'}`
  is the ledger event; the renderer gets the outcome in the reply. The
  branch-state note is sent with `acp.sendPrompt` only in the
  replaced-by-new case, fire-and-forget, bounded (40 lines of log, 40 of
  status), through the same hardened `git` runner the diff uses.
- **Drafts live in `localStorage`** (`waypoint:sessionDraft:<run id>`),
  written on change (trailing 300 ms), removed on send and when the run
  reaches a terminal status. Not the daemon's `setPromptDraft`: a draft is
  the user's unsent text on this device, and the renderer already keeps
  the sidebar pin there.
- **The `n` key** is page-local (a `keydown` listener the sessions page
  owns, guarded by the same typing/`[data-shortcut-guard]` rules the global
  shortcuts use), not a new global shortcut: it means "New session" only
  where sessions are. ROAD-111's ⋯ menu is still not built — Resume is the
  fourth header action and fits beside Stop.
- **No `conversations.create`.** The daemon's conversation index is for its
  own desktop client; a run needs none of it to start, prompt, or resume.
  The daemon logs a not-found for the lifecycle reports it would have
  landed there; noted, not fixed.

## 3. Main — `engine/runs/startRun.ts` (new)

```
startRun(deps, input): Promise<AgentRun>          // answers at `provisioning`
  validate input (ids, provider ∈ SUPPORTED_PROVIDERS, baseRef ref-safe, title ≤ 120)
  engine running? else throw 'The agent engine is not running.'
  project = backend GET /projects/:id; repoPath null → throw
  run = ledger.createRun({entry:'independent', …})            // queued
  run = ledger.updateRun(run.id, {status:'provisioning'})       // reply with this
  continue(run) — not awaited:
    worktree = provisionWorktree(…)                              // W2: writes path/branch/event, or errorKind 'provision'
    if ledger.getRun(id).status !== 'provisioning' → return    // cancelled meanwhile
    {sessionId} = daemon acp.start {conversationId:id, providerId, cwd, sessionId:null, model:null}
    if run no longer provisioning → daemon.killSession(id); return
    ledger.updateRun(id, {status:'running', daemonSessionId:id, providerSessionId:sessionId})
    ledger.appendEvent(id, 'session_started', {providerSessionId, cwd, branch, baseRef})
  on any failure: ledger.updateRun(id, {status:'failed', errorKind:'provision'|'start', errorMessage}) + 'error' event
  notify(runs:changed) after every status write

resumeRun(deps, runId): Promise<ResumeRunResult>
  run = ledger.getRun; status must be 'interrupted' → else {outcome:'not-resumable', status}
  worktreePath under worktreesDir and present on disk → else {outcome:'worktree-gone'}
  ledger.updateRun(id, {status:'provisioning', reason:'Resume from the sessions panel'})
  {sessionId} = daemon acp.start {…, sessionId: run.providerSessionId}
  outcome = sessionId === run.providerSessionId ? 'loaded' : 'replaced-by-new'
  ledger.updateRun(id, {status:'running', daemonSessionId:id, providerSessionId:sessionId})
  ledger.appendEvent(id, 'session_resumed', {outcome, providerSessionId})
  if replaced-by-new: acp.sendPrompt(id, branchStateNote(worktree)) — not awaited
  on failure: back to 'interrupted' with errorKind 'resume' + 'error' event (the run stays resumable)
```

- `DaemonRunsApi` gains `startSession(input) → {sessionId}` and
  `sendPrompt(conversationId, text)` (main-side, for the resume note only;
  the renderer's prompts still go through `topicsIpc`'s allowlist).
- `runsIpc.ts` registers `runs:start`, `runs:resume` and
  `runs:list-branches` (`{projectId}` → the repo's local branches plus the
  suggested default, through `daemon.listLocalBranches` and the refs
  snapshot's `remoteHeads`). `RUNS_IPC` grows the three names.
- `ledgerClient.ts`: `CreateAgentRunInput.title`, `AgentRun.title`,
  `AgentRun.providerSessionId`, `UpdateAgentRunInput.providerSessionId`;
  a `getProject(id) → {id, repoPath, name}` on the same HTTP client (it is
  main's client for the backend; a second one for one GET is not wanted).
- The follower is unchanged: once the run is `running` it mirrors pending
  permissions and lifecycle exactly as for a seeded run.

## 4. Backend

- Migration `0013_agent_runs_title_provider_session.sql`: `ALTER TABLE
  agent_runs ADD COLUMN title text, ADD COLUMN provider_session_id text`.
- `createAgentRunSchema.title` (optional, ≤ 120, trimmed, empty → null);
  `updateAgentRunSchema.providerSessionId` (≤ 256, nullable) and `title`.
- The service copies both through; `title` is not part of the status
  machine and `providerSessionId` is a handle, not a state.

## 5. Renderer

- `types/agentRuns.ts` — the two new fields arrive by re-export.
- `data/engineApi.ts`: `startRun(input)`, `resumeRun(runId)`,
  `listRunBranches(projectId)`; `preload.ts` mirrors them.
- `components/sessions/NewSessionDialog.tsx` (new) — the form of §1.2 on
  `Modal`. Projects from `useAllProjects()` filtered to `repoPath !== null`;
  branches loaded when the project changes (loading / failed states
  inline); last project id in `localStorage 'waypoint:lastSessionProject'`.
- `pages/sessions/SessionsPage.tsx` — `NewSessionButton` becomes live and
  opens the dialog; `n` opens it; on success `navigate('/sessions/<id>')`
  and `refreshSessions()`.
- `components/sessions/SessionList.tsx` — the header "+" is a real button
  (`onNew` prop); `NEW_SESSION_UNAVAILABLE` goes away.
- `SessionDetail.tsx` — **Resume** for `interrupted` (with `worktreePath`
  present; disabled with the sentence when null), the header's
  `errorMessage` line for `failed`; Resume's outcome toast.
- `SessionComposer.tsx` / `useSessionTranscript.ts` — the draft per run;
  `UsageStrip` reads `queuedPromptCount` from the session summary the
  transcript already follows (`acp.session.state|…` carries the queue) and
  shows "N queued".
- `sessionStatus.ts` — `runTitle` reads `title`; nothing else changes.

## 6. Tests

- `startRun.test.ts` — the happy path in order (create → provisioning →
  worktree → start → running, with `invocationCallOrder`); cancel between
  worktree and start (no `acp.start`); cancel between start and the ledger
  write (kill called); provision failure → failed/`provision`; start
  failure → failed/`start` with the daemon's sentence; unsupported provider
  and unlinked project refused before any write; resume: loaded vs
  replaced-by-new (note sent only for the latter), not-resumable,
  worktree-gone, start failure returns the run to `interrupted`.
- `runsIpc.test.ts` — the three new channels validate their input and
  answer with the shapes above.
- Backend `agentRuns.routes.test.ts` — title round-trips on create; the
  update accepts `providerSessionId`; the migration test list gains 0013.
- Renderer — `NewSessionDialog.test.tsx` (projects without a repo are not
  offered; Start disabled until branch chosen; inline error from a refused
  start; Escape closes), `SessionsPage.test.tsx` (`n` opens the dialog,
  not while typing), `SessionDetail` Resume states, composer draft
  restore/clear, `UsageStrip` queued count.
- `docs/qa/manual-test-cases.md` — SESS-17…24 (start, cancel during
  provisioning, failure copy, prompt while generating → queued, draft
  survives switching runs, resume loaded, resume replaced-by-new, worktree
  gone), run live against the real daemon and a real Claude login.

## 7. Out of scope (filed or already filed)

- Codex as a provider (W7); a model / mode picker in the dialog.
- Attachments in the composer.
- Automatic cancel→kill escalation on a Stop that does not yield.
- The ledger's `turnCount` / token counters (the orchestrator's, W5/W6).
- A "New session" entry on project pages — the dialog's project picker is
  the one entry point until W5's ticket-drawer dispatch exists.
