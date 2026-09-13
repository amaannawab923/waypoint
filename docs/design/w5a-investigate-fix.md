# W5a · Investigate and Fix — a ticket handed to an agent, and back

Status: build plan, written before the code. Branch: `feat/road-117-w5a-investigate-fix`,
off `feat/road-44-agent-sessions` once W4 (#57) and W4b (#58) have merged.
Tickets: ROAD-117 (this slice) under ROAD-70 (W5), with sub-tickets
ROAD-118…122 (§8). Supersedes the parts of ROAD-71/72/73/75 it covers; the
rest of those stay open.

Companions: the PM review that shaped it
(`docs/product/pm-review-async-ticket-sessions.md`), the walkthrough and
the vision-vs-corrected diagrams (artifacts, 2026-09-12).

## 0. Why, and the position it builds toward

The founder's insight is asynchronous work: hand a ticket to an agent,
leave, come back to a row that needs you. The PM review confirmed the
spine and corrected the additions (§2). What it did not weigh enough, and
the founder did: the **economics and the road to a cloud**.

- Codex cloud tasks need a ChatGPT Pro/Team plan, Cursor's background
  agents bill per run, Copilot's coding agent needs Pro+ and premium
  requests. A small team already paying for Claude gets this cycle for
  **no incremental spend** — their subscription, their machine.
- The daemon Waypoint runs is emdash's `workspace-server`, designed to be
  remote (emdash runs it over SSH and in Docker; W1 kept the transport
  abstract, ROAD-50). "Waypoint Cloud" is the same daemon on a host we
  run, over the same Wire protocol — the panel, the ledger, the Review
  gate and the briefs do not change; the person picks *This machine* or
  *Waypoint Cloud* per session the way W4b picks a folder.

So the line the slice is built toward: **your tracker, your subscription,
your machine — and the same panel when you want it in our cloud.** The
one thing a subscription brings that a cloud plan hides is rate limits;
§1.9 makes those visible instead of mysterious.

Two rules make the whole thing hang together, and every decision below
follows from them:

- **Copilot is the PM.** It reads tickets and runs, composes briefs,
  proposes writes. It never edits code and never starts a run without a
  person pressing a verb.
- **The session is the engineer.** It edits code in its own worktree and
  says what it found. It never touches Jira, never pushes, never holds a
  credential. Everything it produces reaches the tracker only as a
  proposal a person approved.

## 1. What the user sees

1. **Three verbs on the ticket.** In the ticket drawer's Runs section
   (W3.7) and the list's bulk bar: **Investigate** (find the root cause,
   change nothing), **Fix** (implement it), **Something else…** (a text
   field for any other instruction, with one switch, *may change files*).
   Each opens the brief preview (§1.3).
2. **The same verbs in Copilot.** Typing `/` in Copilot's composer opens
   a menu: `/investigate KEY`, `/fix KEY [note]`, `/session KEY <text>`,
   with ticket-key autocomplete from the open project. A slash command is
   deterministic — it opens the brief preview directly, no model in the
   loop. Plain language still works: "look at ROAD-116" makes Copilot
   summarise the ticket and offer the three verbs as buttons, through the
   `dispatch_session` tool (§3.4). Either door lands on §1.3.
3. **The brief preview.** A dialog: the brief as text (editable), built
   from the ticket — title, description, the comments, acceptance criteria
   when present, the linked repository — plus Waypoint's instructions for
   the verb (§2.3). Under it, the facts: the folder (the project's linked
   repository; a project with none is told so and offered the Codebase
   settings), *fresh worktree from `main`* (dispatched runs are always a
   worktree; the base branch can be changed), the mode — **plan** for
   Investigate and for *Something else…* with the switch off; a writing
   session for Fix and the switch on — and, for a writing session, the
   auto-approve switch defaulting on (§2.5). **Start session** (⌘⏎).
4. **The run in the panel.** Within a second: a *Dispatched* row with the
   ticket key as its name, an intent chip (`plan` / `auto`), branch
   `agent/ROAD-116`. Everything W3/W4 built applies: click in, watch,
   steer from the composer, leave.
5. **Notifications.** Two, and only two: the run went **Blocked** (the
   agent asked something or wants a permission the mode does not grant),
   and the run **needs review** (finished; proposals filed). macOS
   notifications through Electron, clicking one opens the run. Nothing
   for running, finishing, or done.
6. **Finishing.** When the agent's turn ends, **main** — not the agent —
   takes its closing message and files it as a **comment proposal** on
   the ticket (origin `agent_run`, the run linked), moves the run to
   *Needs review*, and the row says "1 proposal needs review". For Fix,
   two proposals: the comment (the branch name and what changed, with the
   file list) and the state change to the project's *In review* state.
   Nothing reaches Jira. The session is killed once finalized; its
   transcript stays readable.
7. **Review.** The proposals appear in the Review queue like Copilot's
   own, with "from run ROAD-116 · Investigate ↗" and the transcript link.
   Approve, edit, reject. When the last proposal of a run is decided, the
   run is *Done*. The ticket drawer's Runs section reads the history:
   Investigate · done · RCA approved; Fix · needs review.
8. **Copilot hears about it, and can read it.** The moment a run
   finishes (and again when its proposals are decided), main appends a
   **note** to the person's Copilot conversation — text the ledger built,
   never the model: "Run ROAD-116 · Investigate finished (6 turns) ·
   comment proposal filed · approved 11:42". Asked "what was the
   problem?", Copilot answers through a `get_run` read tool (§3.4) — the
   run's facts and its closing message — without touching the session.
   Then it offers **Fix from the RCA**.
9. **Fix, seeded.** Fix on a ticket whose latest Investigate has an
   approved RCA comment gets that comment in its brief, under the ticket
   context, as "Root cause, as approved". Fix is a writing session with
   auto-approve on in its worktree; its row carries `auto`. At most **one
   writing run per ticket** is live at a time; the verb says so and
   offers to open the live one. A rate-limited turn (the provider's
   429/overloaded stop reason) shows on the row as "rate-limited, retrying
   at 12:05" rather than looking stuck (§2.7).
10. **The list.** A *Group by* switch: *what needs me* (W3's default) or
    *ticket*. A run can be renamed from its header (the W4 `title`
    column). No tabs.

## 2. Decisions

1. **Intent is the mode.** Investigate = `plan` (the Claude adapter's
   "planning mode, no actual tool execution" — reads, no edits; verified
   live during W4b); Fix and a writing *Something else…* = the writing
   session; auto-approve = `bypassPermissions` as in W4b. Nothing new to
   build in the engine for the intents.
2. **A sequence with a handoff, not parallel sessions.** Investigate runs
   alone. Fix is seeded from the *approved* RCA. "Comment" is a proposal,
   not a session. Many runs per ticket as history; one writing run per
   ticket at a time.
3. **The brief is built in main from the ledger's view of the ticket**
   (`GET /tickets/:id`, `GET /tickets/:id/comments`), the same reads the
   MCP tools make, with the ticket's identifier, title, description,
   comments (newest 20, oldest first, author and time), acceptance
   criteria when the description carries an "Acceptance" section, the
   repository path and branch. It is shown before anything starts and
   stored on the run as its first message (W4b's `firstMessage`), so the
   ledger has exactly what the agent was told. The brief must never
   include a credential, an internal URL with a token, or the raw Jira
   account ids the mapper strips (the same rule `systemPrompt.ts`
   follows).
4. **Finalize is host-side.** The trigger is the follower's existing
   facts: a dispatched run whose first turn has ended — `isGenerating`
   false, no pending permission, an empty queue — after at least one
   turn. Main reads the last assistant text through `acp.getHistory`,
   files the proposals through the backend (`createProposal` with origin
   `agent_run`, `agentRunId`, no conversation), writes `finishing →
   needs-review`, kills the session (the transcript stays in the daemon's
   history until the run's worktree is released), and appends the Copilot
   note. A run whose turn ends with no text (the agent stopped early) is
   `failed` with the reason.
5. **Auto-approve for Fix: on in the worktree, with the env scrub.** The
   worktree isolates files, not credentials: the daemon's agent process
   inherits the shell env, which on this machine carries `GH_TOKEN`-class
   variables. W5a passes `env` on `acp.start` with `GH_TOKEN`,
   `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
   `AWS_*`/`GOOGLE_*`/`AZURE_*` credential names set to the empty string
   and `GIT_TERMINAL_PROMPT=0`, and the live pass proves it: an
   auto-approved Fix asked to `git push` must fail. If the empty override
   does not neutralise a credential on the pinned daemon, auto-approve
   defaults **off** for Fix until ROAD-88 lands in the daemon itself — the
   honesty rule (strategy §7) over the founder's default.
6. **Copilot's tools live in main.** `dispatch_session` and `get_run` are
   in-process SDK MCP tools (`createSdkMcpServer` on the Agent SDK's
   `query()` options), registered beside the backend's HTTP MCP server
   that Copilot already uses. Main owns the ledger and the engine, so
   the tool that starts a run and the tool that reads one belong there —
   and `dispatch_session` never starts anything: it answers with a
   *brief preview request* the renderer opens (§1.3). The person presses
   Start. To be verified on the first build day; the fallback is a
   backend tool that records a dispatch request main acts on.
7. **Rate limits are shown, not hidden.** The session summary's
   `lastStopReason` carries the provider's stop reason; a
   rate-limit/overloaded reason on a live run shows on the row and in the
   header with the retry time when the provider gives one, and the run
   stays `running` — it is not blocked (nothing for the person to do) and
   not failed.
8. **The Copilot note is a message role.** `copilot_messages.role` gains
   `system` (migration 0016). Notes are rendered distinctly in the panel
   and prepended to the next user turn's prompt as
   "[Waypoint note: …]" lines (the SDK session is resumed, so the model
   sees them only through the prompt), then marked delivered.
9. **Not built here:** drag-and-drop onto Copilot (ROAD-71); the
   run-scoped MCP proxy (ROAD-74 — nothing in W5a needs the agent to talk
   to Waypoint); push/PR (W6, ROAD-76); the autonomy policy table (W8);
   Fix reusing Investigate's worktree (moot while Investigate is plan
   mode and changes nothing; a second Fix on the same ticket gets a fresh
   worktree from the base and the prior branch named in its brief —
   continuing on the prior branch is ROAD-123).

## 3. Main

1. `engine/runs/briefs.ts` — `buildBrief({ticket, comments, repoPath,
   branch, baseRef, intent, instructions?, approvedRca?}) → string`; pure,
   table-tested for every intent and for the scrub of ids/URLs.
2. `engine/runs/dispatch.ts` — `dispatchTicketRun(deps, {ticketId,
   intent, brief, mayChangeFiles, autoApprove, baseRef})`: the ticket's
   project must have a linked repository; refuses a second live writing
   run on the ticket; `createRun({entry:'dispatched', ticketId, projectId,
   intent, isolation:'worktree', autoApprove, title: 'ROAD-116 ·
   Investigate'})`; then W4's `continueStart` with `modeId` = `plan` or
   the auto-approve mode and the brief as `initialQueue`. `runs:dispatch`
   and `runs:brief-preview` (build the brief for the dialog) channels.
3. `engine/runs/finalize.ts` — registered beside the follower: on the
   turn-ended fact for a dispatched run in `running`, run finalize (§2.4).
   Idempotent by the `finishing` status. Ledger gains `createProposal`
   through the backend; events `proposal_created`, `session_ended`.
4. `copilot/sessionTools.ts` — the SDK MCP server with `dispatch_session`
   and `get_run`; `sessionPolicy.mcpTools` grants them.
5. `engine/notifications.ts` — Electron `Notification` for `blocked` and
   `needs-review` transitions the follower/finalize write; click → focus
   the window and navigate to `/sessions/<id>` (an IPC push).
6. `env` on `acp.start` per §2.5, in `daemonApi.startSession`.

## 4. Backend

- Migration 0016: `agent_runs.intent` (`investigate | fix | custom`,
  nullable), `copilot_messages.role` += `system`, `copilot_messages.
  delivered_at` (for notes).
- `POST /copilot/conversations/:id/notes` (main → a system message);
  the conversation list marks unread notes.
- `proposals.service`: deciding the last open proposal of an
  `agent_run` moves the run `needs-review → done` (the W6 rule, pulled
  forward; the same transaction).
- `GET /tickets/:id/agent-runs` already exists; add `intent` to the row.

## 5. Renderer

- `TicketRunsSection`: the three verbs and the *Something else…* field
  with its switch; the runs history with intent and outcome.
- `BriefPreviewDialog` (new): the editable brief, the facts, Start.
- Copilot composer: the `/` menu with key autocomplete; a system-note
  message style; the verb buttons Copilot's offer renders (the
  `dispatch_session` tool result is a card with three buttons, the way
  proposal cards render today).
- Session rows/header: the intent chip, the rate-limit line, rename;
  the list's *Group by* switch.
- Review: "from run … ↗" on run-origin proposals.

## 6. Tests

- `briefs.test.ts` (every intent, the seeded RCA, the scrub);
  `dispatch.test.ts` (no repo, second writer refused, the mode per
  intent/switch, the env scrub keys); `finalize.test.ts` (turn-ended
  detection, proposals filed once, empty closing message → failed,
  killed after); `sessionTools.test.ts` (tools answer a preview request,
  `get_run` shape); notifications (only the two transitions).
- Backend: migration 0016, the notes route, the last-proposal → done
  rule.
- Renderer: verbs and the field, the preview dialog, the slash menu and
  autocomplete, the note message, the group-by switch, rename.
- `docs/qa/manual-test-cases.md` SESS-32…40, run on the **Roadmap project
  linked to this checkout**: Investigate ROAD-116 from the drawer →
  detach → blocked notification → RCA proposal → approve → comment on
  the ticket → Copilot note → "what was the problem?" → Fix from the RCA
  (auto) → `git push` refused → two proposals → approve → Done; the same
  through `/investigate`; *Something else…* both ways of the switch; a
  second Fix refused while one is live; a rate-limited turn. Note the
  fresh worktree has no `node_modules`; the first briefs say so.

## 7. What decides whether this was right

Instrument before the slice: dispatched runs per active day; **detach
rate** (the person left the detail before the run ended); blocked/needs-
review → first action latency; completion mix per intent; approval rate
of run-filed proposals and how often the RCA is edited first; Fix runs
whose branch became a merged PR within 7 days (once W6 exists).

## 8. Tickets

- ROAD-117 · W5a (this slice) — parent.
- ROAD-118 · Backend: intent, system notes, last-proposal → done.
- ROAD-119 · Brief builder + dispatch + the three verbs on the ticket + the
  preview dialog.
- ROAD-120 · Host-side finalize + notifications + the env scrub check.
- ROAD-121 · Copilot: `dispatch_session` / `get_run` tools, the `/` menu,
  system notes in the panel.
- ROAD-122 · Fix seeded from the approved RCA; one writer per ticket; the
  rate-limit line; group-by and rename.
- ROAD-123 · Later: a second Fix continuing on the prior branch.
