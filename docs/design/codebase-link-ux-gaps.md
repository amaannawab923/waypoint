# Codebase grounding: repo-linking configuration UX

PM review of what shipped in PR #25 (`repoPath` on projects, settings picker, in-chat card).
Read from the merged code in `waypoint-electron-v3`, not from the design docs' intent.

**Scope guardrail:** repo-per-project, single repo, no path override, the exact
validation rules, and unconfined `Read`/`Glob`/`Grep` are founder-approved calls and are
not re-litigated here. Everything below is about configuration ergonomics — how a user
picks the folder, how confident they are afterwards, and how they recover when it breaks.
Nothing proposed needs a new backend capability: it all rides the existing
`PATCH /projects/:id` + `repo:choose-folder` IPC, or is presentation-only.

---

## Phase 1 — what actually happens today

### 1. How a user picks the directory

**Settings path (deliberate entry point):**
`/projects/:id/settings` → left nav, top group, 4th item "Codebase" (`ProjectSettingsLayout.tsx:21`)
→ a page with one heading, one paragraph, and one `Choose folder…` primary button
(`Codebase.tsx:99-104`) → native OS folder dialog → path saved immediately on pick.

**In-chat path (reactive entry point):**
User must (a) be on a `/projects/:projectId/...` route, (b) ask Copilot something the model
itself judges needs source code, (c) get back a reply carrying the `[[NEEDS_REPO]]` sentinel.
Only then does `CopilotRepoLinkCard` render inline under that reply, with the same
`Choose folder…` button (`CopilotPanel.tsx:107-166`, gated at `:549` and `:809-816`).

**Guidance offered at pick time: none.** `repoLink.ts:27-28` calls
`dialog.showOpenDialog(win, { properties: ['openDirectory'] })` — no `defaultPath`, no `title`,
no `message`, no `buttonLabel`. It is a cold, generic OS Open panel that opens wherever the OS
last left it, with nothing on screen saying which project it is for or what a valid answer
looks like. There is no suggestion list, no recent-folders memory, no name-matching hint,
no auto-detection of any kind anywhere in the shipped code.

Notably, this is true **even for "Change folder…"** on an already-linked project: the same
zero-argument dialog is reopened (`Codebase.tsx:88` → same `handleChoose`), so it does not
even start at the folder currently linked.

### 2. What a user sees once it's linked

A bordered box labelled "Repository path" containing the raw absolute path in mono type, plus
`Change folder…` and `Unlink` (`Codebase.tsx:76-97`). That is the entire confirmation surface.

No repo name. No current branch. No remote. No last-commit date. No file count. No "this looks
like the project you meant" signal of any kind. And **no success feedback at the moment of
linking** — the primary button is simply replaced by the box; there is no toast, no transient
"Linked" state, no animation. On a long path the only visible difference between linking the
right checkout and a superficially similar wrong one (`~/code/waypoint` vs
`~/code/waypoint-old`) is a string the user has to read character by character.

The in-chat card is worse: after a successful link it calls `onLinked()` and then **the card
unmounts entirely** (gate at `:814` flips false). The user's confirmation that the thing they
just did worked is that the card vanished. They are not told what got linked, and they are not
told to re-ask their question — the reply that triggered the card is still the unhelpful,
ungrounded one sitting above it.

### 3. Validation failure

Backend `validateRepoPath` (`projects.service.ts:152-167`) throws three messages:

- `repoPath does not exist: /Users/x/y`
- `repoPath is not a directory: /Users/x/y`
- `repoPath is not a git repository: /Users/x/y`

Each is rendered verbatim to the user, in both entry points (`Codebase.tsx:36`,
`CopilotPanel.tsx:130`). Three problems, all observable:

- **It's developer language, not product language.** `repoPath` is an internal field name.
  No user picked something called a "repoPath"; they picked a folder.
- **It says what's wrong, never what to do.** "is not a git repository" does not say
  *pick the folder that contains `.git`* or *you may have picked the parent/child of the
  right one* — which is the actual mistake nearly every time.
- **The error fires twice.** `httpClient.ts:43-44` calls `showErrorToast(message)` on every
  non-OK response *and* re-throws, and both callers then render the same string inline in red.
  So one bad pick produces a global toast and an inline error carrying identical raw text.

The round trip is also fully remote by design (`repoLink.ts:10-16` deliberately validates
nothing locally), so the user waits on the network to be told the folder they just picked has
no `.git` — a fact the main process could see instantly.

### 4. Discoverability

Weak, and asymmetric.

- The only proactive surface is a nav item labelled "Codebase" buried in project settings,
  with no badge, no empty-state prompt, and nothing pointing at it from anywhere else.
- `grep repoPath` across the whole renderer returns **only** `Codebase.tsx`, `CopilotPanel.tsx`,
  `useCurrentRouteProject.ts`, and the entity type. There is **no repo indicator anywhere in
  the ticket, work-item, board, or project header views.** A user cannot tell, before asking
  Copilot anything, whether the project they're looking at is grounded or not.
- The reactive surface has a hard precondition most users won't know about: the card requires
  `groundingProject` (`CopilotPanel.tsx:549`), i.e. an open `/projects/:projectId/...` route.
  Ask Copilot a code question from the inbox, a global search, or "My Issues" and there is no
  project in scope — so **no card ever appears**, and Copilot simply answers without code,
  ungrounded, with nothing signalling why.
- Consequence: the realistic path to discovery is "Copilot gave a vague answer while I happened
  to be on a project page, and the model happened to admit it needed code." That is a lot of
  conditions between a user and a core feature.

### 5. Unlink / relink / change

Mechanically easy, psychologically unmarked, and asymmetric with how it was set up.

- `Unlink` is a single `ghost`-variant click with **no confirmation**, no undo, no "you're about
  to turn off Copilot's code access for this project" framing (`Codebase.tsx:93-95`).
  Unlink also deliberately skips all validation server-side (`projects.service.ts:170-173`), so
  it always succeeds instantly.
- `Change folder…` reopens the same context-free dialog, not anchored at the current path
  (§1), so "adjust which folder" costs the same navigation as picking from scratch.
- Neither action gives any confirmation that it happened, beyond the box appearing/disappearing.

So it isn't a one-way commitment — but nothing tells the user that, and the destructive
direction is the *cheaper* click of the two.

### 6. Consistency between the two entry points

They share one persistence path (`updateProject(id, { repoPath })`) and one IPC channel, which
is correct. But as *experiences* they are visibly two different features:

| | Settings page | In-chat card |
|---|---|---|
| Framing | "Linked repository" (a setting) | "Codebase not linked" (a problem) |
| Explains read-only scope | Yes | Yes, differently worded |
| Shows the linked result | Yes, persistent box | No — card disappears |
| Unlink / change available | Yes | No |
| Shows *which* project it writes to | Implicit (you're in its settings) | **Never named on the card** |
| Error text | Raw backend string, inline | Raw backend string, inline |

The last row of that table is the sharpest one. The card writes to a `projectId` captured at
send time (`CopilotPanel.tsx:330-334`) — correct behaviour — but **the card never displays the
project name**. A user in a global, cross-project conversation is asked to link "this project's
code" without being told which project that is.

There is also no navigational link between the two: the card cannot send you to the settings
page, and the settings page has no awareness that Copilot ever asked.

---

## Phase 2 — gaps and proposed fixes

Ordered by impact on a first-time link. Every item is presentation or main-process only.

### G1. The folder dialog is context-free and starts nowhere useful
**Found:** `repoLink.ts:21-33` passes only `properties: ['openDirectory']`.
**Fix:** widen the existing IPC to accept optional `defaultPath`, `title`, and `message`, and
pass them from both callers. Settings: `title: "Link <Project> to its local checkout"`,
`defaultPath: currentRepoPath ?? lastLinkedFolderOnThisMachine`. Card: same, with the project
name. One-line dialog-options change; no new channel, no new backend surface.

### G2. No smart suggestions — every link is a cold browse
**Found:** no suggestion, recent-folder, or matching logic exists anywhere.
**Fix:** a small suggestions strip above the button, rendered from two cheap sources that need
no new backend capability:
- **Recently linked folders** — the paths already stored on other projects' `repoPath`
  (the projects list is already fetched by the app), shown as "Linked to other projects", so
  a user with five projects in `~/code` gets one-click adjacency after the first link.
- **A name-match hint** — for a project named "Waypoint", offer the sibling directories of
  already-known repo roots whose basename fuzzy-matches the project name/identifier.
Each suggestion is a one-click link that goes through the same `updateProject` call; the OS
dialog stays as `Browse…`, the escape hatch rather than the only door.
*(If even reading sibling directories is considered new capability, ship the recents strip
alone — it needs nothing but data the renderer already has.)*

### G3. Post-link confirmation is a bare path string
**Found:** `Codebase.tsx:76-84` renders only `project.repoPath`.
**Fix:** a confirmation card showing repo **name** (folder basename, free), the path with the
home dir collapsed to `~`, and — where cheaply obtainable in the main process, which already
has fs access — **current branch and last-commit date**. Plus a one-time success state
("Linked — Copilot can now read this code") rather than a silent swap. This is the single
highest-confidence-per-pixel change on the list: it converts "I typed a path somewhere" into
"I can see it's the right repo."

### G4. Validation errors are raw internal strings, doubled, and slow
**Found:** `projects.service.ts:157-165` messages rendered verbatim; `httpClient.ts:43-44`
also toasts them.
**Fix:** three things.
1. Map the three backend cases to human, actionable copy at the UI edge — e.g.
   *"That folder isn't a git repository. Pick the folder that contains the `.git` directory —
   usually the top level of your checkout."* Keep the raw string available under a
   "Details" disclosure; do not delete the source of truth, just stop leading with it.
2. Suppress the global toast for this one call and keep the error inline where the user's
   attention already is. One bad pick should produce one error, next to the button.
3. Add a *pre-flight* `.git` existence check in `repoLink.ts` purely as fast feedback — the
   backend stays the single source of truth and still validates, but the user hears about the
   obvious mistake in milliseconds instead of after a round trip.

### G5. No "linked / not linked" signal anywhere a user actually looks
**Found:** `repoPath` appears in no view outside settings and the Copilot panel.
**Fix:** one small, quiet badge in the project header (and mirrored as a dot on the settings
nav's "Codebase" item): a `FolderGit2` icon + repo basename when linked, hovering to reveal
the full path and a "Change" link; a muted "Code not linked" affordance when not, linking
straight to the Codebase page. This is the proactive discovery surface the feature currently
lacks entirely, and it also answers "is this answer grounded?" before the user asks anything.

### G6. Stale link fails completely silently
**Found:** if the checkout is moved or deleted after linking, `resolveRepoRoot` degrades to
`os.tmpdir()` and the run proceeds unlinked — but the in-chat card is gated on
`!routeProject.project.repoPath` (`CopilotPanel.tsx:814`), and `repoPath` is still non-null.
So the card is suppressed, the settings page still displays the dead path as if healthy, and
**the user gets ungrounded answers with no signal from any surface.**
**Fix:** surface the state the system already computes. Have the settings card and the header
badge show a warning state when the stored path no longer resolves ("Folder not found —
Copilot is answering without code"), with `Relocate…` (dialog pre-opened at the old parent) and
`Unlink` as the two actions. Loosen the card's gate from "no path" to "no *usable* path" so the
in-chat prompt reappears for a broken link rather than staying hidden.

### G7. The two entry points read as two features
**Found:** the table in §6 — different framing, different result state, no project name on the
card, no navigation between them.
**Fix:** make the card a compact version of the same component, not a lookalike:
- name the project on the card ("Link **Waypoint**'s local checkout");
- carry the same suggestions strip (G2) so one click resolves it without an OS dialog at all;
- on success, replace the card in place with the same green confirmation row as settings
  (G3) plus **"Ask again with code access"** — the missing step that today leaves the user
  staring at a stale, ungrounded reply;
- add a quiet "Manage in project settings" link so the card teaches where the durable control
  lives.

### G8. Unlink is the cheapest click on the page
**Found:** `Codebase.tsx:93` — one ghost click, no confirmation, always succeeds.
**Fix:** keep it one click but make it legible: confirm inline ("Unlink? Copilot will stop
reading this project's code.") and offer a 5-second undo, since the previous path is trivially
re-settable through the same call. Move it visually to a lower-weight position than
`Change folder…`, which is the action a user reaching for it usually actually wants.

---

## The right path — the flow a first repo link should feel like

1. **The user learns it exists before they need it.** The project header carries a quiet
   "Code not linked" affordance. It is not a nag; it is a fact about the project, in the same
   register as its lead or its icon, and it is one click from the fix.
2. **The picker leads with a guess, not a blank dialog.** The Codebase page shows two or three
   candidate folders — other projects' repo roots and their name-matching siblings — each
   linkable in one click. `Browse…` opens the OS dialog *titled with the project name* and
   *starting at a sensible parent*. A user with an existing project links their second repo
   without ever seeing a file dialog.
3. **A wrong pick fails fast and says what to do.** The `.git` check happens locally and
   instantly; the message names the mistake in the user's language ("pick the folder containing
   `.git`"), inline, once, with the raw detail available but not leading.
4. **Success is visibly a repo, not a string.** The confirmation shows the repo name, the
   branch, when it last changed, and the tilde-collapsed path — enough to recognise at a glance
   that it's the right checkout — with an explicit "Copilot can now read this code, read-only."
5. **In chat it is the same moment, compressed.** The card names the project, offers the same
   one-click suggestions, and on success turns into the same confirmation plus
   **"Ask again with code access"** — closing the loop on the question that triggered it,
   which today is left dangling.
6. **The state stays honest afterwards.** The header badge shows the linked repo on hover;
   if the folder moves, both the badge and the settings card say so and offer Relocate,
   instead of the current silent downgrade to ungrounded answers.
7. **Changing your mind is cheap and marked.** `Change folder…` reopens at the current repo;
   `Unlink` is one confirm plus an undo window.

Net: the feature stays exactly what was approved — one repo, per project, resolved from the
open route, validated by the backend. What changes is that the user is guided into the right
folder, shown that it *is* the right folder, told plainly when it isn't, and reminded that it
exists before Copilot has already answered badly.
