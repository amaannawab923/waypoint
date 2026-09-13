# W4b · Sessions anywhere — a folder per independent session

Status: build plan, written before the code. Branch:
`feat/road-116-w4b-sessions-anywhere`, stacked on W4 (PR #57). Ticket:
ROAD-116 (under ROAD-66).

## 0. Why

The founder compared W4 with emdash running side by side (2026-09-12,
`.qa-screenshots/emdash-ux/`) and drew the line: emdash's chat panel is
worth having — we already run it — and three of its ideas are worth
taking (the first prompt typed in the create dialog; a provider on the
card; an auto-approve switch). Its task architecture is not: every task
is a worktree of a project's repository, and that does not scale to a PM
tool where a session is often "Claude Code desktop, but inside Waypoint"
— a folder, a question, an agent. Two kinds of session follow:

- **Ticket sessions** (W5, Copilot dispatch): always a fresh worktree of
  the project's repository, no folder choice. Exactly what W2/W4 build.
- **Independent sessions** (this slice): pick a folder. Work in a fresh
  worktree of it when it is a git repository, or directly in it.

Decisions taken with the founder:
- Auto-approve is allowed in a folder session, default **off** there and
  **on** in a worktree, remembered per folder, and visible on the row.
- An independent session on a linked project repository defaults to a
  fresh worktree; "work directly in this folder" is the explicit
  alternative, and the only option for a folder that is not a repository.
- "Change directory" is not a mutation of a live session (an ACP session
  is bound to its cwd); it is starting another session, made cheap by a
  recent-folders list.
- emdash's "Use chat UI" switch is not taken: it selects a terminal
  runtime we do not have.

## 1. What the user sees

1. **New session dialog**, reshaped. In order:
   - **Folder** — a list to pick from: recent folders (most recent first,
     with the project's name when the folder is a linked repository), the
     linked repositories of every project, and **Browse…** (the OS folder
     picker). Each entry shows the path shortened with `~`, and a chip:
     *git repo* / *folder*. A folder with a live session already in it
     shows "a session is running here" — a warning, not a refusal.
   - **Provider** — as W4 (workspace default preselected, per-session
     override, not-installed refused).
   - **First message** — a textarea; optional. When present, it is queued
     as the session's first prompt (`initialQueue`) and its first line
     (≤ 120 chars) becomes the run's title. Empty is allowed: the run is
     named by its folder or branch and the composer waits.
   - **Auto-approve** — a switch with the sentence under it changing with
     the isolation: in a worktree, "The agent works in its own copy; edits
     and commands run without asking." In a folder, "The agent edits this
     folder directly; with this off you are asked before each write."
     Default on for a worktree, off for direct; the last choice is
     remembered **per folder**.
   - **Advanced** (folded): *Work in* — *a fresh worktree* / *this folder
     directly*; *Base branch* (worktree only; the W4 field, with the same
     suggestion rule). For a plain folder the fold is absent: there is
     nothing to choose.
   - **Start session** (⌘⏎).
2. **The row and the header.** A worktree run reads as W4
   (`session/abc from main`). A direct run reads "in ~/code/compass-web"
   — the folder, shortened. A run started with auto-approve carries a
   small "auto" mark on the row and beside the status pill, so an agent
   working unattended in someone's files is never invisible in the list.
   The title is the first line of the first message when there was one.
3. **Diff.** For a worktree run: unchanged. For a direct run in a git
   repository: the working tree against `HEAD` (no base branch), labelled
   *Changes* rather than *Diff*, refreshed as now. For a direct run in a
   plain folder: no tab.
4. **Header actions.** *Show in Finder* opens the folder for both kinds.
   Stop / Resume as W4. No "worktree" wording on a direct run.
5. **Settings → Agents.** Beside *Default provider*: nothing new — the
   auto-approve default is per isolation and per folder, not a workspace
   setting (emdash's `autoApproveByDefault` would make a folder session
   dangerous by default on one setting; the founder's rule is the
   isolation decides).

## 2. Decisions

- **The renderer still never names a path.** Folders are **handles**:
  `runs:choose-folder` opens the OS picker in main and answers
  `{handle, displayPath, kind: 'repo' | 'folder', projectId | null}`;
  `runs:recent-folders` answers the same shape for main's own recents
  and for every project's linked repository. `runs:start` takes
  `folder: handle`. Handles are random ids valid for the process
  lifetime, minted only from those two sources. A renderer that shows
  agent-written markdown is a renderer that must not be able to point an
  agent with auto-approve at `~` — the same reasoning W3's review gave
  the diff and reveal channels.
- **Recents live in main** (`<userData>/engine/recent-folders.json`,
  ≤ 20 entries: path, last used, last auto-approve choice). Written when a
  session starts; a path that no longer exists is dropped on read.
- **Auto-approve is a provider mode, not an answering loop.** Verified
  live on the pinned daemon: the Claude adapter's session config offers
  modes `default / acceptEdits / plan / dontAsk / bypassPermissions`, and
  `acp.start` takes `modeId`. Auto-approve = `modeId: 'bypassPermissions'`
  at start and on every resume. Nothing in main answers permissions; a
  session started this way asks none. (emdash's own toggle is the
  terminal path's `--dangerously-skip-permissions`; for ACP it uses the
  same mode picker — we take the ACP half.)
- **The ledger learns three facts.** `agent_runs.isolation`
  (`worktree | directory`, default `worktree`), `agent_runs.cwd` (the
  directory the agent runs in — for a worktree run the same as
  `worktree_path`, for a direct run the folder; nullable until
  provisioning), `agent_runs.auto_approve` (boolean, default false).
  `project_id` becomes nullable: a folder that is not a linked repository
  belongs to no project. `title` is the first prompt's first line when
  the dialog had one.
- **A worktree of a non-linked repository** is provisioned exactly like a
  linked one (`provisionWorktree` with `repoPath` = the folder); the
  daemon's registry adopts the repository under its hash id. Reconcile,
  the follower, Stop, Resume, drafts, queueing: unchanged. Resume of a
  direct run: `fs.stat(cwd)`, then `acp.start` with the stored handle and
  the run's mode.
- **Direct runs and `git`.** `runs:diff` on a direct run runs the same
  hardened git (`GIT_SAFE_CONFIG`, minimal env) in the folder, compares
  against `HEAD`, and requires a git repository (`.git` directory or
  file); the worktree provenance check (`assertWorktreeGitDir`) applies
  to worktree runs only — a direct run *is* the person's repository, and
  the agent already runs there. Untracked files are listed and patched
  under the same caps. `runs:reveal-worktree` becomes `runs:reveal` and
  opens `cwd`.
- **Two live sessions in one folder** are allowed and warned about in the
  dialog (the ledger knows: live runs with the same `cwd`). The daemon
  shares one agent process per provider+cwd; that is its business.
- **Cancel mid-start** is W4's rule; a direct run has no worktree step,
  so the window is only `acp.start`.

## 3. Main

- `engine/runs/folders.ts` (new): the handle registry (`mint(path,
  source)`, `resolve(handle)`), the recents file, `describeFolder(path)`
  → `{kind, displayPath, projectId}` (kind by `.git` presence; projectId
  by matching `ledger.listProjects()` linked paths after `realpath`).
- `runs:choose-folder` → `dialog.showOpenDialog({openDirectory})` parented
  to the window, then `describeFolder`; cancel answers `{canceled: true}`.
- `runs:recent-folders` → recents ∪ linked repositories, described.
- `runs:start` input becomes `{folder, providerId, isolation,
  autoApprove, baseRef?, firstMessage?}`; `ownerMemberId` as W4. Main:
  resolve the handle; refuse `worktree` isolation on a plain folder (a
  direct run is allowed anywhere);
  `projectId` from `describeFolder`; title from the first line of
  `firstMessage`; ledger `createRun({…, isolation, cwd: null,
  autoApprove})`; then as W4 with `cwd` written at provisioning (worktree
  path, or the folder) and `acp.start {…, modeId: autoApprove ?
  'bypassPermissions' : null, initialQueue: firstMessage ? [{text}] :
  undefined}`.
- `ledgerClient.listProjects()` (`GET /projects`, id/name/repoPath) for
  the folder ↔ project match.
- `runs:diff` / `runs:reveal`: branch on `run.isolation`.
- `runs:resume`: the run's `cwd`, the run's mode.

## 4. Backend

- Migration 0015: `ALTER TABLE agent_runs ALTER COLUMN project_id DROP NOT
  NULL; ADD COLUMN isolation text NOT NULL DEFAULT 'worktree'; ADD COLUMN
  cwd text; ADD COLUMN auto_approve boolean NOT NULL DEFAULT false`.
- `createAgentRunSchema`: `projectId` nullable (a dispatched run still
  needs one — refine), `isolation` enum, `autoApprove` boolean;
  `updateAgentRunSchema.cwd`.
- `GET /projects` is already there.

## 5. Renderer

- `NewSessionDialog` reshaped per §1.1 (`FolderPicker` list, the
  first-message textarea, the auto-approve switch with the isolation
  sentence, the Advanced fold). `engineApi`: `chooseFolder`,
  `listRecentFolders`; `startRun` input updated.
- `sessionStatus.runTitle`: ticket → title → branch → folder basename →
  id. `runWhere(run)`: "session/x from main" | "in ~/x".
- `SessionRow`, `SessionDetail`: the where-line, the "auto" mark, *Show
  in Finder*, the *Changes* tab name for direct runs, no tab for a plain
  folder.
- `DiffPane`: reads `run.isolation` for the label; the data is main's.

## 6. Tests

- `folders.test.ts`: handles are unforgeable (an unknown handle refuses),
  recents bounded and pruned, describeFolder's three kinds, project match
  by realpath.
- `startRun.test.ts`: direct run skips provisioning and writes `cwd`;
  worktree on a plain folder refused; auto-approve → `modeId`; first
  message → `initialQueue` + title; resume keeps the mode.
- `runsIpc.test.ts`: `runs:diff` on a direct run compares to HEAD without
  the worktree provenance check, refuses a plain folder; `runs:reveal`.
- Backend: schema round-trips, nullable project on create for independent
  runs only.
- Renderer: dialog (folder list, Browse, defaults per kind, the sentence
  under auto-approve, warning for a busy folder, title derivation),
  row/header where-line and auto mark, Changes label.
- `docs/qa/manual-test-cases.md`: SESS-26…31 live — a direct session in
  a plain folder (no Changes tab, auto-approve off, asked before a
  write), a direct session in this repo with auto-approve (no prompt,
  Changes shows the working tree), a worktree session from a non-linked
  repo, recents and the per-folder auto-approve memory, the busy-folder
  warning, first message → title and first turn.

## 7. Out of scope

Model and effort pickers in the composer (the config topic has them; a
later slice); a mode picker on a running session; multi-select folders;
cleanup of direct runs (nothing to clean).
