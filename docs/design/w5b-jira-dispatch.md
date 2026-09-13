# W5b · A Jira issue handed to a session, and back

Status: build plan, written before the code. Branch:
`feat/road-126-w5b-jira-dispatch`, off `feat/road-117-w5a-investigate-fix`
(PR #59). Ticket: ROAD-126, under ROAD-70 (W5). Companions: the W5a
design (`w5a-investigate-fix.md`, whose §9 is the ground this builds on)
and the PM review that asked for this slice
(`docs/product/pm-review-w5a-walkthrough.md` §2, "Two points needs the
audience the product is for", item 1).

## 0. Why

The W5a loop is real and rated 7/10, and its first word is the one it
cannot say: *your tracker*. Every verb — Investigate, Fix, Something
else…, `/investigate KEY`, `dispatch_session` — resolves a ticket through
the ledger's `tickets` table, and a Jira issue is never a row there. The
tech lead who owns a Jira board, the primary user (PM review §1.A),
opens ENG-4 in My Jira and finds no Sessions section, types `/investigate
ENG-4` and is told there is no such ticket. The pitch is two-thirds
earned; this slice earns the third.

Everything below follows the two W5a rules unchanged — Copilot is the PM,
the session is the engineer — and adds one that Jira makes sharp:

- **Nothing a session produces reaches Jira except as a proposal a
  person approves, through the one write path Copilot's Jira proposals
  already take.** The credential stays in main; the backend borrows it
  per request, as it does for an approve today; the agent never sees it
  (the W5a env scrub stands).

## 1. What the user sees

1. **Sessions on a Jira issue.** The My Jira drawer and the issue page
   (`/my-jira/ENG-4`) grow the same *Sessions* section a native ticket
   has: **Investigate**, **Fix**, **Something else…** above the issue's
   runs. It sits under the description and links, above Comments.
2. **The brief preview, with one more fact.** The brief is built from
   the issue as Jira has it now — summary, description, status,
   priority, labels, reporter/assignee, the newest 20 comments with
   their authors and times — plus Waypoint's instructions for the verb,
   exactly as for a native ticket. The facts row's *Folder* line is the
   difference: a Jira issue belongs to a Jira project, not to a Waypoint
   project with a linked repository, so the first time an `ENG-…` issue
   is dispatched the dialog asks **which folder ENG's code lives in** —
   the same list the New session dialog offers (recent folders, every
   project's linked repository, Browse…). The choice is remembered for
   `ENG`; the next `ENG-…` preview shows it as the folder with a
   *Change* link. Start is disabled until a git repository is chosen.
3. **The run.** A row named `ENG-4 · Investigate`, branch `agent/ENG-4`,
   the intent chip, the transcript, Stop, steering — everything W3/W4/W5a
   built. The session list groups it under `ENG-4 · <summary>`; the
   header's ticket link opens the issue in Jira.
4. **Finishing.** The closing message is filed as a **comment proposal
   on the Jira issue** — the card carries the external-write banner
   Copilot's Jira proposals carry (the site, which Atlassian account it
   posts as, who Jira notifies) and "from run ENG-4 · Investigate ↗". For
   a Fix, a second card proposes a **transition**: the one named for
   review when the issue offers it, else the one that moves the issue to
   *in progress*; when the issue offers neither, only the comment is
   filed and the run's event trail says so. The PR (W6) opens as before,
   titled `ENG-4: <summary>`, its body linking the issue.
5. **Review and approve.** Approve posts the comment through Jira with
   the session disclosure ("This is a Waypoint session — Amaan's agent —
   reporting on their behalf:"), rendered as ADF headings, lists and code
   rather than a wall of `##`; approving the transition applies it,
   re-checked live against the issue's current status (someone moved it
   in Jira meanwhile → stale, nothing applied). The run goes *Done* when
   its last proposal is decided; the Copilot note says so.
6. **Copilot.** `/investigate ENG-4`, `/fix ENG-4 …`, `/session ENG-4 …`
   and "look at ENG-4" (`dispatch_session`) resolve a Jira key the way
   the MCP tools do — both systems asked, an identifier that names both a
   Waypoint ticket and a Jira issue refused rather than guessed —
   and open the same preview. `get_run` answers for a Jira run, the
   issue's URL included.

## 2. Decisions

1. **A Jira issue's ledger handle is its `ticket_refs` row.** `tref-…`
   ids already name a Jira issue everywhere the backend writes to Jira
   (`proposals.ticket_id`, `providerOf`). A run on a Jira issue stores
   the same id in `agent_runs.ticket_id`. That column's foreign key to
   `tickets` is **dropped** (migration 0019) and replaced by a check on
   the id's shape (`wi-…` or `tref-…`) — the `proposals.ticket_id`
   precedent, for its reason: the prefix alone says which system owns
   the ticket, with nothing stored beside it able to disagree. The
   alternative — a second nullable `ticket_ref_id` column — was
   rejected: every reader of `run.ticketId` (brief, finalize, get_run,
   the ticket's Sessions section, the list's group-by, the labels)
   would branch on two columns instead of one prefix, and native runs
   would gain a null column for nothing. What the FK bought — `ON DELETE
   SET NULL` for a deleted native ticket — the service keeps at insert
   (`ticketId does not exist`) and the panel tolerates on read (a label
   that cannot be resolved falls back to the run's title and branch).
   `project_id` stays what W4b made it: the Waypoint project whose
   linked repository the run works in, when there is one; null
   otherwise. A dispatched run no longer implies a project.
2. **The repository mapping lives in main, keyed by Jira project.**
   `<userData>/engine/jira-project-repos.json` maps `site/KEY` (the
   connected site's hostname and the issue key's project part) to an
   absolute path, written the first time an issue of that project is
   dispatched with a folder chosen in the preview, replaced when the
   person picks *Change*, dropped on read when the path is gone — the
   recents file's rules. Paths stay in main; the renderer sees folder
   handles (W4b §2). The alternative, `projects.jira_project_key` — a
   Waypoint project *is* that Jira project's codebase — is the better
   long-term shape for a PM companion that mirrors trackers, and is
   deliberately not built here: it needs a settings surface, a backend
   column and a story for a Jira user with no Waypoint project at all,
   and the preview's folder step is what a person meets either way.
   Recorded as ROAD-129 (§7). The run's `project_id` still resolves
   through `describeFolder`: a folder that is some project's linked
   repository puts the run in that project's list.
3. **The brief is built from main's own Jira client, reads only.**
   `jiraClient.getTicket(key)` and `listComments(key)` — the mapper
   already flattens ADF and strips account ids; `briefs.ts` stays pure
   and gains a provider-neutral input (`BriefTicket`, `BriefComment`)
   that the native path fills from the ledger and the Jira path from the
   wire types. The scrub (credential shapes, secret-bearing URLs, raw
   mentions) runs on both. The brief says "a Jira issue" and names the
   issue's URL so the agent can cite it.
4. **A run's proposals on a Jira issue take Copilot's Jira path,
   exactly.** `createRunProposal` stops refusing `tref-` ids. Main's
   `POST /agent-runs/:id/proposals` carries the borrowed credential
   header when the run's ticket is external (the seam approve already
   uses); the backend resolves the issue live through `JiraProvider`,
   builds the same snapshot Copilot's `propose_comment` /
   `propose_state_change` build (`externalSite`, `externalUrl`,
   `externalActorName`, the notification sentence; for a transition the
   issue's live status id as `fromStateId` and the transition's own name
   as `toStateName`), validates a transition id against the issue's live
   transition list, and stores `project_id` null — a Jira issue belongs
   to no Waypoint project. Approve, staleness, execution: untouched.
5. **A run-filed Jira comment is disclosed as a session, and rendered.**
   The ADF builder takes the proposal's origin and uses
   `SESSION_DISCLOSURE` for `agent_run` — the same constant the HTML path
   uses, so the two renderings of one report say the same thing. A
   session's report is markdown (headings, lists, code); the builder
   grows a bounded markdown-lite → ADF pass (headings, bullet and
   ordered lists, fenced code, rules, paragraphs; `code` and `strong`
   inline marks) so the comment reads on the issue as it reads on the
   card. Every node it can emit is one it chose; no input becomes a node
   type it did not.
6. **Finalize's state change is a transition, picked by name.** For a
   Fix on a Jira issue main lists the issue's transitions through its
   own client and picks: the first whose target status is named for
   review (`/review/i`), else the first whose target category is
   *in-progress* — the W5a rule (`pickReviewState`: review, else the
   last started state) said in Jira's vocabulary. Found → a
   `state_change` proposal whose `stateId` is the TRANSITION id, as
   Copilot's are. Not found → only the comment, and a `note` event on
   the run naming the transitions the issue did offer. Never a guess.
7. **Key resolution is the MCP tool's, shared.** The backend's dual
   lookup (native and Jira concurrently, ambiguity refused) moves out of
   `getTicketByIdentifierHandler` into a service function both the tool
   and a new `GET /tickets/resolve/:identifier` use; the route takes the
   borrowed credential header. Main's ledger client calls it for the
   slash commands (`runs:resolve-ticket`, so the renderer never needs
   the credential) and for `dispatch_session`. A Jira hit is remembered
   as a `ticket_refs` row by the provider itself, which is what makes
   the `tref-` id exist before a run names it.
8. **The My Jira drawer mints the ref through main.** The drawer knows
   the issue's key and summary, not its `tref-` id. `runs:jira-ticket-ref`
   asks main, which posts `{provider: 'jira', site, key, title, url}` to
   `POST /ticket-refs` with the site taken from the stored credential —
   never from the renderer — and answers the handle. An upsert; a
   hundred drawer opens are one row.
9. **A ref from another site is refused.** A `tref-` row whose
   `external_site` is not the connected credential's site cannot be
   dispatched ("ENG-4 belongs to another Jira site"); the backend's
   provider applies the same guard on every read and write.
10. **Not built here:** `projects.jira_project_key` (ROAD-129); a
    priority or assignee change from a run (Copilot cannot propose those
    on Jira either); a session on a Jira issue outside "my work" from the
    My Jira page (the page shows the person's queue; the slash command
    and `dispatch_session` reach any key); the second Fix continuing the
    branch (ROAD-123).

## 3. Main

1. `engine/runs/briefs.ts` — `BriefInput.ticket` becomes a provider-
   neutral `BriefTicket` (`identifier, title, description, priority,
   stateName, kind: 'native' | 'jira', url?, labels?, assignee?,
   reporter?`); comments become `BriefComment[]` (`author, at, text`);
   `briefFromLedger(...)` and `briefFromJira(...)` adapters build the
   input. The opening line and the *Where you are* section say which
   system the ticket lives in.
2. `engine/runs/jiraRepos.ts` (new) — the mapping file: `read`, `lookup
   (site, projectKey)`, `remember(site, projectKey, path)`, pruned on
   read; `projectKeyOf('ENG-4') → 'ENG'`.
3. `engine/runs/dispatch.ts` — `ticketContext` branches on the id's
   prefix. Jira: the ref from the ledger (`getTicketRef`), the site
   check, the issue and comments from `deps.jira` (injected: `site()`,
   `getTicket`, `listComments`, `listTransitions`), the repository from
   the mapping or the request's `folder` handle (resolved through the
   registry; refused unless a git repository), else `repo: null` and the
   preview says a folder is needed. `dispatchTicketRun` on a Jira issue
   requires a resolved repository, remembers the mapping when the
   request carried a folder, creates the run with `ticketId: tref-…`,
   `projectId: repo.projectId` (nullable), title `ENG-4 · Investigate`,
   and hands `continueStart` the key as the branch's name.
4. `engine/runs/finalize.ts` — the ticket's label and URL from a helper
   that reads a native ticket or a ref (`runs/runTicket.ts`); the PR
   title and body take the URL. Proposals through
   `ledger.createRunProposal(runId, input, { external })`, which adds the
   credential header. The Fix state change branches: native as today;
   Jira through `deps.jira.listTransitions` and `pickReviewTransition`.
5. `engine/runs/ledgerClient.ts` — `getTicketRef(id)`,
   `rememberTicketRef(input)`, `resolveTicket(identifier)`; an optional
   `jiraCredentialHeader()` dep the wiring provides (engineIpc.ts,
   copilotRunner.ts) from `jiraAuth` — the client itself stays free of
   Electron.
6. `engine/runsIpc.ts` — `runs:resolve-ticket (identifier) →
   ResolvedTicket`, `runs:jira-ticket-ref ({key, title}) → {ticketId,
   identifier, title}`; `open_pull_request`'s title through the helper.
7. `copilot/sessionTools.ts` — `resolveTicket` through
   `ledger.resolveTicket`; `get_run` names the issue's URL for a Jira
   run.
8. `engine/engineIpc.ts` — wires `jira` (the client's reads and the
   stored site) into the dispatch and finalize deps.

## 4. Backend

- Migration 0019: `agent_runs` drops `agent_runs_ticket_id_tickets_id_fk`;
  check `agent_runs_ticket_id_shape` (`ticket_id IS NULL OR LIKE 'wi-%'
  OR LIKE 'tref-%'`).
- `createAgentRunSchema`: a `tref-` ticket does not require a project;
  `createRun` checks `ticket_refs` for a `tref-` id instead of `tickets`
  and skips the project match.
- `createRunProposal(input, jiraCredential)`: the Jira branch (§2.4);
  the route parses the credential header.
- `lib/jira/adf.ts`: `buildCopilotJiraCommentAdf(displayName, body,
  origin)` with the session disclosure and the markdown-lite pass;
  wider ADF node types.
- `lib/proposalSnapshot.ts` (new): `baseSnapshot`, `externalSnapshot`
  moved out of `mcp/proposalTools.ts` so the service and the tools share
  one shape.
- `services/ticketResolution.service.ts` (new): the dual lookup
  (§2.7); `mcp/ticketTools.ts` calls it. Routes: `GET
  /tickets/resolve/:identifier` (credential header; 409 on ambiguity),
  `GET /ticket-refs/:id`, `POST /ticket-refs`.
- `GET /tickets/:id/agent-runs`, `GET /tickets/:id/proposals`: already
  by string; unchanged.

## 5. Renderer

- `JiraTicketDetail`: the Sessions section (drawer and page) —
  `useJiraTicketRef(key, title)` → `TicketRunsSection ticketId={tref}`.
- `BriefPreviewDialog`: a `FolderPicker` (extracted from
  `NewSessionDialog`, the same list and Browse…) shown when the preview
  answers `repo: null`, and a *Change* link on a remembered mapping; the
  request re-fires with the chosen handle; Start disabled until a
  repository is chosen. The Folder line names the Jira project the
  folder is remembered for.
- `useTicketLabel` / `useTicketSummary`: a `tref-` id resolves through
  `GET /ticket-refs/:id` (identifier, cached title, URL); the summary
  carries `url` so `SessionDetail` links a Jira run to its issue.
- `CopilotPanel.handleSlash`: `resolveTicket(key)` through main instead
  of the native-only route; the ambiguity sentence shown as the slash
  error.
- `engineApi`: `resolveTicket`, `getJiraTicketRef`; `api`:
  `getTicketRef`.

## 6. Tests

- Main: `briefs.test.ts` (the Jira brief: URL, status, labels, comment
  authors; the scrub on a Jira comment), `jiraRepos.test.ts` (lookup,
  remember, prune), `dispatch.test.ts` (Jira: no mapping → `repo: null`;
  a folder handle → remembered; wrong site refused; a plain folder
  refused; `projectId` from the folder; the branch from the key),
  `finalize.test.ts` (Jira Fix: the transition by name → a state_change
  with the transition id, sent with the credential; none → comment only
  and the note event; the PR title/body with the URL),
  `ledgerClient.test.ts` (the header on run proposals for external
  tickets only; `resolveTicket`; refs), `sessionTools.test.ts` (a Jira
  key resolves to a `tref-` offer; ambiguity surfaces),
  `runsIpc.test.ts` (`runs:jira-ticket-ref` takes the site from main,
  refuses a bad key).
- Backend: `agentRuns.routes.test.ts` (a `tref-` run without a project),
  `proposals.service.test.ts` (`createRunProposal` on a Jira ref: the
  snapshot, the transition validation, no credential → validation
  error), `adf.test.ts` (the session disclosure; markdown-lite → ADF),
  `ticketResolution.service.test.ts`, the ref routes.
- Renderer: `BriefPreviewDialog.test.tsx` (the folder step; Change;
  Start gated), `JiraTicketDetail.test.tsx` (the Sessions section),
  `useTicketLabel` for refs, `CopilotPanel` slash resolution.
- `docs/qa/manual-test-cases.md` — `## Jira sessions (W5b, ROAD-126)`,
  JIRA-SESS-1…: written for the founder's manual round; the Jira
  writes (approve a comment, approve a transition) are theirs to run.
  Nothing in this slice's build or tests writes to a Jira site.

## 7. Tickets

- ROAD-126 · W5b (this slice) — parent.
- ROAD-127 · Backend: the ledger takes `tref-` runs; run proposals on a
  Jira issue; the resolve and ref routes; the session ADF.
- ROAD-128 · Main + renderer: the Jira brief, the folder mapping, the
  transition at finalize, the Sessions section on My Jira, the labels.
- ROAD-129 · Later: `projects.jira_project_key` — a Waypoint project as
  a Jira project's codebase, set in Codebase settings.
- ROAD-130 · Later: the transition picker in the Fix preview (choose the
  transition before Start rather than main's name rule).

## 8. What decides whether this was right

The W5a metrics (§7 there), split by ticket system: dispatched runs per
active day on Jira issues vs native tickets; the approval rate of
run-filed Jira comments and how often the transition card is rejected
(the name rule picked wrong); how many Jira projects reach a remembered
folder on the first dispatch (the mapping is set once and stays).

## 9. What the build changed — 2026-09-13

Recorded after the build, before the founder's manual round
(docs/qa/manual-test-cases.md JIRA-SESS-1…14, not yet run), where the
plan above and the code differ.

1. **The brief's input widened rather than replaced** (§3.1).
   `BriefInput.ticket` is a union of the ledger's ticket and the four
   fields the brief reads; `comments` a union of the ledger's row and an
   already-named flat comment; `jira?: JiraBriefFacts` carries the URL,
   labels, assignee and reporter. `jiraBriefTicket` / `jiraBriefComments`
   adapt the wire types. Every W5a brief test runs unchanged.
2. **A preview with no folder still has a brief.** For a Jira issue whose
   project has no remembered folder the brief is built with
   `(the folder you choose in the preview)` where the repository goes,
   so the person reads it while choosing; a pick re-fires the preview
   and the brief is rebuilt on the real folder. The dialog's picker
   offers git repositories only — a session on a ticket always takes a
   worktree — and Start stays disabled until one is chosen.
3. **`runs/jiraRuns.ts`** holds what the plan put in dispatch: the
   injected `JiraRunDeps` (main's reads and the stored site),
   `describeRunTicket` (a native ticket or a ref, as a label and a link)
   and `pickReviewTransition`. finalize, runsIpc and dispatch import it;
   engineIpc wires `jira/jiraClient.ts` and `jira/borrowedCredential.ts`
   (the two readers — the encoded header and the site — so no run module
   imports Electron).
4. **The transition's event names the transition.** `proposal_created`
   for a Jira state change carries `transitionId` and `stateName`; the
   no-transition case is a `note` event with `offered: [...]`, and so are
   an unreadable list and a disconnected Jira — three sentences, one
   shape.
5. **`GET /tickets/resolve/:identifier` answers 409** for an ambiguous
   key and for Jira unreachable with no native hit, 404 for missing, 400
   for an explicit `provider=jira` with no credential. Main's ledger
   client turns 404 into null and lets the 409 sentence through; the
   renderer shows it under the composer.
6. **The drawer mints on open.** `JiraSessionsSection` asks main for the
   handle when the drawer (or page) mounts — an upsert, one row however
   many opens — and renders the W5a section only once it has it; a
   handle that cannot be minted leaves the section out, with no verbs
   that would fail.
7. **The mapping file's default location** is beside the recents file
   (`<userData>/engine/jira-project-repos.json`); tests hand in their
   own.
8. **`agent_runs.project_id` for a Jira run** is the folder's project
   through `describeFolder` — the Roadmap project when its linked
   repository is chosen, null for any other repository — exactly W4b's
   rule for an independent run, so a Jira run lists under the project
   whose code it touched.
9. **The backend is not prettier-formatted** (no config in
   `waypoint-backend/`, and no existing file passes any obvious one);
   the frontend's touched files are, with the package's config.
10. **A read-only smoke, and what it found.** After the build, on the
    running app against the test site (reads only; nothing started, no
    Jira write): `runs:jira-ticket-ref` minted `tref-…` for ENG-84 once
    across three calls; `runs:resolve-ticket` answered the same handle
    for `eng-84`, the native ticket for `ROAD-116`, null for an unknown
    key; `/investigate ENG-84` from Copilot opened the preview — the
    Issue link, "Not set yet", the picker with git repositories only,
    Start disabled, the brief from the live issue and its four comments
    — and picking the Roadmap repository rebuilt it on `main` with
    "will be remembered for ENG" and Start enabled; Cancel left no
    mapping file and no run (`.qa-screenshots/w5b-smoke/`). Found and
    fixed on the pass: `registerRunsIpc` built its own ledger client
    without the credential reader, so a Jira key resolved to null until
    the finalize client was handed in. The two Jira writes (JIRA-SESS-7,
    JIRA-SESS-10) and the full walk-through are the founder's manual
    round; the My Jira page itself was not reachable in this dev run
    (started without `WAYPOINT_FEATURE_MY_JIRA`), so the drawer's
    Sessions section is covered by its unit test, not the smoke.
